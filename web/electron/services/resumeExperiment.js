// A/B testing one résumé against another.
//
// Why this exists alongside "which résumé converts". That report groups sent
// applications by the résumé they used and compares interview rates — but the
// résumés were never comparably assigned. Routing rules deliberately send data
// roles to the data résumé and platform roles to the platform one, so a résumé's
// rate reflects the jobs it was pointed at as much as the document itself. Two
// résumés with a 12-point gap could be identical documents aimed at markets with
// different hiring rates, and the report has no way to say so. Acting on it —
// deleting the "worse" résumé — is a decision made on a confounded number.
//
// Randomised assignment removes the confound. When an experiment is running,
// jobs that no routing rule claimed are split between the two arms by a hash of
// the job URL, so which résumé a job gets is independent of what the job is. A
// difference that survives that is caused by the document.
//
// Two deliberate limits:
//
//   Routing rules still win. A rule is an explicit targeting decision, and
//   silently overriding it to serve an experiment would change what gets sent to
//   real employers in a way the user did not ask for. The experiment fills the
//   space the default résumé would otherwise have occupied.
//
//   Assignment is by job URL hash, not a coin flip. The same job re-encountered
//   on a later scan lands in the same arm, so a re-draft cannot move a job
//   between arms and quietly bias the result.

const crypto = require('crypto')

// Below this many sent applications per arm, no verdict is offered at all.
// A two-proportion test on eight applications each is arithmetic, not evidence,
// and reporting it as a result is how a good résumé gets deleted.
const MIN_PER_ARM = 15

// Two-sided p below this is reported as a real difference.
const ALPHA = 0.05

function isRunning(experiment) {
  return !!(experiment
    && experiment.enabled
    && experiment.resumeA
    && experiment.resumeB
    && experiment.resumeA !== experiment.resumeB)
}

// Which arm this job belongs to. Stable for a given job, and balanced across
// many jobs because the hash's low bit is uniform.
//
// Returns null when no experiment is running, which is the caller's signal to
// fall back to the configured default résumé.
function assignArm(jobUrl, experiment) {
  if (!isRunning(experiment)) return null
  const url = String(jobUrl || '')
  // An empty URL would send every such job to the same arm. Nothing to assign.
  if (!url) return null
  const digest = crypto.createHash('sha256').update(`${experiment.resumeA}:${experiment.resumeB}:${url}`).digest()
  return digest[0] % 2 === 0 ? experiment.resumeA : experiment.resumeB
}

// ─── Reading the result ──────────────────────────────────────────

// Abramowitz & Stegun 7.1.26. Maximum error ~1.5e-7, which is far past what is
// needed to decide whether a p-value sits under 0.05. Written out with Horner's
// nesting explicit rather than inlined, because a transcription slip here is
// silent — it would not throw, it would just produce confident wrong verdicts.
function erfApprox(x) {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * z)
  const poly = t * (0.254829592
    + t * (-0.284496736
    + t * (1.421413741
    + t * (-1.453152027
    + t * 1.061405429))))
  return sign * (1 - poly * Math.exp(-z * z))
}

// P(|Z| > |z|) for a standard normal.
function twoSidedP(z) {
  return 1 - erfApprox(Math.abs(z) / Math.SQRT2)
}

// Pooled two-proportion z-test. Returns null when either arm is empty, since
// there is no proportion to compare.
function compareRates(a, b) {
  if (!a.sent || !b.sent) return null
  const p1 = a.converted / a.sent
  const p2 = b.converted / b.sent
  const pooled = (a.converted + b.converted) / (a.sent + b.sent)
  // Every application converted, or none did, in both arms — the standard error
  // is zero and the test is undefined rather than infinitely significant.
  if (pooled === 0 || pooled === 1) return { z: 0, p: 1 }
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.sent + 1 / b.sent))
  if (!se) return { z: 0, p: 1 }
  const z = (p1 - p2) / se
  return { z, p: twoSidedP(z) }
}

// Turn two arms of counts into something a person can act on.
//
// `arms` is [{ resumeId, name, sent, converted }, …] — exactly two, in the order
// A then B. Everything below is derived; nothing is stored, so this can never
// disagree with the applications table.
function summarise(arms, { minPerArm = MIN_PER_ARM } = {}) {
  const [a, b] = arms
  const withRate = (arm) => ({
    ...arm,
    rate: arm.sent > 0 ? arm.converted / arm.sent : null,
    ratePct: arm.sent > 0 ? Math.round((arm.converted / arm.sent) * 100) : null,
  })
  const armA = withRate(a)
  const armB = withRate(b)

  const smallest = Math.min(a.sent, b.sent)
  const test = compareRates(a, b)

  // Reported before any verdict: an experiment that has not yet sent enough
  // gets a progress figure rather than a premature winner.
  if (smallest < minPerArm) {
    return {
      arms: [armA, armB],
      readable: false,
      minPerArm,
      needed: minPerArm - smallest,
      verdict: `Too early to read. Each résumé needs at least ${minPerArm} sent applications; `
        + `the smaller arm has ${smallest}.`,
      leader: null,
      confident: false,
      pValue: test ? test.p : null,
    }
  }

  const leader = armA.rate === armB.rate ? null : (armA.rate > armB.rate ? armA : armB)
  const confident = !!(test && test.p < ALPHA && leader)
  const gap = leader ? Math.abs((armA.ratePct ?? 0) - (armB.ratePct ?? 0)) : 0

  return {
    arms: [armA, armB],
    readable: true,
    minPerArm,
    needed: 0,
    leader: leader ? leader.resumeId : null,
    leaderName: leader ? leader.name : null,
    confident,
    pValue: test ? test.p : null,
    verdict: !leader
      ? 'Both résumés are converting at the same rate. Nothing to choose between them yet.'
      : confident
        ? `"${leader.name}" is ahead by ${gap} points, and the gap is large enough for the sample `
          + `(p ≈ ${test.p.toFixed(3)}). Worth making it the default.`
        // The honest and most common outcome. Saying "X is winning" off a
        // difference this size is how a coin flip becomes a strategy.
        : `"${leader.name}" is ahead by ${gap} points, but that is within what chance would produce `
          + `at this sample size (p ≈ ${test.p.toFixed(2)}). Keep both running.`,
  }
}

module.exports = { isRunning, assignArm, summarise, compareRates, twoSidedP, erfApprox, MIN_PER_ARM, ALPHA }
