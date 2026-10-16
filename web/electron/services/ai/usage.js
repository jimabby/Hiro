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
// the UI — treat it as an indication, not an invoice. An unknown model is
// priced at its provider's most expensive known tier (see fallbackPriceFor): a
// guess, but one that errs towards the monthly cap firing rather than never.
const PRICING = {
  // Anthropic. Haiku 5.5's rate is for prompts up to 100K tokens, which is
  // every prompt Hiro sends.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
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
  // Gemini model ids carry suffixes ("gemini-2.5-flash-preview-05-20"). The
  // LONGEST matching prefix wins: "claude-sonnet-5-5-x" must not be priced as
  // "claude-sonnet-5", nor "gpt-4o-mini-x" as "gpt-4o".
  const prefix = Object.keys(PRICING).filter(k => name.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return prefix ? PRICING[prefix] : null
}

// Which PRICING keys belong to which provider, for the unknown-model fallback.
const PROVIDER_PREFIXES = {
  claude: ['claude-'],
  chatgpt: ['gpt-', 'o1', 'o3', 'o4'],
  deepseek: ['deepseek-'],
  gemini: ['gemini-'],
}

// An unknown model used to cost $0 — so a model id newer than this table (or a
// typo that the provider happened to accept) made every call free, and the
// monthly cap the user set could never fire. It is now priced at the most
// expensive tier this table knows for that provider, and for a provider it
// cannot place, the most expensive tier of all. A local model runs on the
// user's own machine and genuinely costs nothing.
function fallbackPriceFor(provider) {
  if (provider === 'local') return null
  const prefixes = PROVIDER_PREFIXES[provider]
  const keys = Object.keys(PRICING).filter(k => !prefixes || prefixes.some(p => k.startsWith(p)))
  const pool = keys.length ? keys : Object.keys(PRICING)
  return pool.map(k => PRICING[k]).reduce((max, p) => (p.output > max.output ? p : max))
}

// Logged once per model per process: a scan makes hundreds of calls.
const warnedUnknown = new Set()
function warnUnknownModel(provider, model, price) {
  const key = `${provider}:${model}`
  if (warnedUnknown.has(key)) return
  warnedUnknown.add(key)
  try {
    require('../logger').append(`AI usage: no published price for "${model || '(unnamed model)'}" — `
      + `estimating cost at $${price.input}/$${price.output} per million tokens so the monthly budget still applies.`)
  } catch { /* logging is best-effort */ }
}

// Anthropic reports cache reads and writes apart from `input_tokens`. Reads bill
// at a tenth of the input price, five-minute writes at 1.25×.
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_MULTIPLIER = 1.25

function estimateCost(model, inputTokens, outputTokens, { provider = '', cacheReadTokens = 0, cacheWriteTokens = 0 } = {}) {
  let price = priceFor(model)
  if (!price && provider) {
    price = fallbackPriceFor(provider)
    if (price) warnUnknownModel(provider, model, price)
  }
  if (!price) return 0
  return (inputTokens / 1e6) * price.input
    + (outputTokens / 1e6) * price.output
    + (cacheReadTokens / 1e6) * price.input * CACHE_READ_MULTIPLIER
    + (cacheWriteTokens / 1e6) * price.input * CACHE_WRITE_MULTIPLIER
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
  // A model that declined will decline the same input again.
  if (err?.refusal) return true
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
  if (!raw) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  // Anthropic. Cached prefix tokens are reported separately from input_tokens.
  if (raw.input_tokens != null || raw.output_tokens != null) {
    return {
      inputTokens: raw.input_tokens || 0,
      outputTokens: raw.output_tokens || 0,
      cacheReadTokens: raw.cache_read_input_tokens || 0,
      cacheWriteTokens: raw.cache_creation_input_tokens || 0,
    }
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


// ─── Retry budget ────────────────────────────────────────────────
// Per-call retries bound one flaky request. They do nothing about the case
// that actually costs money and hours: a provider degrading for twenty minutes,
// where every job in a scan burns its full retry allowance, the scan takes an
// order of magnitude longer, and each successful retry is still billed.
//
// So retries are also capped across a whole run. Once the run has spent its
// budget, calls still happen — a request that succeeds first time is fine — but
// nothing is retried, so a broken provider fails fast instead of slowly.
//
// Scoped per operation, not per process. The budget used to be one module-level
// counter reset only at the start of a scan — so once a scan had spent it, the
// inbox check, follow-ups and every manual apply that ran afterwards got no
// retries at all until the next scan happened to reset it. Now a top-level
// operation runs inside `withRetryBudget(limit, fn)`, which gives it a budget
// of its own that follows its async calls (AsyncLocalStorage) and nobody
// else's. A call outside any scope uses the shared fallback budget below, which
// is uncapped unless something explicitly sets it — per-call retries only.
const { AsyncLocalStorage } = require('async_hooks')
const budgetScope = new AsyncLocalStorage()
let retryBudget = { spent: 0, limit: 0 }

function currentBudget() {
  return budgetScope.getStore() || retryBudget
}

// The fallback budget, for calls made outside any withRetryBudget scope.
function resetRetryBudget(limit) {
  retryBudget = { spent: 0, limit: Math.max(0, Number(limit) || 0) }
}

// Run `fn` with a retry budget of its own. Nested scopes get their own too.
function withRetryBudget(limit, fn) {
  return budgetScope.run({ spent: 0, limit: Math.max(0, Number(limit) || 0) }, fn)
}

function retryBudgetStatus() {
  const b = currentBudget()
  return { spent: b.spent, limit: b.limit, exhausted: b.limit > 0 && b.spent >= b.limit }
}

// A limit of 0 means "no run-level cap", which keeps the previous behaviour for
// anyone who wants it.
function canRetry() {
  const b = currentBudget()
  if (b.limit <= 0) return true
  return b.spent < b.limit
}

function chargeRetry() {
  currentBudget().spent += 1
}

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
      const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = readUsage(usage)
      try {
        database.recordAiUsage({
          provider,
          model: model || '',
          operation,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          costUsd: estimateCost(model, inputTokens, outputTokens, { provider, cacheReadTokens, cacheWriteTokens }),
        })
      } catch { /* accounting must never fail the call it is measuring */ }
      return value
    } catch (err) {
      lastErr = err
      if (attempt === maxRetries || !isRetryable(err)) break
      // The run-level cap. Checked before sleeping, so an exhausted budget
      // fails immediately rather than waiting out a backoff it will not use.
      if (!canRetry()) {
        lastErr.retryBudgetExhausted = true
        break
      }
      chargeRetry()
      // 1s, 2s, 4s… with jitter, unless the server named its own delay.
      const backoff = retryAfterMs(err) ?? Math.round((2 ** attempt) * 1000 * (0.75 + Math.random() * 0.5))
      await sleep(backoff)
    }
  }

  // Make the cause legible in the activity log — "AI error: 429" told the user
  // nothing about what to do next.
  if (lastErr && isRetryable(lastErr)) {
    lastErr.message = lastErr.retryBudgetExhausted
      // Naming the real cause matters: "gave up after 1 attempt" would read as
      // a misconfigured retry count rather than a provider that has been
      // failing all scan.
      ? `${lastErr.message} (this scan's retry budget is spent — the provider has been failing repeatedly)`
      : `${lastErr.message} (gave up after ${maxRetries + 1} attempt${maxRetries === 0 ? '' : 's'})`
    lastErr.retriesExhausted = true
  }
  throw lastErr
}

module.exports = {
  withUsage, resetRetryBudget, withRetryBudget, retryBudgetStatus, estimateCost, priceFor, fallbackPriceFor, isRetryable, isPermanent, readUsage,
  BudgetExceededError, PRICING, _setConfigReader,
}
