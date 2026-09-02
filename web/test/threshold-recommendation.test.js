// What the outcomes say the match threshold should be.
//
// The histogram already showed where the threshold sits and the band table
// already showed which bands convert. Neither said the thing both of them imply:
// that the threshold is in the wrong place.
//
// This is a recommendation and never an action, and the tests are shaped around
// that. Moving someone's threshold changes which real employers receive real
// applications, and it would do so on an inference from their own past — so the
// bar for saying anything at all is deliberately high, and "not enough evidence
// yet" has to be a first-class answer rather than a fallback nobody sees.

const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-threshold-'))
process.env.HIRO_CONFIG_DIR = DIR

const { createChecker } = require('./helpers')
const database = require('../electron/services/database')
const { check, done } = createChecker()

let seq = 0
function add({ score, status = 'applied' }) {
  seq += 1
  const row = database.insertApplication({
    job_title: `Role ${seq}`, company: `Company ${seq}`, platform: 'Seek', salary: '',
    job_url: `https://example.test/${seq}`, job_description: 'description',
    match_score: score, match_explanation: '', tailored_resume: '', cover_letter: '',
    screening_qa: [], status: 'applied', closing_date: null,
    resume_id: null, resume_name: null, recruiter_email: '',
  })
  if (status !== 'applied') database.updateApplicationStatus(row.id, status)
  return row
}

// `converted` of `count` applications in this band reached interview.
function band(score, count, converted) {
  for (let i = 0; i < count; i++) add({ score, status: i < converted ? 'interview' : 'applied' })
}

;(async () => {
  await database.init()

  // ── Nothing to go on ───────────────────────────────────────────
  const empty = database.getThresholdRecommendation(70)
  check('an empty history says so', empty.verdict, 'insufficient')
  check('and does not name a number', empty.recommended, undefined)
  check('and explains what it is waiting for', /at least 30 sent/.test(empty.detail), true)

  // ── A small sample stays quiet ─────────────────────────────────
  // A 100% conversion rate from two applications is a statement about two
  // applications, and this is exactly where a confident number would do harm.
  band(45, 9, 0)
  band(85, 9, 6)
  const small = database.getThresholdRecommendation(50)
  check('eighteen applications is still not enough', small.verdict, 'insufficient')

  // ── A real signal, across a realistic spread of scores ─────────
  // Conversion starts at 70: everything below it is spend without outcome.
  band(45, 3, 0)   // 45–49 band now 12 applications, 0 converted
  band(55, 12, 1)
  band(65, 12, 1)
  band(75, 12, 7)
  band(85, 3, 2)   // 85–89 band now 12 applications, 8 converted
  band(95, 12, 8)

  const raise = database.getThresholdRecommendation(50)
  check('a clear separation produces a recommendation', raise.verdict, 'change')
  check('and it is to raise the threshold', raise.direction, 'raise')
  check('to the boundary where conversion actually starts', raise.recommended, 70)
  check('the headline names both numbers', /from 50% to 70%/.test(raise.headline), true)
  check('the detail carries both sample sizes', /36 sent/.test(raise.detail), true)
  check('and the whole sample it drew on', /Across 72 sent applications/.test(raise.detail), true)
  // Never applied for the user. See the note on getThresholdRecommendation.
  check('and it is never applied automatically', raise.applied, false)

  // ── A threshold already in the right place ─────────────────────
  const settled = database.getThresholdRecommendation(70)
  check('a threshold on the evidence is left alone', settled.verdict, 'no-change')
  check('and says so rather than staying silent', /where the evidence puts it/.test(settled.headline), true)
  check('a threshold within a band of it is also left alone',
    database.getThresholdRecommendation(65).verdict, 'no-change')

  // ── Lowering ───────────────────────────────────────────────────
  // The case worth catching: a threshold set too high is silently discarding
  // jobs that were converting perfectly well, and the user never learns about
  // the job they did not apply for.
  const lower = database.getThresholdRecommendation(95)
  check('a threshold well above the line is flagged', lower.verdict, 'change')
  check('and the direction is down', lower.direction, 'lower')
  check('to the same boundary the evidence supports', lower.recommended, 70)
  check('and the consequence is stated in those terms',
    /turning down scores that have been converting/.test(lower.detail), true)

  // ── An offer counts as a conversion ────────────────────────────
  // Otherwise the best outcomes available would depress the rate that is meant
  // to be measuring them.
  const before = database.getThresholdRecommendation(50).recommended
  band(75, 0, 0)
  add({ score: 75, status: 'offer' })
  check('an offer does not push the recommended line upward',
    database.getThresholdRecommendation(50).recommended <= before, true)

  // ── A band too small to count is ignored ───────────────────────
  // One spectacular result from three applications must not move the line.
  const withNoise = database.getThresholdRecommendation(50)
  add({ score: 5, status: 'offer' })
  check('a band under the floor does not change the answer',
    database.getThresholdRecommendation(50).recommended, withNoise.recommended)

  // ── No spread ──────────────────────────────────────────────────
  // Everything in one band cannot be compared with anything, and saying nothing
  // is the honest answer.
  const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-threshold-flat-'))
  process.env.HIRO_CONFIG_DIR = flatDir
  delete require.cache[require.resolve('../electron/services/database')]
  delete require.cache[require.resolve('../electron/services/config')]
  const flatDb = require('../electron/services/database')
  await flatDb.init()
  for (let i = 0; i < 40; i++) {
    flatDb.insertApplication({
      job_title: `Flat ${i}`, company: `Flat Co ${i}`, platform: 'Seek', salary: '',
      job_url: `https://flat.test/${i}`, job_description: 'd', match_score: 75,
      match_explanation: '', tailored_resume: '', cover_letter: '', screening_qa: [],
      status: 'applied', closing_date: null, resume_id: null, resume_name: null, recruiter_email: '',
    })
  }
  const flat = flatDb.getThresholdRecommendation(70)
  check('every application in one band yields no recommendation', flat.verdict, 'insufficient')
  check('and says why, rather than reporting no data', /too narrow a range/.test(flat.detail), true)

  for (const dir of [DIR, flatDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
