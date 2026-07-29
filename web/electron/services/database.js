const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')
const { parseSalaryColumns } = require('./salaryParser')

const DB_PATH = path.join(CONFIG_DIR, 'autoapply.db')

let db = null
let SQL = null

async function init() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

  SQL = await require('sql.js')()

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }

  createTables()
  migrate()
  persist()
}

// Every write persists the WHOLE database file (sql.js has no incremental
// write), so a loop of single-row updates costs one full serialization per row.
// batch() suppresses those intermediate writes and flushes once at the end;
// callers that touch many rows (cloud sync, cascading deletes) must use it.
let persistDepth = 0

// Written via a temp file + rename. sql.js has no incremental write, so every
// persist replaces the entire database file — a crash or power loss partway
// through a bare writeFileSync left a truncated file that no longer opened,
// destroying all history. rename() is atomic on both NTFS and POSIX, so the
// old file survives intact until the new one is complete.
function persist() {
  if (!db || persistDepth > 0) return
  const data = Buffer.from(db.export())
  const tmp = DB_PATH + '.tmp'
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, DB_PATH)
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort */ }
    throw err
  }
}

function batch(fn) {
  persistDepth++
  try {
    return fn()
  } finally {
    persistDepth--
    persist()
  }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title TEXT NOT NULL,
      company TEXT NOT NULL,
      platform TEXT NOT NULL,
      salary TEXT,
      job_url TEXT,
      job_description TEXT,
      match_score INTEGER,
      tailored_resume TEXT,
      screening_qa TEXT,
      status TEXT DEFAULT 'applied',
      applied_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      cloud_dirty INTEGER DEFAULT 1,
      cloud_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attention_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title TEXT NOT NULL,
      company TEXT NOT NULL,
      platform TEXT NOT NULL,
      salary TEXT,
      job_url TEXT,
      job_description TEXT,
      match_score INTEGER,
      talking_points TEXT,
      reason TEXT,
      dismissed INTEGER DEFAULT 0,
      found_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS screening_cache (
      question_hash TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interview_prep (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER,
      questions TEXT,
      saved_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      changed_at TEXT DEFAULT (datetime('now'))
    );

    -- Per-call AI usage, so the cost of a scan is visible instead of only
    -- showing up on the provider's monthly bill. One row per API call.
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      called_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interview_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      has_time INTEGER DEFAULT 1,
      source TEXT DEFAULT 'manual',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  persist()
}

function migrate() {
  // Add columns if they don't exist (for existing databases)
  try { db.run('ALTER TABLE applications ADD COLUMN cover_letter TEXT DEFAULT ""') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN comment TEXT DEFAULT ""') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN match_explanation TEXT DEFAULT ""') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN follow_up_sent INTEGER DEFAULT 0') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN recruiter_email TEXT DEFAULT ""') } catch {}
  // Cloud sync tracking: cloud_dirty marks rows with local changes not yet
  // pushed (defaults 1 so existing rows push once); cloud_updated_at remembers
  // the remote updated_at we last saw, so pulls detect phone edits by equality
  // instead of comparing two devices' clocks.
  try { db.run('ALTER TABLE applications ADD COLUMN cloud_dirty INTEGER DEFAULT 1') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN cloud_updated_at TEXT') } catch {}
  // Application deadline parsed out of the job ad, so Needs Attention can sort
  // by what actually expires soonest instead of by when it was found.
  try { db.run('ALTER TABLE applications ADD COLUMN closing_date TEXT') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN closing_date TEXT') } catch {}
  // IMAP uid of the last recruiter reply we classified for this application.
  // The inbox check now revisits non-terminal statuses (not just 'applied'), so
  // without this it would re-download and re-classify the same email on every
  // pass — burning an AI call each time for no new information.
  try { db.run('ALTER TABLE applications ADD COLUMN last_reply_uid INTEGER') } catch {}
  // Salary parsed out of the ad's free-text salary string, so it can be
  // filtered, sorted, and averaged. NULL means "couldn't parse" (or not listed).
  try { db.run('ALTER TABLE applications ADD COLUMN salary_min INTEGER') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN salary_max INTEGER') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN salary_min INTEGER') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN salary_max INTEGER') } catch {}

  // Which resume was actually sent. Routing rules mean different jobs go out
  // with different resumes, and without recording the choice there's no way to
  // tell afterwards which one converts — the routing rules were untestable.
  try { db.run('ALTER TABLE applications ADD COLUMN resume_id TEXT') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN resume_name TEXT') } catch {}
  // Review mode ('held' status) parks a job instead of submitting it. These
  // carry the drafted documents forward so approving it doesn't re-run the AI.
  try { db.run('ALTER TABLE applications ADD COLUMN held_at TEXT') } catch {}

  // Indexes for frequent queries
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_applied_at ON applications(applied_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_job_url ON applications(job_url)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_url ON attention_jobs(job_url)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(called_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_platform ON applications(platform)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_company ON applications(company)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_dismissed ON attention_jobs(dismissed)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_history_app ON status_history(application_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_interview_app ON interview_events(application_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_interview_at ON interview_events(scheduled_at)') } catch {}
}

// Convert sql.js result to array of objects
function toRows(result) {
  if (!result || result.length === 0) return []
  const { columns, values } = result[0]
  return values.map(row => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
}

function run(sql, params = []) {
  db.run(sql, params)
  persist()
}

function query(sql, params = []) {
  return toRows(db.exec(sql, params))
}

function queryOne(sql, params = []) {
  const rows = query(sql, params)
  return rows[0] || null
}

// ─── Applications ────────────────────────────────────────────────

// Columns that hold whole documents. A list view never renders them, but
// SELECT * shipped every one of them across the IPC boundary on every dashboard
// load — tens of MB once history builds up. getApplications keeps the full row
// for callers that genuinely need it (CSV export, cloud push); the UI uses
// getApplicationsList, which omits them and fetches detail on selection.
const LIST_COLUMNS = `id, job_title, company, platform, salary, salary_min, salary_max, job_url,
  match_score, match_explanation, status, comment, recruiter_email, applied_at, updated_at,
  closing_date, follow_up_sent, resume_id, resume_name`

function getApplications(filters = {}) {
  return runApplicationQuery('*', filters)
}

// Same filters and sorting, minus the document columns.
function getApplicationsList(filters = {}) {
  return runApplicationQuery(LIST_COLUMNS, filters)
}

function runApplicationQuery(columns, filters = {}) {
  let sql = `SELECT ${columns} FROM applications`
  const params = []
  const conditions = []

  if (filters.status) { conditions.push('status = ?'); params.push(filters.status) }
  if (filters.platform) { conditions.push('platform = ?'); params.push(filters.platform) }
  if (filters.dateFrom) { conditions.push('applied_at >= ?'); params.push(filters.dateFrom) }
  if (filters.dateTo) {
    // applied_at is 'YYYY-MM-DD HH:MM:SS'; a date-only upper bound would
    // lexicographically exclude every row on that final day.
    const to = /^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo) ? filters.dateTo + ' 23:59:59' : filters.dateTo
    conditions.push('applied_at <= ?'); params.push(to)
  }
  // Salary bounds work on the normalised annual columns. A row whose salary
  // couldn't be parsed has NULL on both and is excluded from a salary filter —
  // treating unknown as 0 would hide every unlisted-salary job behind a filter
  // the user didn't intend to be that aggressive.
  if (filters.salaryFrom != null && filters.salaryFrom !== '') {
    conditions.push('COALESCE(salary_max, salary_min) >= ?'); params.push(Number(filters.salaryFrom))
  }
  if (filters.salaryTo != null && filters.salaryTo !== '') {
    conditions.push('COALESCE(salary_min, salary_max) <= ?'); params.push(Number(filters.salaryTo))
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')

  // Sorting is whitelisted, never interpolated from caller input.
  const SORTS = {
    applied_at: 'applied_at DESC',
    match_score: 'match_score DESC, applied_at DESC',
    salary: 'COALESCE(salary_max, salary_min) DESC, applied_at DESC',
    company: 'company COLLATE NOCASE ASC, applied_at DESC',
    closing_date: "CASE WHEN closing_date IS NULL OR closing_date = '' THEN 1 ELSE 0 END, closing_date ASC, applied_at DESC",
  }
  sql += ' ORDER BY ' + (SORTS[filters.sort] || SORTS.applied_at)
  return query(sql, params)
}

function getApplication(id) {
  return queryOne('SELECT * FROM applications WHERE id = ?', [id])
}

function hasJobUrl(jobUrl) {
  return !!queryOne('SELECT 1 FROM applications WHERE job_url = ? LIMIT 1', [jobUrl])
}

// A job whose apply attempt failed lands in attention_jobs WITHOUT an
// applications row, so hasJobUrl alone didn't recognise it on the next scan:
// every run re-fetched the description, re-scored, re-tailored and re-submitted
// it, then inserted ANOTHER Needs Attention row for the same listing. Dismissed
// rows are deliberately still counted — the user has already ruled on that job
// and doesn't want it resurrected.
function hasAttentionJobUrl(jobUrl) {
  if (!jobUrl) return false
  return !!queryOne('SELECT 1 FROM attention_jobs WHERE job_url = ? LIMIT 1', [jobUrl])
}

// Either table has seen this listing before.
function hasSeenJobUrl(jobUrl) {
  return hasJobUrl(jobUrl) || hasAttentionJobUrl(jobUrl)
}

// Has this company been applied to *recently*? Previously this matched any
// non-skipped row ever, so a single application permanently blacklisted the
// employer — every later role there was silently skipped. The window is
// configurable (companyCooldownDays; 0 disables) and defaults to 30 days,
// which keeps the anti-spam intent without burning a company forever.
// Per-listing and cross-platform duplicates are caught separately by
// hasJobUrl() and findDuplicateAcrossPlatforms().
function findRecentApplicationToCompany(company, cooldownDays) {
  const days = Number(cooldownDays)
  if (!Number.isFinite(days) || days <= 0) return null
  return queryOne(
    `SELECT job_title, applied_at FROM applications
     WHERE LOWER(company) = LOWER(?) AND ${SENT_ONLY}
       AND applied_at >= datetime('now', '-' || ? || ' days')
     ORDER BY applied_at DESC LIMIT 1`,
    [company, days]
  )
}

function insertApplication(data) {
  // Salary is stored both as scraped (for display) and normalised to annual
  // numbers (for filtering and averaging). Callers may pass the parsed values
  // through; anything unparsed falls back to deriving them here so no insert
  // path can silently skip it.
  const parsed = data.salary_min == null && data.salary_max == null
    ? parseSalaryColumns(data.salary || '')
    : { salary_min: data.salary_min ?? null, salary_max: data.salary_max ?? null }

  const status = data.status || 'applied'
  db.run(`
    INSERT INTO applications
      (job_title, company, platform, salary, job_url, job_description, match_score, match_explanation, tailored_resume, cover_letter, screening_qa, status, closing_date, salary_min, salary_max, resume_id, resume_name, recruiter_email, held_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title, data.company, data.platform, data.salary || '',
    data.job_url, data.job_description, data.match_score,
    data.match_explanation || '',
    data.tailored_resume, data.cover_letter || '',
    JSON.stringify(data.screening_qa || []),
    status,
    data.closing_date || null,
    parsed.salary_min, parsed.salary_max,
    data.resume_id || null, data.resume_name || null,
    data.recruiter_email || '',
    status === 'held' ? new Date().toISOString() : null,
  ])
  // Read the new row id BEFORE persist(): db.export() resets last_insert_rowid.
  const newId = queryOne('SELECT last_insert_rowid() as id')?.id
  if (newId) db.run('INSERT INTO status_history (application_id, status) VALUES (?, ?)', [newId, status])
  persist()
  return { success: true, id: newId }
}

// ─── Review mode (held applications) ─────────────────────────────
// When review mode is on, a job that clears the match threshold is drafted in
// full (resume tailored, cover letter written) and parked as 'held' instead of
// being submitted. Nothing is sent until the user approves it, so a bad
// tailoring pass can't reach ten employers before anyone notices.

function getHeldApplications() {
  return query(`SELECT ${LIST_COLUMNS}, held_at FROM applications WHERE status = 'held' ORDER BY match_score DESC, held_at ASC`)
}

// Mark an approved-and-submitted held job as applied. Its documents are already
// on the row, so approving costs no AI calls.
function markHeldApplied(id, screeningQa) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(`UPDATE applications
       SET status = 'applied', applied_at = datetime('now'), held_at = NULL,
           screening_qa = ?, updated_at = datetime('now'), cloud_dirty = 1
       WHERE id = ?`, [JSON.stringify(screeningQa || []), id])
  if (current && current.status !== 'applied') recordStatusChange(id, 'applied')
  return { success: true }
}

// The user declined a held draft. It stays in history as 'skipped' so the same
// listing isn't re-scored and re-drafted on the next scan.
function rejectHeldApplication(id) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(`UPDATE applications SET status = 'skipped', held_at = NULL,
       updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?`, [id])
  if (current && current.status !== 'skipped') recordStatusChange(id, 'skipped')
  return { success: true }
}

// Append to the per-application status timeline (only on real changes).
function recordStatusChange(id, status) {
  run('INSERT INTO status_history (application_id, status) VALUES (?, ?)', [id, status])
}

function getStatusHistory(applicationId) {
  return query('SELECT status, changed_at FROM status_history WHERE application_id = ? ORDER BY changed_at ASC, id ASC', [applicationId])
}

function updateApplicationStatus(id, status) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run("UPDATE applications SET status = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?", [status, id])
  if (current && current.status !== status) recordStatusChange(id, status)
  return { success: true }
}

function updateApplicationAfterApply(id, tailoredResume, coverLetter, screeningQa) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(
    "UPDATE applications SET status = 'applied', tailored_resume = ?, cover_letter = ?, screening_qa = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?",
    [tailoredResume, coverLetter, JSON.stringify(screeningQa || []), id]
  )
  if (current && current.status !== 'applied') recordStatusChange(id, 'applied')
}

function updateApplicationComment(id, comment) {
  run("UPDATE applications SET comment = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?", [comment, id])
  return { success: true }
}

function updateRecruiterEmail(id, email) {
  run("UPDATE applications SET recruiter_email = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?", [email, id])
  return { success: true }
}

// Deleting an application must take its dependent rows with it. interview_prep
// in particular was never cleaned up — the rows accumulated forever, inflated
// the count in Settings → Data, and had no way to be removed.
function deleteApplication(id) {
  batch(() => {
    run('DELETE FROM applications WHERE id = ?', [id])
    run('DELETE FROM status_history WHERE application_id = ?', [id])
    run('DELETE FROM interview_prep WHERE application_id = ?', [id])
    run('DELETE FROM interview_events WHERE application_id = ?', [id])
  })
  return { success: true }
}

function clearAllApplications() {
  batch(() => {
    run('DELETE FROM applications')
    run('DELETE FROM status_history')
    run('DELETE FROM interview_prep')
    run('DELETE FROM interview_events')
  })
  return { success: true }
}

// One-off sweep for rows orphaned by earlier versions, which deleted the
// application without its dependents. Runs on launch; cheap and idempotent.
function pruneOrphanedRows() {
  try {
    return batch(() => {
      const before = queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0
      run('DELETE FROM interview_prep WHERE application_id NOT IN (SELECT id FROM applications)')
      run('DELETE FROM status_history WHERE application_id NOT IN (SELECT id FROM applications)')
      run('DELETE FROM interview_events WHERE application_id NOT IN (SELECT id FROM applications)')
      const after = queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0
      return { removedInterviewPreps: before - after }
    })
  } catch {
    return { removedInterviewPreps: 0 }
  }
}

// One-off backfill of the normalised salary columns for rows inserted before
// they existed. Runs on launch; idempotent, and skips rows already backfilled
// so it costs one query once the sweep has happened.
function backfillSalaryColumns() {
  try {
    const rows = query(`
      SELECT id, salary FROM applications
      WHERE salary_min IS NULL AND salary_max IS NULL AND salary IS NOT NULL AND salary != ''
    `)
    const attention = query(`
      SELECT id, salary FROM attention_jobs
      WHERE salary_min IS NULL AND salary_max IS NULL AND salary IS NOT NULL AND salary != ''
    `)
    if (rows.length === 0 && attention.length === 0) return { updated: 0 }

    let updated = 0
    batch(() => {
      for (const r of rows) {
        const { salary_min, salary_max } = parseSalaryColumns(r.salary)
        if (salary_min == null && salary_max == null) continue
        run('UPDATE applications SET salary_min = ?, salary_max = ? WHERE id = ?', [salary_min, salary_max, r.id])
        updated++
      }
      for (const r of attention) {
        const { salary_min, salary_max } = parseSalaryColumns(r.salary)
        if (salary_min == null && salary_max == null) continue
        run('UPDATE attention_jobs SET salary_min = ?, salary_max = ? WHERE id = ?', [salary_min, salary_max, r.id])
        updated++
      }
    })
    return { updated }
  } catch {
    return { updated: 0 }
  }
}

// Salary distribution across everything actually submitted, for the Analytics
// page. Rows whose salary couldn't be parsed are reported separately rather
// than folded in as zeros.
function getSalaryStats() {
  const rows = query(`
    SELECT salary_min, salary_max, match_score, status FROM applications
    WHERE ${SENT_ONLY}
  `)
  // Midpoint of the advertised range is the fairest single number to average;
  // a one-sided range contributes the side it states.
  const midpoints = []
  let unparsed = 0
  for (const r of rows) {
    if (r.salary_min == null && r.salary_max == null) { unparsed++; continue }
    if (r.salary_min != null && r.salary_max != null) midpoints.push((r.salary_min + r.salary_max) / 2)
    else midpoints.push(r.salary_min ?? r.salary_max)
  }
  if (midpoints.length === 0) return { count: 0, unparsed, min: null, max: null, median: null, average: null }
  midpoints.sort((a, b) => a - b)
  const mid = Math.floor(midpoints.length / 2)
  return {
    count: midpoints.length,
    unparsed,
    min: Math.round(midpoints[0]),
    max: Math.round(midpoints[midpoints.length - 1]),
    median: Math.round(midpoints.length % 2 ? midpoints[mid] : (midpoints[mid - 1] + midpoints[mid]) / 2),
    average: Math.round(midpoints.reduce((a, b) => a + b, 0) / midpoints.length),
  }
}

// ─── Cloud Sync Bookkeeping ──────────────────────────────────────

// Rows with local changes the cloud hasn't seen (new rows start dirty).
function getDirtyApplications() {
  return query('SELECT * FROM applications WHERE cloud_dirty = 1 OR cloud_updated_at IS NULL')
}

function getAllApplicationIds() {
  return query('SELECT id FROM applications').map(r => r.id)
}

// Clear the dirty flag after a successful push — but only if the row wasn't
// edited again while the push was in flight (guarded by updated_at).
function markCloudSynced(id, cloudUpdatedAt, localUpdatedAt) {
  run('UPDATE applications SET cloud_dirty = 0, cloud_updated_at = ? WHERE id = ? AND updated_at = ?',
    [cloudUpdatedAt, id, localUpdatedAt])
}

// Record the remote version we saw without touching local data.
function markCloudSeen(id, cloudUpdatedAt) {
  run('UPDATE applications SET cloud_updated_at = ? WHERE id = ?', [cloudUpdatedAt, id])
}

// Apply a phone-side edit locally WITHOUT marking the row dirty, so the next
// push doesn't echo it straight back with a new timestamp.
function applyCloudEdit(id, { status, comment }, cloudUpdatedAt) {
  const sets = ["updated_at = datetime('now')", 'cloud_updated_at = ?']
  const params = [cloudUpdatedAt]
  if (status != null) { sets.push('status = ?'); params.push(status) }
  if (comment != null) { sets.push('comment = ?'); params.push(comment) }
  params.push(id)
  run(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`, params)
  if (status != null) recordStatusChange(id, status) // phone edits show in the timeline too
}

// Every interview joined to its application, for the cloud mirror. Unlike
// getUpcomingInterviews this isn't date-filtered — the phone applies its own
// window, and filtering here would make a past interview look deleted.
function getAllInterviewEventsForSync() {
  return query(`
    SELECT e.id, e.application_id, e.scheduled_at, e.has_time, e.source, e.note,
           a.job_title, a.company, a.platform
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
  `)
}

// ─── Attention Jobs ──────────────────────────────────────────────

// Jobs with a known closing date come first, soonest deadline at the top —
// that's the decision the user is actually making on this page. Anything with
// no parsed deadline falls back to most-recently-found.
function getAttentionJobs() {
  return query(`
    SELECT * FROM attention_jobs WHERE dismissed = 0
    ORDER BY
      CASE WHEN closing_date IS NULL OR closing_date = '' THEN 1 ELSE 0 END,
      closing_date ASC,
      found_at DESC
  `)
}

function getAttentionJob(id) {
  return queryOne('SELECT * FROM attention_jobs WHERE id = ?', [id])
}

function insertAttentionJob(data) {
  // Guard at the write, not only at the caller: a re-scan, a cloud-triggered
  // scan and a manual retry all reach here, and a duplicate row is invisible
  // in the UI except as the same job listed twice.
  if (data.job_url && hasAttentionJobUrl(data.job_url)) {
    return { success: true, skipped: 'duplicate' }
  }
  const parsed = data.salary_min == null && data.salary_max == null
    ? parseSalaryColumns(data.salary || '')
    : { salary_min: data.salary_min ?? null, salary_max: data.salary_max ?? null }

  run(`
    INSERT INTO attention_jobs
      (job_title, company, platform, salary, job_url, job_description, match_score, talking_points, reason, closing_date, salary_min, salary_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title, data.company, data.platform, data.salary || '',
    data.job_url, data.job_description, data.match_score,
    JSON.stringify(data.talking_points || []), data.reason || '',
    data.closing_date || null,
    parsed.salary_min, parsed.salary_max,
  ])
  return { success: true }
}

function dismissAttentionJob(id) {
  run('UPDATE attention_jobs SET dismissed = 1 WHERE id = ?', [id])
  return { success: true }
}

function deleteAttentionJob(id) {
  run('DELETE FROM attention_jobs WHERE id = ?', [id])
  return { success: true }
}

function clearAllAttentionJobs() {
  run('DELETE FROM attention_jobs')
  return { success: true }
}

// ─── Screening Answer Cache ──────────────────────────────────────

function normalizeQuestion(question) {
  return question.toLowerCase().trim().replace(/\s+/g, ' ')
}

function getCachedAnswer(question) {
  const hash = normalizeQuestion(question)
  return queryOne('SELECT answer FROM screening_cache WHERE question_hash = ?', [hash])?.answer || null
}

function saveCachedAnswer(question, answer) {
  const hash = normalizeQuestion(question)
  run(
    `INSERT INTO screening_cache (question_hash, question, answer) VALUES (?, ?, ?)
     ON CONFLICT(question_hash) DO UPDATE SET answer = excluded.answer, updated_at = datetime('now')`,
    [hash, question, answer]
  )
}

function getAllCachedAnswers() {
  return query('SELECT question, answer, updated_at FROM screening_cache ORDER BY updated_at DESC')
}

function deleteCachedAnswer(question) {
  const hash = normalizeQuestion(question)
  run('DELETE FROM screening_cache WHERE question_hash = ?', [hash])
  return { success: true }
}

// ─── Stats ───────────────────────────────────────────────────────

// applied_at is stored in UTC (datetime('now')); these boundaries convert the
// user's LOCAL start-of-day back to UTC so "today"/"this week" match the
// calendar the user actually lives in (previously UTC dates were used, which
// misbucketed mornings in UTC+ timezones).
const TODAY_START = "datetime('now','localtime','start of day','utc')"
const WEEK_START = "datetime('now','localtime','start of day','-6 days','utc')"
const LAST_WEEK_START = "datetime('now','localtime','start of day','-13 days','utc')"

// Statuses that mean "the employer got back to us". An offer implies the
// interview stage was reached and a rejection is still a reply, so both count —
// previously only 'interview' did, which meant moving a job forward to Offer
// silently LOWERED the response rate. Matches getScoreBandConversion, which
// already counted offers as conversions.
const RESPONDED_STATUSES = ['interview', 'offer', 'rejected', 'pending']
const RESPONDED_SQL = RESPONDED_STATUSES.map(s => `'${s}'`).join(', ')

// Rows that were never actually submitted to an employer: scored below the
// match threshold ('skipped') or waiting on the user's approval in review mode
// ('held'). They must stay out of every rate denominator and out of the
// "applied today / this week" counts, or holding a job for review would look
// like an application that simply never got a reply.
const UNSENT_STATUSES = ['skipped', 'held']
const UNSENT_SQL = UNSENT_STATUSES.map(s => `'${s}'`).join(', ')
const SENT_ONLY = `status NOT IN (${UNSENT_SQL})`

function getStats() {
  const interviews = queryOne("SELECT COUNT(*) as c FROM applications WHERE status IN ('interview', 'offer')")?.c || 0
  const responded = queryOne(`SELECT COUNT(*) as c FROM applications WHERE status IN (${RESPONDED_SQL})`)?.c || 0
  const appliedCount = queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY}`)?.c || 0

  return {
    totalAllTime: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    totalToday: queryOne(`SELECT COUNT(*) as c FROM applications WHERE applied_at >= ${TODAY_START}`)?.c || 0,
    totalThisWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE applied_at >= ${WEEK_START}`)?.c || 0,
    totalLastWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE applied_at >= ${LAST_WEEK_START} AND applied_at < ${WEEK_START}`)?.c || 0,
    interviews,
    attentionCount: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    // Jobs parked by review mode, waiting for the user to approve or reject.
    heldCount: queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'held'")?.c || 0,
    byPlatform: query("SELECT platform, COUNT(*) as count FROM applications GROUP BY platform"),
    byStatus: query("SELECT status, COUNT(*) as count FROM applications GROUP BY status"),
    todayJobs: query(`SELECT job_title, company, platform, match_score, status FROM applications WHERE applied_at >= ${TODAY_START} ORDER BY applied_at DESC`),
    // Any reply at all, over everything submitted.
    responseRate: appliedCount > 0 ? Math.round((responded / appliedCount) * 100) : 0,
    // Reached interview or offer — the number most people actually mean when
    // they ask how the search is going. Reported alongside, not instead of.
    interviewRate: appliedCount > 0 ? Math.round((interviews / appliedCount) * 100) : 0,
  }
}

// How many applications were actually SUBMITTED to this platform today. Rows
// saved as 'skipped' (scored below the match threshold) and 'held' (waiting on
// review) were never sent, so they must not consume the daily limit — counting
// them meant a scan whose first N jobs scored badly stopped before applying to
// anything at all.
function getTodayCountByPlatform(platform) {
  return queryOne(
    `SELECT COUNT(*) as c FROM applications
     WHERE platform = ? AND status NOT IN ('skipped', 'held') AND applied_at >= ${TODAY_START}`,
    [platform]
  )?.c || 0
}

function findDuplicateAcrossPlatforms(jobTitle, company, currentPlatform) {
  return queryOne(
    `SELECT id, platform FROM applications
     WHERE LOWER(job_title) = LOWER(?) AND LOWER(company) = LOWER(?) AND platform != ? AND ${SENT_ONLY} LIMIT 1`,
    [jobTitle, company, currentPlatform]
  )
}

function getApplicationsByDate() {
  return query("SELECT DATE(applied_at,'localtime') as date, platform, COUNT(*) as count FROM applications GROUP BY DATE(applied_at,'localtime'), platform ORDER BY date DESC")
}

function getApplicationsPerDay(days) {
  const rows = query(
    `SELECT DATE(applied_at,'localtime') as date, COUNT(*) as count FROM applications
     WHERE applied_at >= datetime('now','localtime','start of day','-' || ? || ' days','utc')
     GROUP BY DATE(applied_at,'localtime') ORDER BY date ASC`,
    [days - 1]
  )
  // Pad missing days with zeros so charts always get a continuous series
  // (and match the mobile cloud client, which already pads).
  const byDate = {}
  for (const r of rows) byDate[r.date] = r.count
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, count: byDate[key] || 0 })
  }
  return out
}

// ─── Inbox reply tracking ────────────────────────────────────────
// Statuses the inbox check should keep watching. 'applied' is the obvious one,
// but 'pending' (a reply arrived that we couldn't classify) and 'no_response'
// (we gave up waiting) must stay in scope too — previously the inbox only
// looked at 'applied', so the moment a thread was marked pending it was frozen
// and a later email actually scheduling an interview was never seen.
const OPEN_STATUSES = ['applied', 'pending', 'no_response']

function getApplicationsAwaitingReply() {
  const list = OPEN_STATUSES.map(s => `'${s}'`).join(', ')
  return query(`SELECT * FROM applications WHERE status IN (${list}) ORDER BY applied_at DESC`)
}

// Remember which email we last classified, so the next pass can skip it.
function setLastReplyUid(id, uid) {
  run('UPDATE applications SET last_reply_uid = ? WHERE id = ?', [uid ?? null, id])
}

function getApplicationsForFollowUp(daysOld) {
  return query("SELECT * FROM applications WHERE status = 'applied' AND follow_up_sent = 0 AND applied_at <= datetime('now', '-' || ? || ' days')", [daysOld])
}

function markFollowUpSent(id) {
  run('UPDATE applications SET follow_up_sent = 1 WHERE id = ?', [id])
}

// ─── Stale applications ──────────────────────────────────────────
// An application that never gets a reply sat at 'applied' forever, which meant
// the response-rate denominator kept growing with rows that were never going to
// resolve. After `days` with no reply, move it to 'no_response' — a terminal
// status that's excluded from the response numerator but still visible, and
// still re-checked by the inbox in case a late reply arrives.
function markStaleApplications(days) {
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0) return { updated: 0 }
  const stale = query(
    `SELECT id FROM applications
     WHERE status = 'applied' AND applied_at <= datetime('now', '-' || ? || ' days')`,
    [n]
  )
  if (stale.length === 0) return { updated: 0 }
  batch(() => {
    for (const row of stale) updateApplicationStatus(row.id, 'no_response')
  })
  return { updated: stale.length }
}

function clearAllCachedAnswers() {
  run('DELETE FROM screening_cache')
  return { success: true }
}

// ─── Interview Prep ──────────────────────────────────────────────
function saveInterviewPrep(applicationId, questions) {
  run('DELETE FROM interview_prep WHERE application_id = ?', [applicationId])
  run('INSERT INTO interview_prep (application_id, questions) VALUES (?, ?)', [applicationId, JSON.stringify(questions)])
  persist()
}

function getInterviewPrep(applicationId) {
  const row = queryOne('SELECT questions FROM interview_prep WHERE application_id = ?', [applicationId])
  if (!row) return null
  try { return JSON.parse(row.questions) } catch { return null }
}

function deleteInterviewPrep(applicationId) {
  run('DELETE FROM interview_prep WHERE application_id = ?', [applicationId])
  persist()
}

// ─── Interview Schedule ──────────────────────────────────────────
// Interviews detected in recruiter replies (or entered by hand), so the user
// doesn't have to go dig the email back out after Hiro flags the reply.

function addInterviewEvent({ applicationId, scheduledAt, hasTime = true, source = 'manual', note = '' }) {
  run(
    'INSERT INTO interview_events (application_id, scheduled_at, has_time, source, note) VALUES (?, ?, ?, ?, ?)',
    [applicationId, scheduledAt, hasTime ? 1 : 0, source, note || '']
  )
  return { success: true }
}

// Only one auto-detected event per application: a recruiter thread produces
// several matching emails, and each inbox pass would otherwise add a duplicate.
// A manually entered time always wins and is never overwritten.
function upsertDetectedInterview({ applicationId, scheduledAt, hasTime = true, note = '' }) {
  const manual = queryOne(
    "SELECT id FROM interview_events WHERE application_id = ? AND source = 'manual' LIMIT 1",
    [applicationId]
  )
  if (manual) return { success: true, skipped: 'manual-entry-exists' }

  const existing = queryOne(
    "SELECT id, scheduled_at FROM interview_events WHERE application_id = ? AND source = 'inbox' LIMIT 1",
    [applicationId]
  )
  if (existing) {
    if (existing.scheduled_at === scheduledAt) return { success: true, skipped: 'unchanged' }
    run('UPDATE interview_events SET scheduled_at = ?, has_time = ?, note = ? WHERE id = ?',
      [scheduledAt, hasTime ? 1 : 0, note || '', existing.id])
    return { success: true, updated: true }
  }
  return addInterviewEvent({ applicationId, scheduledAt, hasTime, source: 'inbox', note })
}

function getInterviewEvents(applicationId) {
  return query('SELECT * FROM interview_events WHERE application_id = ? ORDER BY scheduled_at ASC', [applicationId])
}

// Upcoming interviews across all applications, joined to the job they belong
// to. Includes anything from the start of today so an interview later today
// doesn't vanish from the list at midnight-plus-one-second.
function getUpcomingInterviews(limit = 25) {
  return query(`
    SELECT e.id, e.application_id, e.scheduled_at, e.has_time, e.source, e.note,
           a.job_title, a.company, a.platform, a.status, a.job_url
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.scheduled_at >= date('now','localtime')
    ORDER BY e.scheduled_at ASC
    LIMIT ?
  `, [limit])
}

function deleteInterviewEvent(id) {
  run('DELETE FROM interview_events WHERE id = ?', [id])
  return { success: true }
}

// A single interview joined to its application, for one-off calendar export.
function getInterviewEvent(id) {
  return queryOne(`
    SELECT e.id, e.application_id, e.scheduled_at, e.has_time, e.source, e.note,
           a.job_title, a.company, a.platform, a.status, a.job_url
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.id = ?
  `, [id])
}

// ─── Closing dates ───────────────────────────────────────────────

function updateClosingDate(id, closingDate) {
  run("UPDATE applications SET closing_date = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?",
    [closingDate || null, id])
  return { success: true }
}

// ─── Score-band conversion ───────────────────────────────────────
// Which match-score bands actually convert to interviews. The histogram on the
// Analytics page shows how many jobs landed in each band; this shows whether
// that band was worth applying to, which is what the threshold should really
// be tuned against. Skipped rows are excluded — they were never submitted, so
// they can't have converted.
function getScoreBandConversion() {
  const rows = query(`
    SELECT match_score, status FROM applications
    WHERE ${SENT_ONLY} AND match_score IS NOT NULL
  `)
  const bands = Array.from({ length: 10 }, (_, i) => ({
    lo: i * 10, hi: i === 9 ? 100 : i * 10 + 9,
    applied: 0, interviews: 0, offers: 0, rejected: 0,
  }))
  for (const r of rows) {
    const score = Math.max(0, Math.min(100, r.match_score))
    const b = bands[Math.min(9, Math.floor(score / 10))]
    b.applied++
    if (r.status === 'interview') b.interviews++
    else if (r.status === 'offer') b.offers++
    else if (r.status === 'rejected') b.rejected++
  }
  // An offer implies the interview stage was reached, so it counts as a
  // conversion — otherwise the best outcomes would depress the rate.
  for (const b of bands) {
    b.converted = b.interviews + b.offers
    b.conversionRate = b.applied > 0 ? Math.round((b.converted / b.applied) * 100) : null
  }
  return bands
}

// ─── Resume conversion ───────────────────────────────────────────
// Which resume actually converts. Routing rules send different jobs to
// different resumes, and the score-band histogram can't distinguish them —
// this does, so the rules in Settings can be judged on outcomes rather than
// on the assumption that they help. Rows saved before resume_id existed are
// grouped as "unattributed" rather than silently folded into the default.
function getResumeConversion() {
  const rows = query(`
    SELECT resume_id, resume_name, status, match_score FROM applications
    WHERE ${SENT_ONLY}
  `)
  const byResume = new Map()
  for (const r of rows) {
    const key = r.resume_id || '__unattributed__'
    if (!byResume.has(key)) {
      byResume.set(key, {
        resumeId: r.resume_id || null,
        name: r.resume_name || (r.resume_id ? 'Deleted resume' : 'Before tracking'),
        applied: 0, interviews: 0, offers: 0, rejected: 0, pending: 0, scoreSum: 0,
      })
    }
    const b = byResume.get(key)
    b.applied++
    b.scoreSum += r.match_score || 0
    if (r.status === 'interview') b.interviews++
    else if (r.status === 'offer') b.offers++
    else if (r.status === 'rejected') b.rejected++
    else if (r.status === 'pending') b.pending++
  }
  return [...byResume.values()].map(b => ({
    ...b,
    converted: b.interviews + b.offers,
    // Below this, a rate is noise rather than signal — the UI greys these out
    // instead of presenting a confident 0% or 100% off three applications.
    significant: b.applied >= 10,
    conversionRate: b.applied > 0 ? Math.round(((b.interviews + b.offers) / b.applied) * 100) : null,
    responseRate: b.applied > 0
      ? Math.round(((b.interviews + b.offers + b.rejected + b.pending) / b.applied) * 100)
      : null,
    avgMatchScore: b.applied > 0 ? Math.round(b.scoreSum / b.applied) : 0,
  })).sort((a, b) => b.applied - a.applied)
}

// ─── AI usage & cost ─────────────────────────────────────────────

function recordAiUsage({ provider, model, operation, inputTokens = 0, outputTokens = 0, costUsd = 0 }) {
  run(
    'INSERT INTO ai_usage (provider, model, operation, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)',
    [provider || '', model || '', operation || '', inputTokens, outputTokens, costUsd]
  )
}

// Spend for the current calendar month (local time), used for the budget cap,
// plus a 30-day breakdown for the Analytics page.
function getAiUsageSummary() {
  const monthStart = "datetime('now','localtime','start of month','utc')"
  const dayStart = "datetime('now','localtime','start of day','utc')"
  const num = (sql) => queryOne(sql)?.v || 0
  return {
    today: {
      calls: num(`SELECT COUNT(*) as v FROM ai_usage WHERE called_at >= ${dayStart}`),
      cost: num(`SELECT COALESCE(SUM(cost_usd), 0) as v FROM ai_usage WHERE called_at >= ${dayStart}`),
    },
    month: {
      calls: num(`SELECT COUNT(*) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
      cost: num(`SELECT COALESCE(SUM(cost_usd), 0) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
      inputTokens: num(`SELECT COALESCE(SUM(input_tokens), 0) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
      outputTokens: num(`SELECT COALESCE(SUM(output_tokens), 0) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
    },
    byOperation: query(`
      SELECT operation, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost
      FROM ai_usage WHERE called_at >= ${monthStart}
      GROUP BY operation ORDER BY cost DESC
    `),
    perDay: query(`
      SELECT DATE(called_at,'localtime') as date, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
      FROM ai_usage
      WHERE called_at >= datetime('now','localtime','start of day','-29 days','utc')
      GROUP BY DATE(called_at,'localtime') ORDER BY date ASC
    `),
  }
}

// Spend so far this calendar month, in USD. Read before every AI call when a
// budget cap is set, so the cap actually stops work rather than reporting the
// overrun afterwards.
function getMonthlyAiSpend() {
  return queryOne(
    "SELECT COALESCE(SUM(cost_usd), 0) as v FROM ai_usage WHERE called_at >= datetime('now','localtime','start of month','utc')"
  )?.v || 0
}

// Usage rows are diagnostic, not history worth keeping forever.
function pruneAiUsage(keepDays = 180) {
  try {
    run("DELETE FROM ai_usage WHERE called_at < datetime('now', '-' || ? || ' days')", [keepDays])
  } catch { /* best-effort */ }
}

function clearAiUsage() {
  run('DELETE FROM ai_usage')
  return { success: true }
}

// ─── Weekly Report Data ──────────────────────────────────────────
function getWeeklyReportData() {
  const now = new Date()
  const dayOfWeek = now.getDay() || 7 // Mon=1 ... Sun=7
  const mondayOffset = dayOfWeek - 1
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset)
  const sunday = new Date(monday.getTime() + 6 * 86400000)
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // applied_at is stored in UTC, so the query bounds are the LOCAL Monday
  // midnight converted to UTC (display labels below stay local).
  const utcStr = (d) => d.toISOString().slice(0, 19).replace('T', ' ')
  const dateFrom = utcStr(monday)
  const dateTo = utcStr(new Date(monday.getTime() + 7 * 86400000))

  const apps = query('SELECT * FROM applications WHERE applied_at >= ? AND applied_at < ?', [dateFrom, dateTo])
  const totalApps = apps.length
  const byPlatform = {}
  const byStatus = {}
  let matchSum = 0
  for (const a of apps) {
    byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1
    byStatus[a.status] = (byStatus[a.status] || 0) + 1
    matchSum += a.match_score || 0
  }
  const interviews = (byStatus.interview || 0) + (byStatus.offer || 0)
  const responded = RESPONDED_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0)
  const applied = totalApps - UNSENT_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0)

  return {
    // Labels stay in local time — toISOString() is UTC and would shift the
    // displayed dates back a day in UTC+ timezones.
    dateFrom: localDate(monday),
    dateTo: localDate(sunday),
    totalApps,
    byPlatform,
    byStatus,
    avgMatchScore: totalApps > 0 ? Math.round(matchSum / totalApps) : 0,
    responseRate: applied > 0 ? Math.round((responded / applied) * 100) : 0,
    interviewRate: applied > 0 ? Math.round((interviews / applied) * 100) : 0,
    perDay: query("SELECT DATE(applied_at,'localtime') as date, COUNT(*) as count FROM applications WHERE applied_at >= ? AND applied_at < ? GROUP BY DATE(applied_at,'localtime') ORDER BY date", [dateFrom, dateTo]),
    topCompanies: query('SELECT company, COUNT(*) as count FROM applications WHERE applied_at >= ? AND applied_at < ? GROUP BY company ORDER BY count DESC LIMIT 5', [dateFrom, dateTo]),
  }
}

// ─── Backups ─────────────────────────────────────────────────────
// Rotating daily backups of the SQLite file in ~/.hiro/backups (keep 7).

const BACKUP_DIR = path.join(CONFIG_DIR, 'backups')
const BACKUP_KEEP = 7

function backupStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function backupNow() {
  if (!db) return { success: false, error: 'Database not initialised yet' }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
  persist() // flush in-memory state to disk first
  const file = path.join(BACKUP_DIR, `autoapply-${backupStamp()}.db`)
  fs.copyFileSync(DB_PATH, file)
  pruneBackups()
  return { success: true, name: path.basename(file) }
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^autoapply-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
    while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()))
    prunePreRestoreSnapshots()
  } catch { /* pruning is best-effort */ }
}

