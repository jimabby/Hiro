// Retry, budget enforcement and cost accounting around every model call.
//
// Before this existed, one 429 failed the call, the caller carried on with a
// fabricated match score of 50, and that guess was written to the database as
// though the model had really said it.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-ai-usage-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const usage = require(path.join(__dirname, '..', 'electron', 'services', 'ai', 'usage.js'))
const { check, done } = createChecker()

let cfg = { aiMaxRetries: 3, aiMonthlyBudgetUsd: 0 }
usage._setConfigReader(() => cfg)

const err = (props) => Object.assign(new Error(props.message || 'boom'), props)

;(async () => {
  await db.init()

  // ── Which failures are worth retrying ──────────────────────────
  check('rate limits are retried', usage.isRetryable(err({ status: 429 })), true)
  check('server errors are retried', usage.isRetryable(err({ status: 503 })), true)
  check('dropped sockets are retried', usage.isRetryable(err({ code: 'ECONNRESET' })), true)
  check('overloaded is retried', usage.isRetryable(err({ message: 'Overloaded' })), true)
  check('a bad API key is not retried', usage.isRetryable(err({ status: 401 })), false)
  check('a malformed request is not retried', usage.isRetryable(err({ status: 400 })), false)
  check('an invalid key message is permanent', usage.isPermanent(err({ message: 'Invalid API key provided' })), true)

  // ── Token shapes differ per provider ───────────────────────────
  check('anthropic usage is read', usage.readUsage({ input_tokens: 10, output_tokens: 4 }).inputTokens, 10)
  check('openai usage is read', usage.readUsage({ prompt_tokens: 7, completion_tokens: 2 }).outputTokens, 2)
  check('gemini usage is read', usage.readUsage({ promptTokenCount: 9, candidatesTokenCount: 3 }).inputTokens, 9)
  check('a missing usage object is zero, not a crash', usage.readUsage(null).inputTokens, 0)

  // ── Cost estimation ────────────────────────────────────────────
  // 1M input tokens of Haiku 4.5 at $1/M.
  check('cost is estimated from published prices', usage.estimateCost('claude-haiku-4-5', 1e6, 0), 1)
  // Gemini model ids carry suffixes; pricing matches on the prefix.
  check('gemini suffixes still price', usage.priceFor('gemini-2.5-flash-preview-05-20').input, 0.3)
  check('an unknown model costs zero rather than a guess', usage.estimateCost('some-new-model', 1e6, 1e6), 0)

  // ── Retry actually happens, and usage is recorded ──────────────
  let attempts = 0
  cfg = { aiMaxRetries: 2, aiMonthlyBudgetUsd: 0 }
  const value = await usage.withUsage('scoreMatch', 'claude', async () => {
    attempts++
    if (attempts < 3) throw err({ status: 429, message: 'rate limited' })
    return { value: 'ok', model: 'claude-haiku-4-5', usage: { input_tokens: 1000, output_tokens: 100 } }
  })
  check('a transient failure is retried until it succeeds', value, 'ok')
  check('it took exactly three attempts', attempts, 3)
  check('one usage row is recorded, not one per attempt', db.getAiUsageSummary().month.calls, 1)
  check('input tokens are recorded', db.getAiUsageSummary().month.inputTokens, 1000)

  // ── Retries are bounded ────────────────────────────────────────
  let tries = 0
  cfg = { aiMaxRetries: 1, aiMonthlyBudgetUsd: 0 }
  let thrown = null
  try {
    await usage.withUsage('scoreMatch', 'claude', async () => {
      tries++
      throw err({ status: 429, message: 'still limited' })
    })
  } catch (e) { thrown = e }
  check('it gives up after the configured retries', tries, 2)
  check('the failure is reported, not swallowed', !!thrown, true)
  check('the message says it gave up', /gave up after 2 attempts/.test(thrown.message), true)

  // A permanent error must not burn the retry budget.
  let permTries = 0
  cfg = { aiMaxRetries: 3, aiMonthlyBudgetUsd: 0 }
  try {
    await usage.withUsage('scoreMatch', 'claude', async () => {
      permTries++
      throw err({ status: 401, message: 'bad key' })
    })
  } catch { /* expected */ }
  check('a permanent error is tried once', permTries, 1)

  // ── Budget cap stops work before spending ──────────────────────
  cfg = { aiMaxRetries: 0, aiMonthlyBudgetUsd: 0.000001 } // already exceeded
  let budgetErr = null
  let called = false
  try {
    await usage.withUsage('tailorResume', 'claude', async () => {
      called = true
      return { value: 'x', model: 'claude-sonnet-5', usage: {} }
    })
  } catch (e) { budgetErr = e }
  check('the cap raises before the call is made', called, false)
  check('the cap is a distinct, non-retryable error', budgetErr?.budgetExceeded, true)
  check('budget errors are never retried', usage.isRetryable(budgetErr), false)

  // A cap of 0 means no cap at all.
  cfg = { aiMaxRetries: 0, aiMonthlyBudgetUsd: 0 }
  const after = await usage.withUsage('tailorResume', 'claude', async () =>
    ({ value: 'done', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 5 } }))
  check('zero means no cap', after, 'done')

  done()
})()
