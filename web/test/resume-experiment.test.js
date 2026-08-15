// The randomised résumé A/B test.
//
// Two things have to hold, and they pull in opposite directions:
//
//   Assignment must be balanced (or the arms aren't comparable) AND stable (or a
//   job re-seen on a later scan could move arms and be counted in both).
//
//   The verdict must be willing to say "ahead but not meaningfully". This is the
//   whole point: the existing observational report invites acting on a 12-point
//   gap that a coin flip would produce, and a test that always names a winner
//   would just relocate that mistake rather than fix it.

const { service, createChecker } = require('./helpers')
const exp = service('resumeExperiment')
const { check, done } = createChecker()

const running = { enabled: true, resumeA: 'resume-a', resumeB: 'resume-b' }

// ─── When it applies at all ──────────────────────────────────────
check('an experiment needs to be enabled', exp.isRunning({ ...running, enabled: false }), false)
check('an experiment needs both arms', exp.isRunning({ enabled: true, resumeA: 'a', resumeB: '' }), false)
check('the same résumé twice is not a test', exp.isRunning({ enabled: true, resumeA: 'a', resumeB: 'a' }), false)
check('a configured experiment runs', exp.isRunning(running), true)
check('nothing is assigned when not running', exp.assignArm('https://x/1', { enabled: false }), null)
// A job with no URL has nothing to hash, and hashing '' would send every such
// job to the same arm — a quiet, systematic bias.
check('a job with no URL is not assigned', exp.assignArm('', running), null)

// ─── Assignment ──────────────────────────────────────────────────
const arms = Array.from({ length: 4000 }, (_, i) => exp.assignArm(`https://jobs.example.com/${i}`, running))
const aCount = arms.filter(a => a === 'resume-a').length
check('every job lands in one of the two arms',
  arms.every(a => a === 'resume-a' || a === 'resume-b'), true)
// Within 5% of even over 4000 draws. A skew larger than this would bias the
// comparison the whole feature exists to make.
check('the split is even to within 5%', Math.abs(aCount - 2000) < 200, true)

const url = 'https://jobs.example.com/stable-check'
check('assignment is stable for a given job', exp.assignArm(url, running), exp.assignArm(url, running))
// Swapping which résumé is A and which is B must not silently re-randomise a
// running experiment into a different split of the same jobs.
check('assignment depends on the arm pair', (() => {
  const swapped = { enabled: true, resumeA: 'resume-b', resumeB: 'resume-a' }
  // Same pair of documents, so a job keeps the same document either way.
  return exp.assignArm(url, running) === exp.assignArm(url, swapped)
})(), false)

// ─── Reading the result ──────────────────────────────────────────
const arm = (resumeId, name, sent, converted) => ({ resumeId, name, sent, converted })

// Too small to read. The honest answer here is "wait", not a winner.
const early = exp.summarise([arm('a', 'A', 6, 3), arm('b', 'B', 5, 0)])
check('a small sample is not readable', early.readable, false)
check('a small sample names no leader', early.leader, null)
check('a small sample says how many more are needed', early.needed, exp.MIN_PER_ARM - 5)

// A real but modest gap on a modest sample: ahead, but not beyond chance.
const modest = exp.summarise([arm('a', 'A', 40, 10), arm('b', 'B', 40, 7)])
check('a modest gap identifies who is ahead', modest.leader, 'a')
check('a modest gap is not called significant', modest.confident, false)
check('a modest gap says so in words', modest.verdict.includes('within what chance would produce'), true)

// A large gap on a large sample: this one is real.
const decisive = exp.summarise([arm('a', 'A', 200, 60), arm('b', 'B', 200, 20)])
check('a decisive gap identifies the leader', decisive.leader, 'a')
check('a decisive gap is called significant', decisive.confident, true)
check('a decisive gap reports a small p-value', decisive.pValue < 0.05, true)

// Identical arms must never produce a winner, however large the sample.
const tied = exp.summarise([arm('a', 'A', 300, 45), arm('b', 'B', 300, 45)])
check('identical rates name no leader', tied.leader, null)
check('identical rates are not significant', tied.confident, false)

// Degenerate inputs that would make a naive z-test divide by zero.
const noneConverted = exp.summarise([arm('a', 'A', 50, 0), arm('b', 'B', 50, 0)])
check('zero conversions in both arms is not a finding', noneConverted.confident, false)
check('zero conversions reports a rate of 0, not null', noneConverted.arms[0].ratePct, 0)
const allConverted = exp.summarise([arm('a', 'A', 50, 50), arm('b', 'B', 50, 50)])
check('total conversion in both arms is not a finding', allConverted.confident, false)
check('an empty arm yields no comparison', exp.compareRates({ sent: 0, converted: 0 }, { sent: 10, converted: 2 }), null)

// ─── The statistics themselves ───────────────────────────────────
// A transcription slip in the erf polynomial would not throw; it would produce
// confident wrong verdicts. Checked against known values.
const close = (a, b, tol) => Math.abs(a - b) < tol
check('erf(1) is correct', close(exp.erfApprox(1), 0.8427007, 1e-6), true)
check('erf(2) is correct', close(exp.erfApprox(2), 0.9953223, 1e-6), true)
check('erf is odd', close(exp.erfApprox(-1.5), -exp.erfApprox(1.5), 1e-12), true)
check('z=1.96 is the 5% two-sided threshold', close(exp.twoSidedP(1.96), 0.05, 0.001), true)
check('z=2.576 is the 1% two-sided threshold', close(exp.twoSidedP(2.576), 0.01, 0.001), true)
check('z=0 is p=1', close(exp.twoSidedP(0), 1, 1e-9), true)

done()
