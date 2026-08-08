const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-followup-review-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) }, './logger': { append: () => {} } })

const db = service('database')
const { check, done } = createChecker()

;(async () => {
  await db.init()
  const inserted = db.insertApplication({
    job_title: 'Engineer', company: 'Acme', platform: 'Seek', job_url: 'https://example.test/followup',
    job_description: '', match_score: 90, tailored_resume: 'resume', status: 'applied', recruiter_email: 'recruiter@acme.test',
  })
  db.saveFollowUpDraft({ applicationId: inserted.id, recipient: 'recruiter@acme.test', subject: 'Follow-up', body: 'Hello there' })
  check('follow-up is held for review', db.getFollowUpDrafts().length, 1)
  check('draft carries the application context', db.getFollowUpDrafts()[0].company, 'Acme')
  check('a held draft prevents another AI draft pass', db.getApplicationsForFollowUp(0).length, 0)
  db.resolveFollowUpDraft(db.getFollowUpDrafts()[0].id, 'sent')
  check('sent draft leaves the review queue', db.getFollowUpDrafts().length, 0)
  check('sent follow-up is not due again', db.getApplicationsForFollowUp(0).length, 0)
  check('resolving marks the application, without a separate call', db.getApplication(inserted.id).follow_up_sent, 1)

  // ── Declining is as final as sending ────────────────────────────
  // Only a 'held' draft keeps an application out of getApplicationsForFollowUp,
  // so a rejection that left follow_up_sent at 0 made the row due again on the
  // next pass: the AI redrafted a message the user had already declined, every
  // weekday, forever, and it reappeared in the review queue each time.
  const second = db.insertApplication({
    job_title: 'Analyst', company: 'Globex', platform: 'Seek', job_url: 'https://example.test/followup-2',
    job_description: '', match_score: 88, tailored_resume: 'resume', status: 'applied', recruiter_email: 'hr@globex.test',
  })
  db.saveFollowUpDraft({ applicationId: second.id, recipient: 'hr@globex.test', subject: 'Follow-up', body: 'Checking in' })
  const rejected = db.getFollowUpDrafts().find(d => d.application_id === second.id)
  db.resolveFollowUpDraft(rejected.id, 'rejected')
  check('rejected draft leaves the review queue', db.getFollowUpDrafts().length, 0)
  check('rejected follow-up is never redrafted', db.getApplicationsForFollowUp(0).length, 0)
  check('rejection settles the application too', db.getApplication(second.id).follow_up_sent, 1)

  check('resolving a draft that does not exist fails cleanly', db.resolveFollowUpDraft(9999, 'sent').success, false)
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
