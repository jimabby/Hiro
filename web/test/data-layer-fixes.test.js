// Regressions in the database layer that each produced a wrong number or a lost
// row without any error: a re-submitted job dated weeks ago, an export that
// ignored the search box, deleted résumés that stayed on disk, withdrawals
// counted as failures, rule-routed jobs counted in an A/B test, and timestamps
// in two formats compared as strings.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-data-layer-'))
process.on('exit', () => { try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }) } catch {} })
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()

const make = (over = {}) => db.insertApplication({
  job_title: 'Engineer', company: 'Acme', platform: 'Seek', job_url: `https://x.test/${Math.random()}`,
  job_description: 'jd', match_score: 80, status: 'applied', ...over,
})
const row = (id) => db.getApplication(id)

;(async () => {
  await db.init()

  // ── 13: a skipped job submitted later is dated when it was sent ──
  const skipped = make({ status: 'skipped' })
  // Backdate it, as a job skipped a month ago would be.
  db.restoreApplications({ applications: [{ ...row(skipped.id), applied_at: '2026-01-01 09:00:00' }], children: {} })
  db.updateApplicationAfterApply(skipped.id, 'T', 'C', [])
  check('applying a previously skipped job re-stamps applied_at', row(skipped.id).applied_at > '2026-01-02', true)
  const applied = make()
  db.restoreApplications({ applications: [{ ...row(applied.id), applied_at: '2026-01-01 09:00:00' }], children: {} })
  db.updateApplicationAfterApply(applied.id, 'T2', 'C2', [])
  check('re-saving an already applied job keeps its date', row(applied.id).applied_at, '2026-01-01 09:00:00')

  // ── 14: the export honours the search box ────────────────────────
  make({ job_title: 'Data Scientist', company: 'Globex' })
  make({ job_title: 'Barista', company: 'Cafe 100%' })
  const titles = (filters) => db.getApplicationsList(filters).map(a => a.job_title).sort()
  check('search matches the title, case-insensitively', titles({ search: 'data sci' }), ['Data Scientist'])
  check('search matches the company', titles({ search: 'GLOBEX' }), ['Data Scientist'])
  check('LIKE wildcards are literal', titles({ search: '100%' }), ['Barista'])
  check('an underscore is literal too', titles({ search: '_' }), [])
  check('an empty search filters nothing', db.getApplicationsList({ search: '' }).length, db.getApplicationsList({}).length)

  // ── 9: snapshots go with the application, and come back with undo ──
  const docs = make({ tailored_resume: 'TAILORED', cover_letter: 'LETTER' })
  check('the application has a snapshot', db.getSnapshots(docs.id).length, 1)
  const { undo } = db.deleteApplication(docs.id)
  check('deleting it deletes its snapshots', db.getSnapshots(docs.id).length, 0)
  db.restoreApplications(undo)
  check('undo brings the snapshots back', db.getSnapshots(docs.id).length, 1)
  db.recordSnapshot(999999, 'submitted', { tailored_resume: 'ORPHAN' })
  db.pruneOrphanedRows()
  check('the orphan sweep removes snapshots with no application', db.getSnapshots(999999).length, 0)

  // ── 10: withdrawn is not a failed conversion ─────────────────────
  for (let i = 0; i < 2; i++) make({ match_score: 95, status: 'interview', resume_id: 'r-w', resume_name: 'W' })
  make({ match_score: 95, status: 'withdrawn', resume_id: 'r-w', resume_name: 'W' })
  const band = db.getScoreBandConversion().find(b => b.lo === 90)
  check('a withdrawal is not in the score band denominator', band.applied, 2)
  check('so the band converts at 100%', band.conversionRate, 100)
  const resume = db.getResumeConversion().find(r => r.resumeId === 'r-w')
  check('nor in the résumé conversion denominator', resume.applied, 2)

  // ── 11 + 12: only randomised applications count in an A/B arm ────
  // Started "now" as main.js stamps it: an ISO string.
  const startedAt = new Date(Date.now() - 60 * 1000).toISOString()
  make({ resume_id: 'A', experiment_arm: 'A', status: 'interview' })
  make({ resume_id: 'A', experiment_arm: 'A', status: 'rejected' })
  make({ resume_id: 'A', status: 'interview' }) // a routing rule sent this one
  make({ resume_id: 'B', experiment_arm: 'B', status: 'withdrawn' })
  make({ resume_id: 'B', experiment_arm: 'B', status: 'applied' })
  const [armA, armB] = db.getResumeExperimentArms('A', 'B', startedAt)
  check('a rule-routed application is not in the arm', armA.sent, 2)
  check('the arm counts its conversion', armA.converted, 1)
  check('a withdrawal is not in the arm either', armB.sent, 1)
  // The bug: "2026-…T…Z" sorts after every "2026-… …" on the same day, so the
  // whole first day of an experiment fell outside it.
  const today = new Date().toISOString().slice(0, 10)
  check('an ISO start the same day still includes that day',
    db.getResumeExperimentArms('A', 'B', `${today}T00:00:00.000Z`)[0].sent, 2)

  // ── 12: one timestamp format, whatever the cloud sends ───────────
  check('ISO with offset becomes SQLite UTC', db.toSqliteTime('2026-10-16T05:00:00+00:00'), '2026-10-16 05:00:00')
  check('another zone is converted to UTC', db.toSqliteTime('2026-10-16T15:00:00+10:00'), '2026-10-16 05:00:00')
  check('SQLite time is left alone', db.toSqliteTime('2026-10-16 05:00:00'), '2026-10-16 05:00:00')
  check('a plain date is left alone', db.toSqliteTime('2026-10-16'), '2026-10-16')
  check('nothing is nothing', db.toSqliteTime(null), null)
  db.restoreApplicationFromCloud({
    id: 'cloud-row-1', job_title: 'Restored', company: 'Cloud', platform: 'Seek', job_url: 'https://cloud/1',
    status: 'applied', applied_at: '2026-10-16T05:00:00+00:00', updated_at: '2026-10-16T06:30:00.123456+00:00',
    held_at: null, next_action_done_at: '2026-10-16T07:00:00.000Z',
  })
  const restored = db.getApplicationByCloudId('cloud-row-1')
  check('a restored applied_at is SQLite time', restored.applied_at, '2026-10-16 05:00:00')
  check('a restored updated_at is SQLite time', restored.updated_at, '2026-10-16 06:30:00')
  check('a restored completion time is SQLite time', restored.next_action_done_at, '2026-10-16 07:00:00')
  check('cloud_updated_at keeps the cloud value for equality checks', restored.cloud_updated_at, '2026-10-16T06:30:00.123456+00:00')
  db.applyCloudEdit(restored.id, { next_action_done_at: '2026-10-17T01:02:03.000Z' }, '2026-10-17T01:02:03Z')
  check('a phone completion time is stored as SQLite time', row(restored.id).next_action_done_at, '2026-10-17 01:02:03')
  const items = db.updateChecklist(restored.id, { title: 'Call back' })
  check('a checklist edit stamps SQLite time', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row(restored.id).updated_at), true)
  check('and still saves the task', items.length, 1)

  // ── 6: "use the cloud copy" keeps the answer bank ────────────────
  db.saveInterviewAnswer({ question: 'Why are you leaving?', answer: 'Growth', source: 'user' })
  db.clearAllApplications({ keepAnswerBank: true })
  check('applications are cleared', db.countApplications(), 0)
  check('the interview answers survive', db.listInterviewAnswers().length, 1)
  db.clearAllApplications()
  check('a plain clear-all still clears them, as before', db.listInterviewAnswers().length, 0)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
