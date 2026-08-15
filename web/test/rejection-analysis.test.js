// Where applications actually die.
//
// "How many rejections" is a number nobody can act on. The split that matters —
// screened out before anyone spoke to you, versus rejected after interviewing —
// points at two completely different problems, so it has to be derived
// correctly or the advice built on it is worse than no advice.
//
// The stage is recovered from status_history, never stored, so these tests
// drive real status transitions rather than setting a column.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-rejection-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

function add(jobUrl, { title = 'Engineer', company = 'Example', score = 80, resume = 'Default resume', platform = 'Seek' } = {}) {
  db.insertApplication({
    job_title: title, company, platform, job_url: jobUrl, salary: '',
    job_description: '', match_score: score, match_explanation: '',
    tailored_resume: '', screening_qa: [], status: 'applied',
    resume_id: resume, resume_name: resume,
  })
  return db.getApplications().find(a => a.job_url === jobUrl).id
}

async function main() {
  await db.init()

  // Empty database: the shape must still be complete, or the page it feeds
  // has to defend against nulls everywhere.
  const empty = db.getRejectionAnalysis()
  check('an empty history reports zero rejections', empty.total, 0)
  check('an empty history still returns arrays', Array.isArray(empty.byBand) && Array.isArray(empty.byResume), true)
  check('an empty history has no median', empty.medianDaysToRejection, null)

  // Screened out: applied → rejected, no interview in between.
  const screened = add('https://x/1', { score: 85, resume: 'Generic resume' })
  db.updateApplicationStatus(screened, 'rejected')

  // Rejected after interviewing. The interview came first, so this is a
  // late-stage loss even though the row now reads simply "rejected".
  const afterInterview = add('https://x/2', { score: 90, resume: 'Targeted resume' })
  db.updateApplicationStatus(afterInterview, 'interview')
  db.updateApplicationStatus(afterInterview, 'rejected')

  // Reached offer, then rejected. Also late-stage — an offer implies an
  // interview happened, and reading only for 'interview' would misfile it.
  const afterOffer = add('https://x/3', { score: 95, resume: 'Targeted resume' })
  db.updateApplicationStatus(afterOffer, 'offer')
  db.updateApplicationStatus(afterOffer, 'rejected')

  const a = db.getRejectionAnalysis()
  check('every rejection is counted', a.total, 3)
  check('a rejection with no interview is pre-interview', a.preInterview, 1)
  check('a rejection after an interview is post-interview', a.postInterview, 2)
  check('the two stages account for every rejection', a.preInterview + a.postInterview, a.total)

  // The stage rule itself, isolated from the query.
  check('history with no interview reads as pre-interview',
    db.rejectionStageFor([{ status: 'applied' }, { status: 'rejected' }]), 'pre-interview')
  check('an offer in history reads as post-interview',
    db.rejectionStageFor([{ status: 'offer' }, { status: 'rejected' }]), 'post-interview')
  check('an empty history reads as pre-interview',
    db.rejectionStageFor([]), 'pre-interview')

  // Segmentation. The resume that only ever loses at screening is the single
  // most actionable thing in here, so it has to be attributed correctly.
  const generic = a.byResume.find(r => r.resume === 'Generic resume')
  const targeted = a.byResume.find(r => r.resume === 'Targeted resume')
  check('the screened-out resume is attributed', generic.preInterview, 1)
  check('the screened-out resume has no late losses', generic.postInterview, 0)
  check('the interviewing resume is attributed', targeted.postInterview, 2)
  check('resume segments sum to the total',
    a.byResume.reduce((n, r) => n + r.total, 0), a.total)

  // Score bands, so a threshold that disagrees with employers is visible.
  check('score bands sum to the total', a.byBand.reduce((n, b) => n + b.total, 0), a.total)
  check('a 90% score lands in the 90–99 band',
    a.byBand.find(b => b.band === '90–99%').total, 2)

  // An unscored rejection must be bucketed, not dropped — silently losing rows
  // from an analysis is worse than showing an "unscored" row.
  const unscored = add('https://x/4', { score: null })
  db.updateApplicationStatus(unscored, 'rejected')
  const withUnscored = db.getRejectionAnalysis()
  check('an unscored rejection is still counted', withUnscored.total, 4)
  check('an unscored rejection gets its own band',
    withUnscored.byBand.find(b => b.band === 'Unscored').total, 1)
  check('score bands still sum to the total',
    withUnscored.byBand.reduce((n, b) => n + b.total, 0), withUnscored.total)

  // Platform attribution.
  check('platform segments sum to the total',
    withUnscored.byPlatform.reduce((n, p) => n + p.total, 0), withUnscored.total)

  // Insights. Below the sample floor it must say so rather than generalising
  // from four rows.
  check('a small sample is reported as a small sample',
    withUnscored.insights[0].kind, 'sample')

  // Past the floor, the stage insight leads.
  for (let i = 5; i <= 12; i++) {
    const id = add(`https://x/${i}`, { score: 85 })
    db.updateApplicationStatus(id, 'interview')
    db.updateApplicationStatus(id, 'rejected')
  }
  const big = db.getRejectionAnalysis()
  check('a real sample produces a stage insight', big.insights[0].kind, 'stage')
  check('a mostly-post-interview pattern is named as such',
    /after the interview/.test(big.insights[0].title), true)
  check('every insight carries a next step',
    big.insights.every(i => typeof i.detail === 'string' && i.detail.length > 0), true)

  // Sent and interviewed counts give the rates their denominators.
  check('the sent count excludes nothing that was sent', big.sent >= big.total, true)

  // A non-rejected application must never appear in the analysis.
  add('https://x/live')
  check('a live application is not counted as a rejection',
    db.getRejectionAnalysis().total, big.total)

  done()
}

main()
