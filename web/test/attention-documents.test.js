// The documents a Needs Attention job was routed here WITH.
//
// A job lands on this page precisely because it cannot be submitted
// automatically — a career board with a custom form, a failed submit, a draft
// the fabrication guard stopped. The applicator tailors the resume and writes
// the cover letter first, at three separate call sites, and sets them on the
// job before routing it.
//
// The table had no columns for either, so insertAttentionJob dropped both. The
// README promised "matches land in Needs Attention with the tailored resume and
// cover letter already written", and the message the user is shown says in as
// many words that they are "ready below". Both were false: the model calls were
// paid for and the output discarded, and the one thing needed to finish the
// application by hand was the thing thrown away.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-attention-docs-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()

const RESUME = 'Jim Smith\nSenior Engineer\nShipped a billing service'
const LETTER = 'Dear Hiring Manager,\n\nI am writing to apply for the Data Engineer role.'

;(async () => {
  await db.init()

  db.insertAttentionJob({
    job_title: 'Data Engineer', company: 'Acme', platform: 'Greenhouse',
    job_url: 'https://boards.greenhouse.io/acme/jobs/1', job_description: 'jd',
    match_score: 88, reason: 'Company career board — submit manually',
    talking_points: ['Ask about the data platform'],
    tailored_resume: RESUME, cover_letter: LETTER,
  })

  const job = db.getAttentionJobs()[0]
  check('the job is recorded', job.job_title, 'Data Engineer')
  // The whole point of routing it here rather than dropping it.
  check('the tailored resume survives the insert', job.tailored_resume, RESUME)
  check('and the cover letter', job.cover_letter, LETTER)
  check('reading one job back gives the same documents',
    db.getAttentionJob(job.id).tailored_resume, RESUME)

  // A job routed here for a reason that involves no drafting — a scrape that
  // could not read the description — has no documents, and must not fail or
  // store the string "undefined".
  db.insertAttentionJob({
    job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek',
    job_url: 'https://example.com/2', job_description: 'jd', match_score: 70,
    reason: 'Could not read the application form',
  })
  const bare = db.getAttentionJobs().find(j => j.job_title === 'Platform Engineer')
  check('a job with no drafted documents stores an empty resume', bare.tailored_resume, '')
  check('and an empty cover letter', bare.cover_letter, '')

  // Undo has to carry them too, or taking back a delete returns the row without
  // the thing that made it worth keeping.
  const deleted = db.deleteAttentionJob(job.id)
  db.restoreAttentionJobs(deleted.undo)
  const restored = db.getAttentionJob(job.id)
  check('an undone delete brings the documents back', restored.tailored_resume, RESUME)
  check('including the cover letter', restored.cover_letter, LETTER)

  done()
})()
