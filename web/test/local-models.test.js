// The recommended local models and the Ollama download behind Settings'
// "Download" button (services/ai/localModels.js), against a fake Ollama.

const fs = require('fs')
const os = require('os')
const path = require('path')
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-local-models-'))
process.on('exit', () => { try { fs.rmSync(process.env.HIRO_CONFIG_DIR, { recursive: true, force: true }) } catch {} })

const { service, createChecker } = require('./helpers')
const { check, done } = createChecker()
const localModels = service('ai/localModels')

const NL = String.fromCharCode(10)
const SMALL = 'qwen2.5:7b'
const BIG = 'qwen3:30b-a3b-instruct-2507-q4_K_M'
const json = (body) => ({ ok: true, status: 200, json: async () => body })
// A streamed body, delivered in the chunks given: lines may break anywhere.
const streamOf = (chunks) => ({
  ok: true,
  status: 200,
  body: (async function* () { for (const c of chunks) yield new TextEncoder().encode(c) })(),
})
const threw = async (fn) => { try { await fn(); return null } catch (err) { return err.message } }

;(async () => {
  check('the chat address becomes Ollama\'s own', localModels.ollamaRoot('http://localhost:11434/v1'), 'http://localhost:11434')
  check('with a trailing slash too', localModels.ollamaRoot('http://192.168.1.5:11434/v1/'), 'http://192.168.1.5:11434')
  check('only http and https', await threw(() => localModels.ollamaRoot('file:///etc/passwd')),
    'The local server address must start with http:// or https://.')

  // ── Status ────────────────────────────────────────────────────────
  const asked = []
  const running = async (url) => {
    asked.push(url)
    if (url.endsWith('/api/version')) return json({ version: '0.12.0' })
    return json({ models: [{ name: SMALL }, { name: 'llama3.2:latest' }] })
  }
  const up = await localModels.status('http://localhost:11434/v1', { fetchImpl: running })
  check('a running Ollama is found', [up.running, up.version], [true, '0.12.0'])
  check('asked at its own API', asked, ['http://localhost:11434/api/version', 'http://localhost:11434/api/tags'])
  check('a recommended model it has is marked installed', up.recommended.map(m => [m.id, m.installed]), [[SMALL, true], [BIG, false]])
  const down = await localModels.status('http://localhost:11434/v1', { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  check('nothing answering means not running, with nothing installed', [down.running, down.recommended.some(m => m.installed)], [false, false])

  // ── Download ──────────────────────────────────────────────────────
  check('only a recommended model can be downloaded',
    await threw(() => localModels.pull('http://localhost:11434/v1', 'some/huge-model:405b')),
    'Only the recommended models can be downloaded from here.')

  const lines = [
    { status: 'pulling manifest' },
    { status: 'pulling a', digest: 'sha256:a', total: 4000, completed: 1000 },
    { status: 'pulling b', digest: 'sha256:b', total: 1000, completed: 1000 },
    { status: 'pulling a', digest: 'sha256:a', total: 4000, completed: 4000 },
    { status: 'verifying sha256 digest' },
    { status: 'success' },
  ].map(l => JSON.stringify(l)).join(NL) + NL
  let sent = null
  const progress = []
  const result = await localModels.pull('http://localhost:11434/v1', SMALL, {
    fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return streamOf([lines.slice(0, 37), lines.slice(37, 90), lines.slice(90)]) },
    onProgress: (p) => progress.push(p),
  })
  check('the download is asked of Ollama', sent, { url: 'http://localhost:11434/api/pull', body: { model: SMALL, stream: true } })
  check('it finishes', result, { success: true })
  check('the last report sums every layer', progress.at(-1), { model: SMALL, status: 'success', total: 5000, completed: 5000 })

  const failed = await threw(() => localModels.pull('http://localhost:11434/v1', SMALL, {
    fetchImpl: async () => streamOf([`${JSON.stringify({ error: 'no space left on device' })}${NL}`]),
  }))
  check('Ollama\'s error is passed on', failed, `Ollama could not download ${SMALL}: no space left on device`)
  check('a stream that just stops is not a success',
    await threw(() => localModels.pull('http://localhost:11434/v1', SMALL, { fetchImpl: async () => streamOf([`{"status":"pulling manifest"}${NL}`]) })),
    'The download stopped before Ollama said it had finished.')

  // Cancelling: a stream that waits until the request is aborted.
  const hanging = async (_url, init) => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield new TextEncoder().encode(`{"status":"pulling manifest"}${NL}`)
      await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    })(),
  })
  const pending = localModels.pull('http://localhost:11434/v1', BIG, { fetchImpl: hanging })
  await new Promise(r => setTimeout(r, 20))
  check('a second download of the same model is refused',
    await threw(() => localModels.pull('http://localhost:11434/v1', BIG, { fetchImpl: hanging })), 'That model is already downloading.')
  localModels.cancel(BIG)
  check('a cancelled download says so rather than failing', await pending, { success: false, cancelled: true })

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
