// Taking back a delete.
//
// Deleting an application is one click in a dense row of controls, and it took
// the tailored resume, the cover letter, the recruiter replies and the
// interview history with it. The only way back was restoring a whole backup,
// which reverts everything else done since — so in practice nobody did it for
// one misclicked row, and the row was simply gone.
//
// The delete now hands back everything it removed. What these pin is that
// "everything" really means everything: a restore that brought the application
// back without its history would be worse than no undo at all, because it
// looks like it worked.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-undo-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()

const makeApp = (title, url) => db.insertApplication({
  job_title: title, company: 'Acme', platform: 'Seek', job_url: url,
  job_description: 'jd', match_score: 80, base_resume: 'BASE',
  tailored_resume: 'TAILORED', cover_letter: 'LETTER', screening_qa: [],
  status: 'applied', resume_name: 'CV',
})

;(async () => {
  await db.init()

  // ── A single delete, with its dependents ───────────────────────
  const { id } = makeApp('Senior Engineer', 'https://example.com/1')
  db.updateApplicationStatus(id, 'interview')
  db.updateApplicationComment(id, 'Referred by a colleague')

  const beforeSnapshots = db.getSnapshots(id).length
  const beforeHistory = db.getStatusHistory(id).length
  check('the application has a status history', beforeHistory > 0, true)
  check('and a document snapshot', beforeSnapshots > 0, true)

  const deleted = db.deleteApplication(id)
  check('the delete succeeds', deleted.success, true)
  check('and the row is gone', db.getApplication(id), null)
  check('a tombstone is written so other devices agree', db.getTombstones().includes(id), true)
  check('the delete hands back what it removed', deleted.undo.applications.length, 1)

  const restored = db.restoreApplications(deleted.undo)
  check('the restore reports what it put back', restored.restored, 1)
  const back = db.getApplication(id)
  check('the application is back', !!back, true)
  // Same id, because every dependent row keys on it. A restore that renumbered
  // would silently orphan all of them.
  check('with the same id', back.id, id)
  check('and the documents it was carrying', back.tailored_resume, 'TAILORED')
  check('and the comment', back.comment, 'Referred by a colleague')
  check('and the status it was in', back.status, 'interview')
  check('its status history comes back too', db.getStatusHistory(id).length, beforeHistory)
  check('and its document snapshots', db.getSnapshots(id).length, beforeSnapshots)
  // Otherwise the next sync would agree with the tombstone and delete it again.
  check('the row is marked dirty so the restore propagates', back.cloud_dirty, 1)
  check('and the tombstone is withdrawn', db.getTombstones().includes(id), false)

  // ── Clear all ──────────────────────────────────────────────────
  makeApp('Platform Engineer', 'https://example.com/2')
  makeApp('Data Engineer', 'https://example.com/3')
  db.saveInterviewAnswer({ question: 'Tell me about a hard bug', answer: 'A race in the scheduler', source: 'user' })
  const countBefore = db.getApplications().length
  check('there is something to clear', countBefore >= 3, true)

  const cleared = db.clearAllApplications()
  check('clear-all empties the table', db.getApplications().length, 0)
  check('and captures every row', cleared.undo.applications.length, countBefore)
  // Clear-all also removes things that are not application-scoped. Restoring
  // the applications without them would be an undo that quietly loses the
  // interview answer bank, which is hand-written and not regenerable.
  check('including the interview answer bank',
    cleared.undo.global.interview_answers.length > 0, true)
  check('which clear-all really did remove', db.listInterviewAnswers().length, 0)

  db.restoreApplications(cleared.undo)
  check('every application comes back', db.getApplications().length, countBefore)
  check('and the answer bank is not lost', db.listInterviewAnswers().length > 0, true)
  check('and the documents survive the round trip',
    db.getApplication(db.getApplications()[0].id).cover_letter, 'LETTER')

  // ── Nothing to undo ────────────────────────────────────────────
  check('capturing nothing yields nothing', db.captureApplications([]), null)
  check('capturing an unknown id yields nothing', db.captureApplications([987654]), null)
  check('restoring nothing is not an error', db.restoreApplications(null).restored, 0)
  check('restoring an empty capture is not an error',
    db.restoreApplications({ applications: [] }).restored, 0)

  // ── Attention jobs ─────────────────────────────────────────────
  // An attention job has no snapshot trail at all, so a delete here is the one
  // that leaves nothing behind anywhere.
  db.insertAttentionJob({
    job_title: 'ML Engineer', company: 'Globex', platform: 'Seek',
    job_url: 'https://example.com/att', job_description: 'jd', match_score: 90,
    reason: 'Career board — submit manually',
    talking_points: ['Ask about the data platform'],
  })
  const attId = db.getAttentionJobs()[0].id
  const attDeleted = db.deleteAttentionJob(attId)
  check('the attention job is gone', db.getAttentionJobs().length, 0)
  check('and was captured', attDeleted.undo.attention_jobs.length, 1)

  db.restoreAttentionJobs(attDeleted.undo)
  check('the attention job comes back', db.getAttentionJobs().length, 1)
  const attBack = db.getAttentionJob(attId)
  check('with the same id', attBack.id, attId)
  check('and why it needed attention', attBack.reason, 'Career board — submit manually')
  check('and the talking points that cost a model call',
    attBack.talking_points, JSON.stringify(['Ask about the data platform']))

  const attCleared = db.clearAllAttentionJobs()
  check('clear-all empties them', db.getAttentionJobs().length, 0)
  db.restoreAttentionJobs(attCleared.undo)
  check('and they all come back', db.getAttentionJobs().length, 1)
  check('capturing no attention jobs yields nothing', db.captureAttentionJobs([]), null)
  check('restoring no attention jobs is not an error',
    db.restoreAttentionJobs(null).restored, 0)

  done()
})()