// Pre-restore snapshots are stamped per restore and kept alongside the daily
// rotation. They used to be a single fixed filename, so each restore silently
// destroyed the previous escape hatch, and the date-only prune regex never
// removed them. Keep the most recent few and drop the rest.
const PRE_RESTORE_KEEP = 3
const PRE_RESTORE_RE = /^autoapply-pre-restore-[\dT-]+\.db$/

function prunePreRestoreSnapshots() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => PRE_RESTORE_RE.test(f)).sort()
    while (files.length > PRE_RESTORE_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()))
    // Remove the legacy fixed-name snapshot left by older versions.
    const legacy = path.join(BACKUP_DIR, 'autoapply-pre-restore.db')
    if (fs.existsSync(legacy) && files.length > 0) fs.unlinkSync(legacy)
  } catch { /* best-effort */ }
}

// At most one backup per local day — called on launch and on a periodic timer.
function maybeBackup() {
  try {
    if (fs.existsSync(path.join(BACKUP_DIR, `autoapply-${backupStamp()}.db`))) return { success: true, skipped: true }
    return backupNow()
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return []
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => /^autoapply-[\w.-]+\.db$/.test(f))
      .sort().reverse()
      .map(name => {
        const st = fs.statSync(path.join(BACKUP_DIR, name))
        return { name, size: st.size, mtime: st.mtime.toISOString() }
      })
  } catch {
    return []
  }
}

