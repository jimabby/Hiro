// The rate metrics and the application lifecycle, against a real database.
//
// Response rate previously counted only status='interview', so moving a job
// forward to Offer LOWERED it — and applications that never got a reply sat at
// 'applied' forever, growing the denominator with rows that would never
// resolve. These lock in the corrected definitions plus the sweep and inbox
// scope that depend on them.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-stats-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

let seq = 0
function add(status, extra = {}) {
  seq++
  db.insertApplication({
    job_title: extra.job_title || `Role ${seq}`,
    company: extra.company || `Company ${seq}`,
    platform: extra.platform || 'Seek',
    salary: extra.salary ?? '',
    job_url: `https://example.com/job/${seq}`,
    job_description: '',
    match_score: extra.match_score ?? 85,
    match_explanation: '',
    tailored_resume: '',
    screening_qa: extra.screening_qa || [],
    status,
    closing_date: null,
  })
  return seq
}

// Backdate a row and reload, so time-window behaviour is exercised for real
// rather than mocked.
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
  await db.init()
}

async function main() {
  await db.init()

  // ─── Response rate vs interview rate ──────────────────────────
  // 5 submitted: 1 interview, 1 offer, 1 rejected, 1 pending, 1 still applied.
  // Plus a skipped row, which was never submitted and must not count either way.
  add('interview')
  add('offer')
  add('rejected')
  add('pending')
  add('applied')
  add('skipped')

  let stats = db.getStats()
  // Never-submitted rows are out of every application COUNT, not just the rate
  // denominators — the bug was "Today"/"This Week"/"All Time" running plain
  // COUNT(*), so a review-heavy scan reported applications no employer received.
  check('all-time counts submitted applications only', stats.totalAllTime, 5)
  check('today counts submitted applications only', stats.totalToday, 5)
  check('this week counts submitted applications only', stats.totalThisWeek, 5)
  check('unsent rows are reported separately, not hidden', stats.unsentToday, 1)
  check('row count still reflects the whole table', stats.rowsAllTime, 6)
  // The per-platform chart must agree with the tiles.
  check('platform chart counts submitted applications only',
    stats.byPlatform.reduce((n, p) => n + p.count, 0), 5)
  // …while the status breakdown still shows the skipped row, since naming the
  // status is the entire point of that chart.
  check('status chart still lists skipped rows',
    stats.byStatus.find(s => s.status === 'skipped')?.count, 1)
  check('today job list excludes unsent rows', stats.todayJobs.length, 5)
  // Charts share the tiles' definition.
  check('per-day chart counts submitted applications only',
    db.getApplicationsPerDay(7).reduce((n, d) => n + d.count, 0), 5)
  check('by-date chart counts submitted applications only',
    db.getApplicationsByDate().reduce((n, d) => n + d.count, 0), 5)
  // …and so does the weekly report.
  const weekly = db.getWeeklyReportData()
  check('weekly report counts submitted applications only', weekly.totalApps, 5)
  check('weekly report reports the unsent rows', weekly.unsentApps, 1)
  check('weekly report per-day excludes unsent rows',
    weekly.perDay.reduce((n, d) => n + d.count, 0), 5)
  // 4 of the 5 submitted got some reply back.
  check('response rate counts every kind of reply', stats.responseRate, 80)
  // Interview + offer = 2 of 5. An offer implies the interview stage was
  // reached, so it counts here — this is the regression that mattered.
  check('interview rate counts offers as interviews', stats.interviewRate, 40)
  check('interviews tile includes offers', stats.interviews, 2)

  // The specific bug: promoting a row from interview to offer must not reduce
  // either rate.
  const before = db.getStats()
  const interviewRow = db.getApplications({ status: 'interview' })[0]
  db.updateApplicationStatus(interviewRow.id, 'offer')
  const after = db.getStats()
  check('promoting to offer does not lower the response rate', after.responseRate >= before.responseRate, true)
  check('promoting to offer does not lower the interview rate', after.interviewRate >= before.interviewRate, true)
  db.updateApplicationStatus(interviewRow.id, 'interview') // restore

  // ─── Inbox scope ──────────────────────────────────────────────
  // 'pending' and 'no_response' must stay in scope or a later email that
  // finally schedules an interview is never read.
  const awaiting = db.getApplicationsAwaitingReply().map(a => a.status).sort()
  check('inbox watches applied and pending', awaiting.includes('applied') && awaiting.includes('pending'), true)
  check('inbox ignores resolved statuses', awaiting.some(s => ['interview', 'offer', 'rejected', 'skipped'].includes(s)), false)

  // Reply-uid bookkeeping stops the same email being re-classified every pass.
  const pendingRow = db.getApplications({ status: 'pending' })[0]
  check('no reply uid recorded initially', pendingRow.last_reply_uid, null)
  db.setLastReplyUid(pendingRow.id, 4321)
  check('reply uid is persisted', db.getApplication(pendingRow.id).last_reply_uid, 4321)

  // ─── Stale sweep ──────────────────────────────────────────────
  const stale = add('applied', { company: 'Ghosted Ltd' })
  await backdate(`https://example.com/job/${stale}`, 60)

  check('sweep is a no-op when disabled', db.markStaleApplications(0).updated, 0)
  check('sweep ignores rows inside the window', db.markStaleApplications(90).updated, 0)
  check('sweep retires rows past the window', db.markStaleApplications(45).updated, 1)
  check('swept row is now no_response', db.getApplication(stale).status, 'no_response')
  check('sweep is idempotent', db.markStaleApplications(45).updated, 0)

  // A retired row is still watched by the inbox, so a late reply can revive it.
  check('no_response stays in inbox scope',
    db.getApplicationsAwaitingReply().some(a => a.id === stale), true)
  // And the status change is on the timeline, not silently applied.
  check('sweep records a status change',
    db.getStatusHistory(stale).some(h => h.status === 'no_response'), true)
  // no_response is not a reply, so it must not inflate the response rate.
  stats = db.getStats()
  check('no_response does not count as a response', stats.responseRate, 67)

  // ─── Salary normalisation on insert ───────────────────────────
  const paid = add('applied', { salary: '$120,000 - $140,000' })
  const paidRow = db.getApplication(paid)
  check('salary_min parsed on insert', paidRow.salary_min, 120000)
  check('salary_max parsed on insert', paidRow.salary_max, 140000)

  const hourly = add('applied', { salary: '$60 per hour' })
  check('hourly salary annualised on insert', db.getApplication(hourly).salary_min, 60 * 38 * 52)

  const vague = add('applied', { salary: 'Competitive' })
  check('unparseable salary stays null', db.getApplication(vague).salary_min, null)

  // ─── Salary filtering ─────────────────────────────────────────
  const inRange = db.getApplications({ salaryFrom: 130000 })
  check('salaryFrom matches on the top of the range', inRange.some(a => a.id === paid), true)
  const tooLow = db.getApplications({ salaryTo: 100000 })
  check('salaryTo excludes higher ranges', tooLow.some(a => a.id === paid), false)
  // An unlisted salary is excluded rather than treated as 0 — otherwise every
  // unlisted job would silently pass a minimum-salary filter.
  check('unparseable salary excluded from a salary filter',
    db.getApplications({ salaryFrom: 1 }).some(a => a.id === vague), false)
  check('no salary filter still returns everything',
    db.getApplications({}).some(a => a.id === vague), true)

  // ─── Salary stats ─────────────────────────────────────────────
  const salaryStats = db.getSalaryStats()
  check('salary stats count only parsed rows', salaryStats.count > 0, true)
  check('salary stats report unparsed separately', salaryStats.unparsed > 0, true)
  check('salary median is within the observed range',
    salaryStats.median >= salaryStats.min && salaryStats.median <= salaryStats.max, true)

  // ─── Sorting is whitelisted ───────────────────────────────────
  // Salary sorts on the numeric column: sorting the text would put "$90,000"
  // above "$120,000".
  const bySalary = db.getApplications({ sort: 'salary' })
  const firstWithSalary = bySalary.find(a => a.salary_max != null)
  check('salary sort puts the highest first', firstWithSalary.salary_max, 140000)
  // An unknown sort key falls back rather than being interpolated into SQL.
  check('unknown sort key falls back safely',
    db.getApplications({ sort: 'id; DROP TABLE applications' }).length > 0, true)

  // ─── Screening Q&A round-trip ─────────────────────────────────
  const qa = [{ question: 'Do you have a visa?', answer: 'Yes', source: 'ai' }]
  const withQa = add('applied', { screening_qa: qa })
  check('screening Q&A is stored as JSON',
    JSON.parse(db.getApplication(withQa).screening_qa), qa)

  done()
}

main().catch(err => { console.error(err); process.exit(1) })
