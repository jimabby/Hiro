// Which generated version actually won.
//
// The snapshot trail could already show what changed between two versions. It
// could not show which one got the interview — so a model comparison was a
// reading exercise rather than a measurement. These tests pin the two things
// that make the answer trustworthy: one application counts once per model, and
// a sample too small to mean anything reports no rate at all.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-versions-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

function add(jobUrl, { provider = 'claude', model = 'sonnet', status = 'applied', score = 80 } = {}) {
  db.insertApplication({
    job_title: 'Engineer', company: 'Example', platform: 'Seek', job_url: jobUrl,
    salary: '', job_description: '', match_score: score, match_explanation: '',
    base_resume: 'base text', tailored_resume: 'tailored text', cover_letter: 'letter',
    screening_qa: [], status, provider, model,
  })
  return db.getApplications().find(a => a.job_url === jobUrl).id
}

async function main() {
  await db.init()

  check('no snapshots is an empty comparison', db.getVersionOutcomes().length, 0)

  // Ten applications from one model, four of which reached interview or offer.
  for (let i = 0; i < 10; i++) {
    const status = i < 3 ? 'interview' : i === 3 ? 'offer' : 'rejected'
    add(`https://v/claude-${i}`, { provider: 'claude', model: 'sonnet', status })
  }

  const outcomes = db.getVersionOutcomes()
  check('one model is one row', outcomes.length, 1)
  check('the row is labelled by provider and model', outcomes[0].label, 'claude · sonnet')
  check('every sent application is counted', outcomes[0].sent, 10)
  check('interviews are counted', outcomes[0].interviews, 3)
  check('offers are counted separately', outcomes[0].offers, 1)
  // An offer implies an interview happened; counting it as a non-conversion
  // would make the best outcome depress the rate.
  check('an offer counts as a conversion', outcomes[0].converted, 4)
  check('the interview rate uses conversions', outcomes[0].interviewRate, 40)
  check('the average score is reported', outcomes[0].averageScore, 80)

  // Re-drafting the same job must not multiply its outcome. This is the failure
  // that would quietly make whichever model happened to retry most look best.
  const busy = db.getApplications().find(a => a.job_url === 'https://v/claude-0').id
  for (let i = 0; i < 4; i++) {
    db.recordSnapshot(busy, 'drafted', {
      base_resume: 'base', tailored_resume: `draft ${i}`, cover_letter: 'letter',
      provider: 'claude', model: 'sonnet', status: 'interview', match_score: 80,
    })
  }
  const afterRedraft = db.getVersionOutcomes()
  check('re-drafting does not inflate the sample', afterRedraft[0].sent, 10)
  check('re-drafting does not inflate conversions', afterRedraft[0].converted, 4)

  // A second model below the sample floor must report no rate rather than a
  // meaningless one — a single application at 100% is not a better model.
  add('https://v/gemini-0', { provider: 'gemini', model: 'flash', status: 'interview' })
  const twoModels = db.getVersionOutcomes()
  check('a second model gets its own row', twoModels.length, 2)
  const gemini = twoModels.find(v => v.provider === 'gemini')
  check('a tiny sample is counted', gemini.sent, 1)
  check('a tiny sample reports no rate', gemini.interviewRate, null)

  // Rows are ordered by sample size, so the most trustworthy row leads.
  check('the largest sample sorts first', twoModels[0].provider, 'claude')

  // Unsent rows are excluded: a held draft was never seen by an employer, so it
  // has no outcome to attribute to the model that wrote it.
  add('https://v/held', { provider: 'gemini', model: 'flash', status: 'held' })
  check('a held draft is not counted as sent',
    db.getVersionOutcomes().find(v => v.provider === 'gemini').sent, 1)

  // ─── Per-application view ──────────────────────────────────────
  const single = db.getApplicationVersionOutcome(busy)
  check('the application is identified', single.id, busy)
  check('the outcome is the live status', single.outcome, 'interview')
  check('its snapshots are returned oldest first',
    single.snapshots[0].taken_at <= single.snapshots[single.snapshots.length - 1].taken_at, true)
  check('the moment it converted is reported', typeof single.reachedInterviewAt, 'string')
  check('the version live at that moment is identified', typeof single.decisiveSnapshotId, 'number')

  // An application that never converted has no decisive version — which is
  // itself the answer to "did this version work".
  const lost = db.getApplications().find(a => a.job_url === 'https://v/claude-9').id
  const lostView = db.getApplicationVersionOutcome(lost)
  check('a rejected application reports its outcome', lostView.outcome, 'rejected')
  check('a rejected application has no decisive version', lostView.decisiveSnapshotId, null)
  check('a rejected application never reached interview', lostView.reachedInterviewAt, null)

  check('an unknown application returns nothing', db.getApplicationVersionOutcome(999999), null)

  done()
}

main()
