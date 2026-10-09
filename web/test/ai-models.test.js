// Which model runs, and which model is recorded.
//
// The record used to be `geminiModel` for every provider: blank for Claude and
// ChatGPT, and a leftover Gemini name for anyone who had switched away from it.
// The local adapter preferred that same leftover over its own setting. And the
// Claude defaults had gone stale — Sonnet 5.5 rejects the thinking config the
// old adapter sent, so the request shape is now chosen per model.

const { createChecker, stub } = require('./helpers')

let savedConfig = {}
stub({ '../config': { load: () => savedConfig } })

const models = require('../electron/services/ai/models')
const claude = require('../electron/services/ai/claude')
const openai = require('../electron/services/ai/openai')
const usage = require('../electron/services/ai/usage')

const { check, done } = createChecker()

// ─── What gets recorded against an application ───────────────────
check('Claude records its default writing model', models.writingModel({ aiProvider: 'claude' }), 'claude-sonnet-5-5')
check('Claude records the chosen model', models.writingModel({ aiProvider: 'claude', aiWritingModel: { claude: 'claude-opus-5-5' } }), 'claude-opus-5-5')
check('a leftover Gemini name never labels Claude', models.writingModel({ aiProvider: 'claude', geminiModel: 'gemini-2.5-flash' }), 'claude-sonnet-5-5')
check('ChatGPT records its model', models.writingModel({ aiProvider: 'chatgpt' }), 'gpt-4o')
check('Gemini records its own field', models.writingModel({ aiProvider: 'gemini', geminiModel: 'gemini-2.5-pro' }), 'gemini-2.5-pro')
check('a local model records the local setting, not a Gemini leftover',
  models.writingModel({ aiProvider: 'local', geminiModel: 'gemini-2.5-flash', localAiModel: 'qwen2.5:14b' }), 'qwen2.5:14b')
check('a local model with nothing set records the default', models.writingModel({ aiProvider: 'local' }), 'llama3.1:8b')
check('another provider\'s choice is ignored', models.writingModel({ aiProvider: 'deepseek', aiWritingModel: { claude: 'claude-opus-5-5' } }), 'deepseek-chat')
check('no provider records nothing', models.writingModel({}), '')

// ─── Claude request shapes: each must be one the model accepts ────
check('Sonnet 5.5 turns thinking off with between_tools', claude.requestShape('claude-sonnet-5-5').thinking, { type: 'between_tools' })
check('Opus 5.5 sends no thinking config (disabled is a 400)', claude.requestShape('claude-opus-5-5').thinking, undefined)
check('Opus 5.5 runs at low effort', claude.requestShape('claude-opus-5-5').output_config, { effort: 'low' })
check('Opus 5.5 gets room for its thinking', claude.requestShape('claude-opus-5-5').thinkingHeadroom > 0, true)
check('Haiku 5.5 disables thinking', claude.requestShape('claude-haiku-5-5').thinking, { type: 'disabled' })
check('Sonnet 5 still disables thinking', claude.requestShape('claude-sonnet-5').thinking, { type: 'disabled' })

check('a refusal is not retried', usage.isPermanent(new claude.RefusalError('cyber')), true)
check('a refusal names its category', /cyber/.test(new claude.RefusalError('cyber').message), true)

// ─── OpenAI reasoning models ─────────────────────────────────────
const adapted = openai.adaptForModel('chatgpt', { model: 'gpt-5', max_tokens: 500, temperature: 0.3, messages: [] })
check('a reasoning model gets max_completion_tokens', adapted.max_completion_tokens > 500, true)
check('…and no max_tokens', 'max_tokens' in adapted, false)
check('…and no temperature', 'temperature' in adapted, false)
check('gpt-4o is sent unchanged', openai.adaptForModel('chatgpt', { model: 'gpt-4o', max_tokens: 500 }), { model: 'gpt-4o', max_tokens: 500 })
check('DeepSeek is never rewritten', openai.adaptForModel('deepseek', { model: 'gpt-5', max_tokens: 5 }).max_tokens, 5)

// ─── The adapters read the saved choice at call time ─────────────
savedConfig = { aiWritingModel: { chatgpt: 'gpt-4.1', deepseek: 'deepseek-reasoner' } }
check('ChatGPT writes with the saved model', openai.resolve().smart, 'gpt-4.1')
check('ChatGPT still scores on the cheap model', openai.resolve().fast, 'gpt-4o-mini')
check('DeepSeek writes with the saved model', openai.resolve('https://api.deepseek.com').smart, 'deepseek-reasoner')
savedConfig = {}
check('with nothing saved ChatGPT uses the default', openai.resolve().smart, 'gpt-4o')

// ─── Cost estimates ──────────────────────────────────────────────
check('Sonnet 5.5 is priced as itself', usage.estimateCost('claude-sonnet-5-5', 1e6, 0), 2)
check('Haiku 5.5 is priced as itself', usage.estimateCost('claude-haiku-5-5', 1e6, 1e6), 0.6)
check('the longest prefix wins', usage.estimateCost('gpt-4o-mini-2024-07-18', 1e6, 0), 0.15)

done()
