// Database behaviour that the app depends on but nothing else guards:
//
//  - the company cooldown, which used to be a permanent ban (one application
//    silently blacklisted an employer forever)
//  - cascading deletes, which used to leave interview_prep rows orphaned with
//    no way to remove them
//  - score-band conversion, the number the apply threshold should be tuned on
//
// Runs against a real sql.js database in a throwaway directory, so the SQL is
// actually executed rather than mocked.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-db-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

// Backdate a row on disk, then reload the module's database from that file.
// The cooldown is a time window, and the only way to exercise its expiry is
// with a row that is genuinely older than the window.
async function backdate(jobUrl, daysAgo) {
  const SQL = await require('sql.js')()
  const file = path.join(TMP, 'autoapply.db')
  const handle = new SQL.Database(fs.readFileSync(file))
  handle.run(
    "UPDATE applications SET applied_at = datetime('now', '-' || ? || ' days') WHERE job_url = ?",
    [daysAgo, jobUrl]
  )
  fs.writeFileSync(file, Buffer.from(handle.export()))
  handle.close()
  await db.init() // re-open from the modified file
}

async function main() {
  await db.init()

  // ── Company cooldown ────────────────────────────────────────────
  db.insertApplication({
    job_title: 'Backend Engineer', company: 'Atlassian', platform: 'Seek',
    job_url: 'https://x/1', job_description: '', match_score: 90,
    tailored_resume: '', screening_qa: [], status: 'applied',
  })

  check('cooldown blocks the same company inside the window',
    !!db.findRecentApplicationToCompany('Atlassian', 30), true)
  check('cooldown reports which role blocked it',
    db.findRecentApplicationToCompany('Atlassian', 30)?.job_title, 'Backend Engineer')
  check('cooldown is case-insensitive',
    !!db.findRecentApplicationToCompany('atlassian', 30), true)
  check('cooldown does not block a different company',
    db.findRecentApplicationToCompany('Canva', 30), null)

  // The regression this fix exists for: 0 must mean "no cooldown", so a user
  // can apply to several roles at one company on purpose.
  check('cooldown of 0 disables the block',
    db.findRecentApplicationToCompany('Atlassian', 0), null)
  check('cooldown of undefined disables the block',
    db.findRecentApplicationToCompany('Atlassian', undefined), null)
  check('cooldown of a non-number disables the block',
    db.findRecentApplicationToCompany('Atlassian', 'abc'), null)

  // A skipped row is not an application and must not trigger the cooldown.
  db.insertApplication({
    job_title: 'Designer', company: 'Figma', platform: 'Seek',
    job_url: 'https://x/2', job_description: '', match_score: 40,
    tailored_resume: '', screening_qa: [], status: 'skipped',
  })
  check('a skipped job does not trigger the cooldown',
    db.findRecentApplicationToCompany('Figma', 30), null)

  // The core of the fix: an application older than the window must stop
  // blocking. Previously any application blocked the company permanently.
  await backdate('https://x/1', 60)
  check('an application older than the window no longer blocks',
    db.findRecentApplicationToCompany('Atlassian', 30), null)
  check('a wider window still catches the same old application',
    !!db.findRecentApplicationToCompany('Atlassian', 90), true)

  // Restore it to "today" so the cascade-delete section below still has a
  // freshly-applied row to work with.
  await backdate('https://x/1', 0)
  check('cooldown blocks again once the row is recent',
    !!db.findRecentApplicationToCompany('Atlassian', 30), true)

  // ── Closing dates ───────────────────────────────────────────────
  db.insertApplication({
    job_title: 'Data Engineer', company: 'Canva', platform: 'Seek',
    job_url: 'https://x/3', job_description: '', match_score: 88,
    tailored_resume: '', screening_qa: [], status: 'applied',
    closing_date: '2026-06-01',
  })
  const canva = db.getApplications({}).find(a => a.company === 'Canva')
  check('closing date is stored on insert', canva.closing_date, '2026-06-01')

  db.updateClosingDate(canva.id, '2026-07-15')
  check('closing date can be corrected',
    db.getApplication(canva.id).closing_date, '2026-07-15')
  check('correcting a closing date marks the row for cloud sync',
    db.getApplication(canva.id).cloud_dirty, 1)

  // ── Attention jobs sort by deadline ─────────────────────────────
  db.insertAttentionJob({ job_title: 'Late', company: 'A', platform: 'Seek', job_url: 'u1', job_description: '', match_score: 70, closing_date: '2026-09-01' })
  db.insertAttentionJob({ job_title: 'Soon', company: 'B', platform: 'Seek', job_url: 'u2', job_description: '', match_score: 70, closing_date: '2026-04-01' })
  db.insertAttentionJob({ job_title: 'Unknown', company: 'C', platform: 'Seek', job_url: 'u3', job_description: '', match_score: 70 })
  check('attention jobs surface the soonest deadline first',
    db.getAttentionJobs().map(j => j.job_title), ['Soon', 'Late', 'Unknown'])

  // ── Cascading deletes ───────────────────────────────────────────
  const target = db.getApplications({}).find(a => a.company === 'Atlassian')
  db.saveInterviewPrep(target.id, ['Q1', 'Q2'])
  db.addInterviewEvent({ applicationId: target.id, scheduledAt: '2026-04-01 10:00:00' })
  db.updateApplicationStatus(target.id, 'interview')

  check('interview prep saved', !!db.getInterviewPrep(target.id), true)
  check('interview event saved', db.getInterviewEvents(target.id).length, 1)
  check('status history recorded', db.getStatusHistory(target.id).length >= 2, true)

  db.deleteApplication(target.id)
  check('deleting an application removes its interview prep',
    db.getInterviewPrep(target.id), null)
  check('deleting an application removes its interview events',
    db.getInterviewEvents(target.id).length, 0)
  check('deleting an application removes its status history',
    db.getStatusHistory(target.id).length, 0)

  // ── Interview events ────────────────────────────────────────────
  const canvaId = db.getApplication(canva.id).id
  db.upsertDetectedInterview({ applicationId: canvaId, scheduledAt: '2026-04-10 14:00:00', hasTime: true })
  db.upsertDetectedInterview({ applicationId: canvaId, scheduledAt: '2026-04-10 14:00:00', hasTime: true })
  check('re-detecting the same interview does not duplicate it',
    db.getInterviewEvents(canvaId).length, 1)

  db.upsertDetectedInterview({ applicationId: canvaId, scheduledAt: '2026-04-11 09:00:00', hasTime: true })
  check('a rescheduled interview updates in place',
    db.getInterviewEvents(canvaId).length, 1)
  check('the updated time is stored',
    db.getInterviewEvents(canvaId)[0].scheduled_at, '2026-04-11 09:00:00')

  // A time the user typed must not be overwritten by a later auto-detection.
  db.deleteInterviewEvent(db.getInterviewEvents(canvaId)[0].id)
  db.addInterviewEvent({ applicationId: canvaId, scheduledAt: '2026-05-01 12:00:00', source: 'manual' })
  db.upsertDetectedInterview({ applicationId: canvaId, scheduledAt: '2026-04-20 08:00:00' })
  check('a manual interview time is never overwritten by detection',
    db.getInterviewEvents(canvaId)[0].scheduled_at, '2026-05-01 12:00:00')
  check('detection does not add a second event alongside a manual one',
    db.getInterviewEvents(canvaId).length, 1)

  // ── Score-band conversion ───────────────────────────────────────
  for (const [i, [score, status]] of [
    [92, 'interview'], [95, 'offer'], [91, 'rejected'], [93, 'applied'],
    [72, 'rejected'], [75, 'rejected'], [71, 'applied'],
    [55, 'interview'],
  ].entries()) {
    db.insertApplication({
      job_title: `Job ${i}`, company: `Co${i}`, platform: 'Seek',
      job_url: `https://conv/${i}`, job_description: '', match_score: score,
      tailored_resume: '', screening_qa: [], status,
    })
  }

  const bands = db.getScoreBandConversion()
  const band = (lo) => bands.find(b => b.lo === lo)

  check('90s band counts every submitted application', band(90).applied, 4)
  check('90s band counts interviews and offers as conversions', band(90).converted, 2)
  check('90s band conversion rate', band(90).conversionRate, 50)
  check('70s band has no conversions', band(70).converted, 0)
  check('70s band conversion rate is zero, not null', band(70).conversionRate, 0)
  check('an empty band reports null rather than 0%', band(20).conversionRate, null)
  check('bands cover the full range', bands.length, 10)

  // Skipped rows were never submitted, so they cannot have converted and must
  // not dilute the denominator.
  db.insertApplication({
    job_title: 'Skipped high scorer', company: 'Zed', platform: 'Seek',
    job_url: 'https://conv/skip', job_description: '', match_score: 92,
    tailored_resume: '', screening_qa: [], status: 'skipped',
  })
  check('skipped jobs are excluded from conversion',
    db.getScoreBandConversion().find(b => b.lo === 90).applied, 4)

  // ── Orphan sweep ────────────────────────────────────────────────
  db.saveInterviewPrep(999999, ['orphan'])
  const swept = db.pruneOrphanedRows()
  check('orphan sweep removes prep with no application', swept.removedInterviewPreps >= 1, true)
  check('orphan sweep leaves live rows alone', db.getInterviewEvents(canvaId).length, 1)

  done()
}

main().catch(err => { console.error(err); process.exit(1) })
