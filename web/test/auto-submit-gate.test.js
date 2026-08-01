// The last gate before something irreversible: with review mode on, which
// drafts may skip approval and go straight to an employer.
//
// Everything uncertain must hold. Auto-sending a bad application cannot be
// undone, while holding a good one costs a click, so a missing threshold, a
// malformed one, or an unscored job all fall to the safe side rather than
// being treated as a pass.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-autosubmit-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const { shouldHoldForReview } = service('applicator.js')
const { check, done } = createChecker()

// ── Review mode off ────────────────────────────────────────────
// The gate does not apply at all; the threshold is ignored even if set.
check('review off submits', shouldHoldForReview({ reviewBeforeSubmit: false }, 10), false)
check('review off ignores the threshold',
  shouldHoldForReview({ reviewBeforeSubmit: false, autoSubmitThreshold: 99 }, 10), false)

// ── Review mode on, no threshold ───────────────────────────────
// This is what "review before submit" meant before the threshold existed, and
// it stays the default: hold everything.
check('no threshold holds a perfect score',
  shouldHoldForReview({ reviewBeforeSubmit: true }, 100), true)
check('null threshold holds',
  shouldHoldForReview({ reviewBeforeSubmit: true, autoSubmitThreshold: null }, 100), true)

// ── Review mode on, threshold set ──────────────────────────────
const gated = { reviewBeforeSubmit: true, autoSubmitThreshold: 90 }
check('above the gate submits', shouldHoldForReview(gated, 95), false)
check('exactly on the gate submits', shouldHoldForReview(gated, 90), false)
check('below the gate holds', shouldHoldForReview(gated, 89), true)
check('far below the gate holds', shouldHoldForReview(gated, 0), true)

// ── Unscored jobs ──────────────────────────────────────────────
// A job with no score is not a high-confidence job. Before this rule existed a
// null score compared as 0, which happened to hold — but only by accident of
// coercion, and `undefined < 90` is false, which would have submitted it.
check('null score holds', shouldHoldForReview(gated, null), true)
check('undefined score holds', shouldHoldForReview(gated, undefined), true)
check('NaN score holds', shouldHoldForReview(gated, NaN), true)

// ── Malformed thresholds ───────────────────────────────────────
// A config hand-edited to a string must not silently disable review. "90" and
// 95 compare fine in JS, so a loose implementation would submit here.
check('string threshold holds',
  shouldHoldForReview({ reviewBeforeSubmit: true, autoSubmitThreshold: '90' }, 95), true)
check('NaN threshold holds',
  shouldHoldForReview({ reviewBeforeSubmit: true, autoSubmitThreshold: NaN }, 95), true)
check('Infinity threshold holds',
  shouldHoldForReview({ reviewBeforeSubmit: true, autoSubmitThreshold: Infinity }, 95), true)

// A zero threshold is a real choice — "send everything that got scored" — and
// must not be swallowed by a falsy check.
check('zero threshold submits a scored job',
  shouldHoldForReview({ reviewBeforeSubmit: true, autoSubmitThreshold: 0 }, 5), false)
check('zero threshold still holds an unscored job',
  shouldHoldForReview({ reviewBeforeSubmit: true, autoSubmitThreshold: 0 }, null), true)

done()
