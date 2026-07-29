// Retry, budget enforcement, and cost accounting for every model call.
//
// Three problems this solves, all of which used to be invisible:
//
//  1. A single 429 or network blip failed the call outright. The caller caught
//     it and carried on with a fabricated match score of 50, which was then
//     written to the database as if the model had really said 50.
//  2. Each scanned job costs 3-5 model calls and there was no way to see the
//     spend until the provider's bill arrived.
//  3. Nothing could stop a runaway scan from spending without limit.

const database = require('../database')

// Published per-million-token prices, USD. Used for the cost estimate shown in
// the UI — treat it as an indication, not an invoice. Unknown models fall back
// to zero rather than inventing a number.
const PRICING = {
  // Anthropic
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 3, output: 15 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  // Google — Gemini model names are user-supplied, so these are prefixes.
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
}

function priceFor(model) {
  const name = String(model || '').toLowerCase()
  if (PRICING[name]) return PRICING[name]
  // Gemini model ids carry suffixes ("gemini-2.5-flash-preview-05-20").
  const prefix = Object.keys(PRICING).find(k => name.startsWith(k))
  return prefix ? PRICING[prefix] : null
}

function estimateCost(model, inputTokens, outputTokens) {
  const price = priceFor(model)
  if (!price) return 0
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output
}

// Raised when the monthly cap is already spent. Distinguished from a transient
// failure so the caller can report "budget reached" instead of "AI error", and
// so it is never retried.
class BudgetExceededError extends Error {
  constructor(spent, budget) {
    super(`AI monthly budget reached — $${spent.toFixed(2)} of $${budget.toFixed(2)} spent. Raise or clear the cap in Settings → AI.`)
    this.name = 'BudgetExceededError'
    this.budgetExceeded = true
    this.spent = spent
    this.budget = budget
  }
}

// A failure that retrying cannot fix (bad key, malformed request). Retrying
// these just delays the error and burns the user's rate limit.
function isPermanent(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status
  if (status === 401 || status === 403 || status === 404 || status === 422) return true
  if (status === 400) return true
  const msg = String(err?.message || '').toLowerCase()
  return /invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication|permission denied|model not found/.test(msg)
}

function isRetryable(err) {
  if (isPermanent(err)) return false
  const status = err?.status ?? err?.statusCode ?? err?.response?.status
  if (status === 429) return true
  if (status >= 500 && status < 600) return true
  const code = err?.code || ''
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true
  const msg = String(err?.message || '').toLowerCase()
  return /rate.?limit|overloaded|timeout|timed out|temporarily unavailable|socket hang up|network|fetch failed|too many requests/.test(msg)
}

// Honour a server-supplied Retry-After when there is one — guessing a shorter
// backoff than the provider asked for just earns another 429.
function retryAfterMs(err) {
  const headers = err?.headers || err?.response?.headers
  const raw = headers?.get?.('retry-after') ?? headers?.['retry-after']
  if (raw == null) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), 60_000)
  return null
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Token counts come back in a different shape from each provider.
function readUsage(raw) {
  if (!raw) return { inputTokens: 0, outputTokens: 0 }
  // Anthropic
  if (raw.input_tokens != null || raw.output_tokens != null) {
    return { inputTokens: raw.input_tokens || 0, outputTokens: raw.output_tokens || 0 }
  }
  // OpenAI / DeepSeek
  if (raw.prompt_tokens != null || raw.completion_tokens != null) {
    return { inputTokens: raw.prompt_tokens || 0, outputTokens: raw.completion_tokens || 0 }
  }
  // Gemini
  if (raw.promptTokenCount != null || raw.candidatesTokenCount != null) {
    return { inputTokens: raw.promptTokenCount || 0, outputTokens: raw.candidatesTokenCount || 0 }
  }
  return { inputTokens: 0, outputTokens: 0 }
}

let getConfig = () => {
  try { return require('../config').load() } catch { return {} }
}

// Test seam — lets a test drive the retry logic without a config file.
function _setConfigReader(fn) { getConfig = fn }

// Wrap one model call: enforce the budget, retry transient failures with
// exponential backoff and jitter, and record what it cost.
//
// `fn` receives nothing and must resolve to { value, model, usage }, where
// `usage` is the provider's raw usage object (or null when it doesn't report
// one). Returns `value`.
async function withUsage(operation, provider, fn) {
  const cfg = getConfig()
  const budget = Number(cfg.aiMonthlyBudgetUsd) || 0
  if (budget > 0) {
    let spent = 0
    try { spent = database.getMonthlyAiSpend() } catch { spent = 0 }
    if (spent >= budget) throw new BudgetExceededError(spent, budget)
  }

  const maxRetries = Math.min(6, Math.max(0, Number(cfg.aiMaxRetries ?? 3)))
  let lastErr = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { value, model, usage } = await fn()
      const { inputTokens, outputTokens } = readUsage(usage)
      try {
        database.recordAiUsage({
          provider,
          model: model || '',
          operation,
          inputTokens,
          outputTokens,
          costUsd: estimateCost(model, inputTokens, outputTokens),
        })
      } catch { /* accounting must never fail the call it is measuring */ }
      return value
    } catch (err) {
      lastErr = err
      if (attempt === maxRetries || !isRetryable(err)) break
      // 1s, 2s, 4s… with jitter, unless the server named its own delay.
      const backoff = retryAfterMs(err) ?? Math.round((2 ** attempt) * 1000 * (0.75 + Math.random() * 0.5))
      await sleep(backoff)
    }
  }

  // Make the cause legible in the activity log — "AI error: 429" told the user
  // nothing about what to do next.
  if (lastErr && isRetryable(lastErr)) {
    lastErr.message = `${lastErr.message} (gave up after ${maxRetries + 1} attempt${maxRetries === 0 ? '' : 's'})`
    lastErr.retriesExhausted = true
  }
  throw lastErr
}

module.exports = {
  withUsage, estimateCost, priceFor, isRetryable, isPermanent, readUsage,
  BudgetExceededError, PRICING, _setConfigReader,
}
