// Retry budget, and comparing two saved outputs.
//
// Per-call retries bound one flaky request. They do nothing about the case that
// actually costs money: a provider degrading for twenty minutes, where every
// job in a scan burns its full allowance, the scan takes an order of magnitude
// longer, and every successful retry is still billed. The run-level cap exists
// for that, so the tests below are about it stopping the bleeding without
// breaking the ordinary flaky-request case.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-retry-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const usage = require('../electron/services/ai/usage')
const db = service('database.js')
const { check, done } = createChecker()

// Drive the retry logic without a config file.
let aiConfig = { aiMaxRetries: 3, aiMonthlyBudgetUsd: 0 }
usage._setConfigReader(() => aiConfig)

const rateLimit = () => Object.assign(new Error('Rate limited'), { status: 429 })
const permanent = () => Object.assign(new Error('Bad API key'), { status: 401 })

// Never sleep for real: the backoff is 1s, 2s, 4s and these tests exercise it
// dozens of times.
const originalSetTimeout = global.setTimeout
global.setTimeout = (fn) => originalSetTimeout(fn, 0)

;(async () => {
  await db.init()

  // ── An ordinary flaky call still succeeds ────────────────────
  {
    usage.resetRetryBudget(20)
    let calls = 0
    const value = await usage.withUsage('score', 'openai', async () => {
      calls++
      if (calls < 3) throw rateLimit()
      return { value: 'ok', model: 'gpt-4o-mini', usage: null }
    })
    check('a transient failure is retried through', value, 'ok')
    check('it took the expected number of attempts', calls, 3)
    check('retries are charged to the budget', usage.retryBudgetStatus().spent, 2)
  }

  // ── The cap stops a degrading provider ───────────────────────
  {
    // Deliberately below aiMaxRetries, so the run cap is what bites — at equal
    // values both limits stop on the same attempt and the test would pass
    // without proving the budget did anything.
    usage.resetRetryBudget(2)
    let calls = 0
    let caught = null
    try {
      await usage.withUsage('score', 'openai', async () => { calls++; throw rateLimit() })
    } catch (err) { caught = err }
    check('the call still fails', !!caught, true)
    // 1 initial attempt + 2 budgeted retries, then the cap bites — one attempt
    // earlier than the per-call limit of 3 would have allowed.
    check('retries stop at the budget', calls, 3)
    check('the budget is fully spent', usage.retryBudgetStatus().spent, 2)
    check('the budget reports itself exhausted', usage.retryBudgetStatus().exhausted, true)
    check('the cause is named', caught.retryBudgetExhausted, true)
    // "gave up after 1 attempt" would read as a misconfigured retry count.
    check('the message blames the provider, not the setting',
      caught.message.includes('retry budget is spent'), true)
  }

  // ── An exhausted budget does not stop work ───────────────────
  // Calls still happen; only retrying stops. A provider that has recovered
  // must not be locked out for the rest of the scan.
  {
    usage.resetRetryBudget(1)
    try { await usage.withUsage('score', 'openai', async () => { throw rateLimit() }) } catch { /* spends it */ }
    check('budget is now exhausted', usage.retryBudgetStatus().exhausted, true)

    let calls = 0
    const value = await usage.withUsage('score', 'openai', async () => {
      calls++
      return { value: 'recovered', model: 'gpt-4o-mini', usage: null }
    })
    check('a first-try success still works', value, 'recovered')
    check('it was not retried', calls, 1)
  }

  // ── A limit of zero keeps the old behaviour ──────────────────
  {
    usage.resetRetryBudget(0)
    let calls = 0
    try {
      await usage.withUsage('score', 'openai', async () => { calls++; throw rateLimit() })
    } catch { /* expected */ }
    check('no run cap falls back to the per-call limit', calls, 4) // 1 + aiMaxRetries
    check('an uncapped budget never reports exhausted', usage.retryBudgetStatus().exhausted, false)
  }

  // ── Permanent errors are not retried at all ──────────────────
  {
    usage.resetRetryBudget(20)
    let calls = 0
    try {
      await usage.withUsage('score', 'openai', async () => { calls++; throw permanent() })
    } catch { /* expected */ }
    check('a bad key is not retried', calls, 1)
    check('a permanent failure costs no budget', usage.retryBudgetStatus().spent, 0)
  }

  // ── Reset is per scan ────────────────────────────────────────
  {
    usage.resetRetryBudget(2)
    try { await usage.withUsage('score', 'openai', async () => { throw rateLimit() }) } catch {}
    check('budget spent after a bad scan', usage.retryBudgetStatus().exhausted, true)
    usage.resetRetryBudget(2)
    check('the next scan starts fresh', usage.retryBudgetStatus().spent, 0)
    check('and is no longer exhausted', usage.retryBudgetStatus().exhausted, false)
  }

  // ── Comparing two saved outputs ──────────────────────────────
  // The base-vs-tailored diff answers "what did the model change about me".
  // This answers "is the new model better", which needs two outputs, not one
  // output against the source.
  {
    const app = db.insertApplication({
      job_title: 'Engineer', company: 'Acme', platform: 'Seek',
      job_url: 'https://example.com/c1', job_description: 'jd', match_score: 80,
      base_resume: 'BASE', tailored_resume: 'Version one', cover_letter: 'Letter one',
      screening_qa: [], status: 'held',
      provider: 'openai', model: 'gpt-4o-mini',
    })
    db.recordSnapshot(app.id, 'retailored', {
      base_resume: 'BASE', tailored_resume: 'Version two', cover_letter: 'Letter two',
      screening_qa: [], match_score: 80, status: 'held',
      provider: 'anthropic', model: 'claude-opus-5',
    })

    const [newer, older] = db.getSnapshots(app.id)
    check('the model is recorded on the snapshot', older.model, 'gpt-4o-mini')
    check('the provider is recorded too', newer.provider, 'anthropic')

    const cmp = db.compareSnapshots(older.id, newer.id)
    check('the two versions differ', cmp.summary.added, 1)
    check('the comparison names both models', cmp.from.model, 'gpt-4o-mini')
    check('and the newer one', cmp.to.model, 'claude-opus-5')

    const letters = db.compareSnapshots(older.id, newer.id, 'cover_letter')
    check('cover letters can be compared too', letters.summary.added, 1)

    // Diffing two different jobs produces a wall of noise that means nothing.
    const other = db.insertApplication({
      job_title: 'Other', company: 'Globex', platform: 'Seek',
      job_url: 'https://example.com/c2', job_description: 'jd', match_score: 70,
      tailored_resume: 'Different job', cover_letter: 'x', screening_qa: [], status: 'held',
    })
    const otherSnap = db.getSnapshots(other.id)[0]
    check('comparing across applications is refused',
      !!db.compareSnapshots(older.id, otherSnap.id).error, true)
    check('an unknown snapshot is refused', !!db.compareSnapshots(older.id, 99999).error, true)
    check('an uncomparable field is refused',
      !!db.compareSnapshots(older.id, newer.id, 'match_score').error, true)
  }

  global.setTimeout = originalSetTimeout
  done()
})()
