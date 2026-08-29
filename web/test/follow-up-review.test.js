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
  check('and advances it to the next round', db.getApplication(inserted.id).follow_up_count, 1)
  check('and records when it went', !!db.getApplication(inserted.id).last_follow_up_at, true)

  // ── Declining ends the sequence ─────────────────────────────────
  // Only a 'held' draft keeps an application out of getApplicationsForFollowUp,
  // so a rejection that left the row untouched made it due again on the next
  // pass: the AI redrafted a message the user had already declined, every
  // weekday, forever, and it reappeared in the review queue each time.
  //
  // Now that there is more than one round, declining is MORE final than sending
  // rather than equivalent to it: sending advances a stage, declining stops the
  // whole sequence. Merely advancing a stage on a rejection would bring the same
  // unwanted email back a fortnight later, which is the user's answer being
  // ignored on a delay.
  const second = db.insertApplication({
    job_title: 'Analyst', company: 'Globex', platform: 'Seek', job_url: 'https://example.test/followup-2',
    job_description: '', match_score: 88, tailored_resume: 'resume', status: 'applied', recruiter_email: 'hr@globex.test',
  })
  db.saveFollowUpDraft({ applicationId: second.id, recipient: 'hr@globex.test', subject: 'Follow-up', body: 'Checking in' })
  const rejected = db.getFollowUpDrafts().find(d => d.application_id === second.id)
  db.resolveFollowUpDraft(rejected.id, 'rejected')
  check('rejected draft leaves the review queue', db.getFollowUpDrafts().length, 0)
  check('rejected follow-up is never redrafted', db.getApplicationsForFollowUp(0).length, 0)
  check('rejection stops the whole sequence', db.getApplication(second.id).follow_up_stopped, 1)
  // Not counted as sent, because it was not sent — the count is what decides
  // which letter the next round writes, and a declined draft is not a letter
  // the employer has seen.
  check('and is not counted as a follow-up that went out', db.getApplication(second.id).follow_up_count, 0)
  // Even with several rounds configured, a stopped application stays stopped.
  check('a stopped application is not due for any later round',
    db.getApplicationsForFollowUp(0, { maxCount: 5, intervalDays: 0 })
      .filter(j => j.id === second.id).length, 0)
  check('until the user changes their mind', (() => {
    db.resumeFollowUps(second.id)
    return db.getApplicationsForFollowUp(0, { maxCount: 5, intervalDays: 0 })
      .some(j => j.id === second.id)
  })(), true)
  db.stopFollowUps(second.id)

  // ── Several rounds, spaced from the last one ────────────────────
  const third = db.insertApplication({
    job_title: 'Designer', company: 'Initech', platform: 'Seek', job_url: 'https://example.test/followup-3',
    job_description: '', match_score: 80, tailored_resume: 'resume', status: 'applied', recruiter_email: 'jobs@initech.test',
  })
  const dueNow = (opts) => db.getApplicationsForFollowUp(0, opts).filter(j => j.id === third.id)
  const twoRounds = { maxCount: 2, intervalDays: 0 }

  check('the first round is due', dueNow(twoRounds).length, 1)
  check('and it is round one', dueNow(twoRounds)[0].follow_up_stage, 1)
  db.markFollowUpSent(third.id)
  check('the second round is due once the interval has passed', dueNow(twoRounds).length, 1)
  check('and it knows it is round two', dueNow(twoRounds)[0].follow_up_stage, 2)
  db.markFollowUpSent(third.id)
  check('the sequence stops at the configured count', dueNow(twoRounds).length, 0)
  // The ceiling is a setting, not a property of the row: raising it makes the
  // same application due again.
  check('raising the limit makes another round due', dueNow({ maxCount: 3, intervalDays: 0 }).length, 1)
  check('and it is round three', dueNow({ maxCount: 3, intervalDays: 0 })[0].follow_up_stage, 3)
  // One round is exactly the old behaviour: one nudge, ever.
  check('a limit of one is the original single-nudge behaviour',
    dueNow({ maxCount: 1, intervalDays: 0 }).length, 0)
  // And the interval really does hold it back — measured from the last
  // follow-up, not from the application, or every remaining round would come
  // due the moment the first went out.
  check('a round is not due before the interval elapses',
    dueNow({ maxCount: 3, intervalDays: 14 }).length, 0)

  check('resolving a draft that does not exist fails cleanly', db.resolveFollowUpDraft(9999, 'sent').success, false)
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
