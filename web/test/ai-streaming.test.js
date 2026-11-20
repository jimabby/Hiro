// Ask Hiro's replies stream as they are written and can be stopped. Each of the
// three real adapters (Claude; OpenAI, which also serves DeepSeek, OpenRouter
// and local servers; Gemini) is driven against a fake SDK. A stopped request is
// never retried and never handed to the backup provider.

const fs = require('fs')
const os = require('os')
const path = require('path')
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-ai-stream-'))
const { stub, service, createChecker } = require('./helpers')

const { check, done } = createChecker()
const seen = { claude: [], openai: [], gemini: [] }
const FRAGMENTS = ['Dear ', 'Sam,', ' thanks.']

class FakeAnthropic {
  constructor() {
    const api = {
      create: async (body, opts) => { seen.claude.push({ kind: 'create', body, opts }); return { content: [{ type: 'text', text: 'whole' }], usage: {}, stop_reason: 'end_turn' } },
      stream: (body, opts) => {
        seen.claude.push({ kind: 'stream', body, opts })
        const handlers = []
        return {
          on: (event, cb) => { if (event === 'text') handlers.push(cb) },
          finalMessage: async () => {
            for (const f of FRAGMENTS) handlers.forEach(h => h(f))
            return { content: [{ type: 'text', text: FRAGMENTS.join('') }], usage: { input_tokens: 5, output_tokens: 3 }, model: body.model, stop_reason: 'end_turn' }
          },
        }
      },
    }
    this.messages = api
    this.beta = { messages: api }
  }
}

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async (body, opts) => {
          seen.openai.push({ body, opts })
          if (!body.stream) return { choices: [{ message: { content: 'whole' } }], usage: {} }
          return (async function * () {
            for (const f of FRAGMENTS) yield { choices: [{ delta: { content: f } }] }
            yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }
          })()
        },
      },
    }
  }
}

class FakeGemini {
  getGenerativeModel() {
    return {
      generateContent: async (req, opts) => { seen.gemini.push({ kind: 'create', opts }); return { response: { text: () => 'whole', usageMetadata: {} } } },
      generateContentStream: async (req, opts) => {
        seen.gemini.push({ kind: 'stream', opts })
        return {
          stream: (async function * () { for (const f of FRAGMENTS) yield { text: () => f } })(),
          response: Promise.resolve({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }),
        }
      },
    }
  }
}

stub({
  '@anthropic-ai/sdk': FakeAnthropic,
  openai: FakeOpenAI,
  '@google/generative-ai': { GoogleGenerativeAI: FakeGemini },
})

const usage = service('ai/usage')
usage._setConfigReader(() => ({ aiMaxRetries: 3 }))
const claude = service('ai/claude')
const openai = service('ai/openai')
const gemini = service('ai/gemini')
const ai = service('ai/index')

async function main() {
  const input = (extra = {}) => ({ operation: 'askHiro', system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, ...extra })

  // ─── Each adapter streams ──────────────────────────────────────
  for (const [name, adapter, flavour] of [['claude', claude], ['openai', openai, undefined], ['gemini', gemini, 'gemini-x']]) {
    const texts = []
    const signal = new AbortController().signal
    const reply = await adapter.chat(input({ onText: t => texts.push(t), signal }), 'key', flavour)
    check(`${name}: the reply is the whole text`, reply, 'Dear Sam, thanks.')
    check(`${name}: each update carries the whole text so far`, texts, ['Dear ', 'Dear Sam,', 'Dear Sam, thanks.'])
    const last = seen[name].at(-1)
    check(`${name}: the stop signal reaches the SDK`, last.opts?.signal === signal, true)
    check(`${name}: without onText nothing streams`, await adapter.chat(input(), 'key', flavour), 'whole')
  }
  check('openai: usage is asked for in the stream', seen.openai.find(c => c.body.stream).body.stream_options, { include_usage: true })

  // ─── Stop is not a failure ─────────────────────────────────────
  const aborted = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
  check('an SDK abort is recognised', usage.isAbort(aborted), true)
  check('a DOM abort is recognised', usage.isAbort(Object.assign(new Error('x'), { name: 'AbortError' })), true)
  check('a timeout is not an abort', usage.isAbort(new Error('timed out')), false)
  check('an abort is never retried', usage.isRetryable(aborted), false)
  check('an abort never sends the request to the backup provider', ai._failureKind(aborted), 'none')

  let attempts = 0
  try { await usage.withUsage('askHiro', 'claude', async () => { attempts++; throw aborted }) } catch { /* expected */ }
  check('withUsage gives up on the first abort', attempts, 1)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