function restoreBackup(name) {
  // Only accept plain filenames that exist inside the backups directory.
  if (!/^autoapply-[\w.-]+\.db$/.test(name)) return { success: false, error: 'Invalid backup name' }
  const file = path.join(BACKUP_DIR, name)
  if (!fs.existsSync(file)) return { success: false, error: 'Backup not found' }
  // Keep an escape hatch: snapshot the current database before replacing it.
  // Timestamped, so restoring twice doesn't destroy the first snapshot.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let snapshot = null
  try {
    snapshot = `autoapply-pre-restore-${stamp}.db`
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, snapshot))
  } catch { snapshot = null }
  db = new SQL.Database(fs.readFileSync(file))
  createTables()
  migrate()
  persist()
  prunePreRestoreSnapshots()
  return { success: true, snapshot }
}

function getStorageInfo() {
  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0
  const counts = {
    applications: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    attentionJobs: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    cachedAnswers: queryOne('SELECT COUNT(*) as c FROM screening_cache')?.c || 0,
    interviewPreps: queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0,
    interviewEvents: queryOne('SELECT COUNT(*) as c FROM interview_events')?.c || 0,
  }
  return { dbSize, counts }
}

module.exports = {
  init, batch, pruneOrphanedRows, backfillSalaryColumns,
  getApplications, getApplicationsList, getApplication, hasJobUrl, hasAttentionJobUrl, hasSeenJobUrl,
  findRecentApplicationToCompany, insertApplication, updateApplicationStatus,
  getHeldApplications, markHeldApplied, rejectHeldApplication,
  getResumeConversion, recordAiUsage, getAiUsageSummary, getMonthlyAiSpend, pruneAiUsage, clearAiUsage,
  UNSENT_STATUSES,
  updateApplicationAfterApply, updateApplicationComment, updateRecruiterEmail, deleteApplication, clearAllApplications,
  getDirtyApplications, getAllApplicationIds, markCloudSynced, markCloudSeen, applyCloudEdit,
  getAttentionJobs, getAttentionJob, insertAttentionJob, dismissAttentionJob, deleteAttentionJob, clearAllAttentionJobs,
  getAllInterviewEventsForSync,
  getCachedAnswer, saveCachedAnswer, getAllCachedAnswers, deleteCachedAnswer, clearAllCachedAnswers,
  getStats, getTodayCountByPlatform, getSalaryStats,
  findDuplicateAcrossPlatforms, getApplicationsByDate, getApplicationsPerDay,
  getApplicationsForFollowUp, markFollowUpSent,
  getApplicationsAwaitingReply, setLastReplyUid, markStaleApplications, OPEN_STATUSES,
  saveInterviewPrep, getInterviewPrep, deleteInterviewPrep,
  addInterviewEvent, upsertDetectedInterview, getInterviewEvents, getUpcomingInterviews, getInterviewEvent, deleteInterviewEvent,
  updateClosingDate, getScoreBandConversion,
  getWeeklyReportData, getStorageInfo,
  getStatusHistory,
  backupNow, maybeBackup, listBackups, restoreBackup,
}
