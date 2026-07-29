// Review mode: a job that clears the threshold is drafted in full but parked
// as 'held' instead of being submitted, and nothing reaches an employer until
// the user approves it. Also covers attention-job de-duplication, which is what
// stopped a failed apply from being re-drafted on every subsequent scan.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-review-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()

;(async () => {
  await db.init()

  // ── Held drafts ────────────────────────────────────────────────
  db.insertApplication({
    job_title: 'Senior Engineer', company: 'Acme', platform: 'Seek',
    job_url: 'https://example.com/1', job_description: 'jd', match_score: 91,
    tailored_resume: 'TAILORED', cover_letter: 'LETTER', screening_qa: [],
    status: 'held', resume_id: 'r1', resume_name: 'Backend CV',
  })
  db.insertApplication({
    job_title: 'Staff Engineer', company: 'Globex', platform: 'Seek',
    job_url: 'https://example.com/2', job_description: 'jd', match_score: 84,
    tailored_resume: 'T2', cover_letter: 'L2', screening_qa: [],
    status: 'held', resume_id: 'r2', resume_name: 'Platform CV',
  })

  const held = db.getHeldApplications()
  check('held drafts are listed', held.length, 2)
  check('highest match first', held[0].job_title, 'Senior Engineer')
  check('held_at is stamped', typeof held[0].held_at, 'string')
  check('resume attribution is recorded', held[0].resume_name, 'Backend CV')
  // The list query is slim by design — documents come from getApplication.
  check('list rows omit the documents', held[0].tailored_resume, undefined)
  check('full row still carries them', db.getApplication(held[0].id).tailored_resume, 'TAILORED')

  // Approving submits the documents already drafted.
  db.markHeldApplied(held[0].id, [{ question: 'Work rights?', answer: 'Yes' }])
  const approved = db.getApplication(held[0].id)
  check('approved draft becomes applied', approved.status, 'applied')
  check('held_at is cleared on approval', approved.held_at, null)
  check('screening answers are stored', JSON.parse(approved.screening_qa)[0].answer, 'Yes')
  check('approval is recorded in the timeline', db.getStatusHistory(held[0].id).some(h => h.status === 'applied'), true)

  // Rejecting files it as skipped so the next scan doesn't re-draft it.
  db.rejectHeldApplication(held[1].id)
  check('rejected draft becomes skipped', db.getApplication(held[1].id).status, 'skipped')
  check('review queue is now empty', db.getHeldApplications().length, 0)

  // ── Attention-job de-duplication ───────────────────────────────
  // A failed apply leaves a row in attention_jobs but NOT in applications, so
  // hasJobUrl alone didn't recognise it and every scan re-processed the job.
  const url = 'https://example.com/failed'
  db.insertAttentionJob({
    job_title: 'Ops Lead', company: 'Initech', platform: 'Indeed',
    job_url: url, job_description: 'jd', match_score: 88, reason: 'form error',
  })
  check('attention job is not in applications', db.hasJobUrl(url), false)
  check('but the scan recognises it as seen', db.hasSeenJobUrl(url), true)

  db.insertAttentionJob({
    job_title: 'Ops Lead', company: 'Initech', platform: 'Indeed',
    job_url: url, job_description: 'jd', match_score: 88, reason: 'form error',
  })
  check('re-inserting the same URL does not duplicate', db.getAttentionJobs().length, 1)

  // A dismissed job stays "seen" — the user already ruled on it and does not
  // want it resurrected by the next scan.
  db.dismissAttentionJob(db.getAttentionJobs()[0].id)
  check('dismissed jobs are still treated as seen', db.hasSeenJobUrl(url), true)

  // ── Resume conversion ──────────────────────────────────────────
  const conv = db.getResumeConversion()
  const backend = conv.find(c => c.resumeId === 'r1')
  check('conversion is grouped by resume', !!backend, true)
  check('sent count is per resume', backend.applied, 1)
  // One application is far too small a sample to report a rate from.
  check('a tiny sample is flagged as not significant', backend.significant, false)

  done()
})()
