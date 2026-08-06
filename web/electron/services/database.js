const fs = require('fs')
const path = require('path')
const configService = require('./config')
const dbCrypto = require('./dbCrypto')
const { CONFIG_DIR } = configService
const { parseSalaryColumns } = require('./salaryParser')

const DB_PATH = path.join(CONFIG_DIR, 'autoapply.db')

let db = null
let SQL = null

async function init() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

  SQL = await require('sql.js')()

  if (fs.existsSync(DB_PATH)) {
    // readFile handles both states, so an encrypted profile and a plaintext one
    // load through the same path. A decryption failure is deliberately NOT
    // caught: falling through to `new SQL.Database()` would present an empty
    // database, which is indistinguishable from having lost every application
    // ever recorded. main.js turns this into a dialog that says what happened.
    const { data } = dbCrypto.readFile(DB_PATH)
    db = new SQL.Database(data)
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
// rename() is atomic, but on its own it only guarantees ordering of the
// directory entry — not that the temp file's BYTES reached the platter first.
// After a power loss the rename can therefore land while the new file is still
// partly zeroes, which is the same corruption the temp file was meant to
// prevent. fsync the data before the rename, then fsync the directory so the
// rename itself is durable.
function fsyncFile(file, flags) {
  let fd = null
  try {
    fd = fs.openSync(file, flags)
    fs.fsyncSync(fd)
  } catch { /* best-effort: filesystems may refuse fsync on directories */ }
  finally { if (fd !== null) try { fs.closeSync(fd) } catch {} }
}

function persist() {
  if (!db || persistDepth > 0) return
  // Encryption rides on the existing atomic write rather than replacing it: the
  // bytes are encrypted, then written to a temp file, fsynced, and renamed
  // exactly as before. An encrypted database that could be truncated by a power
  // cut would be worse than a plaintext one, since GCM refuses a truncated file
  // outright.
  const data = dbCrypto.encodeForWrite(Buffer.from(db.export()), dbCrypto.shouldEncrypt())
  const tmp = DB_PATH + '.tmp'
  try {
    fs.writeFileSync(tmp, data)
    fsyncFile(tmp, 'r+')
    fs.renameSync(tmp, DB_PATH)
    fsyncFile(CONFIG_DIR, 'r')
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

    -- Deletions the desktop has made but the cloud has not been told about yet.
    -- Cloud sync used to infer deletion from ABSENCE — any cloud row with no
    -- local counterpart was assumed deleted and removed. On a reinstalled or
    -- reset machine the local table is empty, so that inference deleted the
    -- user's entire cloud history. An explicit tombstone is the only safe
    -- signal: absence now means "this device hasn't seen it yet", which is a
    -- restore, not a delete.
    CREATE TABLE IF NOT EXISTS deleted_applications (
      local_id INTEGER PRIMARY KEY,
      deleted_at TEXT DEFAULT (datetime('now'))
    );

    -- Per-platform automation events, so a scraper that quietly stopped working
    -- can be told apart from a search that genuinely has no results. Bounded by
    -- pruning, not by retention rules: this is a diagnostic, not history.
    CREATE TABLE IF NOT EXISTS automation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      count INTEGER DEFAULT 0,
      at TEXT DEFAULT (datetime('now'))
    );

    -- Every time sync had to pick a winner, and what it discarded.
    --
    -- The desktop wins when both sides changed since the last sync, because it
    -- owns far more fields than the phone does. That is the right default and
    -- it stays — but it was silent, so a status set on the phone could vanish
    -- with no trace anywhere that it had ever existed. A conflict the user
    -- cannot see is indistinguishable from data loss.
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      job_title TEXT,
      company TEXT,
      field TEXT NOT NULL,
      local_value TEXT,
      remote_value TEXT,
      resolved_as TEXT NOT NULL,
      detected_at TEXT DEFAULT (datetime('now'))
    );

    -- What was actually sent, frozen at the moment it was sent.
    --
    -- The applications row is mutable: approving a held draft overwrites
    -- screening_qa, a re-tailor overwrites tailored_resume, and editing the
    -- master resume changes the base out from under every past application. So
    -- the row answers "what does this look like now", never "what did this
    -- employer receive". After a bad tailoring pass reaches an employer, that
    -- second question is the only one that matters, and it was unanswerable.
    --
    -- base_resume is stored in full rather than referenced: the whole point is
    -- that it survives the master resume being edited afterwards.
    CREATE TABLE IF NOT EXISTS application_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      taken_at TEXT DEFAULT (datetime('now')),
      base_resume TEXT,
      resume_name TEXT,
      tailored_resume TEXT,
      cover_letter TEXT,
      screening_qa TEXT,
      match_score INTEGER,
      status TEXT,
      -- Which model wrote this version. Without it, two snapshots of the same
      -- job are two blobs of text with no way to tell whether the difference
      -- came from a prompt change, a model change, or chance.
      provider TEXT,
      model TEXT
    );

    -- Notifications already sent, so a reminder that is recomputed on a
    -- two-minute sync loop arrives once rather than thirty times an hour.
    --
    -- The key is the EVENT ("the 24-hour reminder for interview 41"), not the
    -- send, and the row is written BEFORE the request goes out: claiming after a
    -- successful send would double-send whenever the response is lost, which is
    -- the common case on a laptop that just woke up. This has to survive a
    -- restart, so it is a table rather than a Set in memory.
    CREATE TABLE IF NOT EXISTS push_log (
      dedupe_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    -- Interviews mirrored into an external calendar, and what we last wrote
    -- there. Two-way sync needs three things this table holds and the
    -- interview_events row cannot: the provider's own id for the event, a hash
    -- of what we last pushed (so an unchanged event is not rewritten on every
    -- pass), and the direction of the last change (so an edit made in Google
    -- Calendar is not immediately overwritten by the local copy).
    CREATE TABLE IF NOT EXISTS calendar_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id INTEGER,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      -- Set when the event came FROM the calendar rather than from Hiro, so a
      -- deletion here does not delete an event the user created themselves.
      origin TEXT DEFAULT 'hiro',
      local_hash TEXT,
      remote_updated_at TEXT,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE (provider, external_id)
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
  try { db.run('CREATE INDEX IF NOT EXISTS idx_snapshots_app ON application_snapshots(application_id, taken_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_conflicts_at ON sync_conflicts(detected_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_automation_platform ON automation_events(platform, at DESC)') } catch {}
  try { db.run('ALTER TABLE application_snapshots ADD COLUMN provider TEXT') } catch {}
  try { db.run('ALTER TABLE application_snapshots ADD COLUMN model TEXT') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_interview_app ON interview_events(application_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_interview_at ON interview_events(scheduled_at)') } catch {}

  // ─── Pipeline ────────────────────────────────────────────────
  // The next thing the user has to DO about an application, and when. Status
  // says where the application got to; this says what is owed and by when, which
  // is the difference between a list of past events and a working pipeline.
  // Stored as local "YYYY-MM-DD" (a follow-up is a day, not an instant).
  try { db.run('ALTER TABLE applications ADD COLUMN next_action_at TEXT') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN next_action_note TEXT DEFAULT ""') } catch {}
  // Set when a next action is completed, so a cleared reminder is not silently
  // indistinguishable from one that was never set.
  try { db.run('ALTER TABLE applications ADD COLUMN next_action_done_at TEXT') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_next_action ON applications(next_action_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_push_log_at ON push_log(sent_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_calendar_interview ON calendar_links(interview_id)') } catch {}
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
  closing_date, follow_up_sent, resume_id, resume_name,
  next_action_at, next_action_note`

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
  // Freeze what was drafted. Only when something was actually generated —
  // rows created for skipped or unscored jobs carry no documents and a
  // snapshot of two empty strings is noise in the trail.
  if (newId && (data.tailored_resume || data.cover_letter)) {
    recordSnapshot(newId, status === 'held' ? 'drafted' : 'submitted', {
      base_resume: data.base_resume || '',
      resume_name: data.resume_name,
      tailored_resume: data.tailored_resume,
      cover_letter: data.cover_letter,
      screening_qa: data.screening_qa,
      match_score: data.match_score,
      status,
      provider: data.provider,
      model: data.model,
    })
  }
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
  // The submission snapshot is the one that matters: it is the only record of
  // the screening answers, which are written during the submit itself and
  // overwrite whatever the held row carried.
  const row = queryOne('SELECT * FROM applications WHERE id = ?', [id])
  if (row) {
    recordSnapshot(id, 'submitted', {
      base_resume: '',
      resume_name: row.resume_name,
      tailored_resume: row.tailored_resume,
      cover_letter: row.cover_letter,
      screening_qa: screeningQa || [],
      match_score: row.match_score,
      status: 'applied',
    })
  }
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

// ─── Automation health events ────────────────────────────────────

function recordAutomationEvent({ platform, kind, detail, count }) {
  if (!platform || !kind) return { success: false }
  run('INSERT INTO automation_events (platform, kind, detail, count) VALUES (?, ?, ?, ?)',
    [platform, kind, detail == null ? null : String(detail).slice(0, 500), Number(count) || 0])
  // Keep the log to a working window per platform. Unbounded growth would make
  // a diagnostic table the biggest thing in the database.
  run(`DELETE FROM automation_events
       WHERE platform = ?
         AND id NOT IN (SELECT id FROM automation_events WHERE platform = ? ORDER BY id DESC LIMIT 200)`,
    [platform, platform])
  return { success: true }
}

function getAutomationEvents(platform, limit = 40) {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 40
  return query(`SELECT * FROM automation_events WHERE platform = ? ORDER BY id DESC LIMIT ${n}`, [platform])
}

function clearAutomationEvents() {
  run('DELETE FROM automation_events')
  return { success: true }
}

// ─── Sync conflict log ───────────────────────────────────────────
// Append-only, same reasoning as the audit trail: the value of a record of what
// was overwritten is that it cannot itself be overwritten.

function recordSyncConflict({ applicationId, field, localValue, remoteValue, resolvedAs }) {
  if (!applicationId || !field) return { success: false }
  const row = queryOne('SELECT job_title, company FROM applications WHERE id = ?', [applicationId])
  run(`
    INSERT INTO sync_conflicts
      (application_id, job_title, company, field, local_value, remote_value, resolved_as)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    applicationId, row?.job_title || null, row?.company || null, field,
    localValue == null ? null : String(localValue),
    remoteValue == null ? null : String(remoteValue),
    resolvedAs,
  ])
  return { success: true }
}

function getSyncConflicts(limit = 100) {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100
  return query(`SELECT * FROM sync_conflicts ORDER BY detected_at DESC, id DESC LIMIT ${n}`)
}

function countSyncConflicts() {
  return queryOne('SELECT COUNT(*) as c FROM sync_conflicts')?.c || 0
}

function clearSyncConflicts() {
  run('DELETE FROM sync_conflicts')
  return { success: true }
}

// Take the discarded side after the fact. The remote value is kept in the log
// precisely so a wrong automatic resolution is recoverable.
function applyConflictResolution(id) {
  const conflict = queryOne('SELECT * FROM sync_conflicts WHERE id = ?', [id])
  if (!conflict) return { success: false, reason: 'Conflict not found' }
  if (conflict.field !== 'status' && conflict.field !== 'comment') {
    return { success: false, reason: `Cannot re-apply the "${conflict.field}" field` }
  }
  const exists = queryOne('SELECT id FROM applications WHERE id = ?', [conflict.application_id])
  if (!exists) return { success: false, reason: 'That application no longer exists' }

  run(`UPDATE applications SET ${conflict.field} = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?`,
    [conflict.remote_value, conflict.application_id])
  if (conflict.field === 'status') recordStatusChange(conflict.application_id, conflict.remote_value)
  run('UPDATE sync_conflicts SET resolved_as = ? WHERE id = ?', ['remote-applied', id])
  return { success: true }
}

// ─── Audit / version history ─────────────────────────────────────
// Snapshots are append-only. Nothing in here is ever updated in place —
// a record that can be rewritten after the fact is not an audit trail.

function recordSnapshot(applicationId, reason, data = {}) {
  if (!applicationId || !reason) return { success: false, reason: 'applicationId and reason are required' }
  run(`
    INSERT INTO application_snapshots
      (application_id, reason, base_resume, resume_name, tailored_resume, cover_letter, screening_qa, match_score, status, provider, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    applicationId, reason,
    data.base_resume || '', data.resume_name || null,
    data.tailored_resume || '', data.cover_letter || '',
    JSON.stringify(data.screening_qa || []),
    data.match_score ?? null, data.status || null,
    data.provider || null, data.model || null,
  ])
  return { success: true, id: queryOne('SELECT last_insert_rowid() as id')?.id }
}

// Slim list for the history trail. The documents are deliberately left out —
// a row with three full resumes on it makes the panel crawl.
function getSnapshots(applicationId) {
  return query(`
    SELECT id, application_id, reason, taken_at, match_score, status, provider, model,
           LENGTH(tailored_resume) as tailored_length,
           LENGTH(cover_letter) as cover_letter_length
    FROM application_snapshots
    WHERE application_id = ?
    ORDER BY taken_at DESC, id DESC
  `, [applicationId])
}

function getSnapshot(id) {
  const row = queryOne('SELECT * FROM application_snapshots WHERE id = ?', [id])
  if (!row) return null
  let screeningQa = []
  try { screeningQa = JSON.parse(row.screening_qa || '[]') } catch { screeningQa = [] }
  return { ...row, screening_qa: screeningQa }
}

// What the tailoring pass changed, for one snapshot.
function getSnapshotDiff(id) {
  const snap = getSnapshot(id)
  if (!snap) return null
  const { diffLines, diffSummary } = require('./textDiff')
  const diff = diffLines(snap.base_resume || '', snap.tailored_resume || '')
  return { id: snap.id, taken_at: snap.taken_at, reason: snap.reason, diff, summary: diffSummary(diff) }
}

// Compare two saved versions of the same application.
//
// The base-vs-tailored diff answers "what did the model change about me".
// This answers the other question — "is the new model actually better?" —
// which needs two generated outputs side by side, not one against the source.
function compareSnapshots(idA, idB, field = 'tailored_resume') {
  if (field !== 'tailored_resume' && field !== 'cover_letter') {
    return { error: `Cannot compare the "${field}" field` }
  }
  const a = getSnapshot(idA)
  const b = getSnapshot(idB)
  if (!a || !b) return { error: 'Snapshot not found' }
  if (a.application_id !== b.application_id) {
    // Diffing two different jobs' documents produces a wall of changes that
    // means nothing. Refuse rather than render nonsense.
    return { error: 'Those versions belong to different applications' }
  }
  const { diffLines, diffSummary } = require('./textDiff')
  const diff = diffLines(a[field] || '', b[field] || '')
  return {
    field,
    from: { id: a.id, reason: a.reason, taken_at: a.taken_at, provider: a.provider, model: a.model },
    to: { id: b.id, reason: b.reason, taken_at: b.taken_at, provider: b.provider, model: b.model },
    diff,
    summary: diffSummary(diff),
  }
}

// Undo: put a previous version's documents back on the live row.
//
// Takes its own snapshot of the current state first, so restoring is itself
// reversible — otherwise "undo" is a one-way door that can destroy the very
// version someone was trying to compare against.
function restoreSnapshot(id) {
  const snap = getSnapshot(id)
  if (!snap) return { success: false, reason: 'Snapshot not found' }
  const current = queryOne('SELECT * FROM applications WHERE id = ?', [snap.application_id])
  if (!current) return { success: false, reason: 'This application no longer exists' }

  recordSnapshot(snap.application_id, 'before-restore', {
    base_resume: '',
    resume_name: current.resume_name,
    tailored_resume: current.tailored_resume,
    cover_letter: current.cover_letter,
    screening_qa: safeParseQa(current.screening_qa),
    match_score: current.match_score,
    status: current.status,
  })

  run(`UPDATE applications
       SET tailored_resume = ?, cover_letter = ?, updated_at = datetime('now'), cloud_dirty = 1
       WHERE id = ?`, [snap.tailored_resume || '', snap.cover_letter || '', snap.application_id])
  return { success: true, applicationId: snap.application_id }
}

function safeParseQa(raw) {
  try { return JSON.parse(raw || '[]') } catch { return [] }
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
    // Tombstone first: if the process dies mid-delete, an extra tombstone for a
    // row that still exists is harmless (sync skips tombstones whose row is
    // present), whereas a missing tombstone silently resurrects the row.
    run('INSERT OR REPLACE INTO deleted_applications (local_id) VALUES (?)', [id])
    run('DELETE FROM applications WHERE id = ?', [id])
    run('DELETE FROM status_history WHERE application_id = ?', [id])
    run('DELETE FROM interview_prep WHERE application_id = ?', [id])
    run('DELETE FROM interview_events WHERE application_id = ?', [id])
  })
  return { success: true }
}

function clearAllApplications() {
  batch(() => {
    run('INSERT OR REPLACE INTO deleted_applications (local_id) SELECT id FROM applications')
    run('DELETE FROM applications')
    run('DELETE FROM status_history')
    run('DELETE FROM interview_prep')
    run('DELETE FROM interview_events')
    run('DELETE FROM application_snapshots')
    run('DELETE FROM sync_conflicts')
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

// Mark every row as needing an upload. Used when the user chooses to seed a
// cloud account from this device: without it only rows edited since the last
// sync would push, and a re-seed would silently upload a fraction of history.
function markAllDirty() {
  run("UPDATE applications SET cloud_dirty = 1, cloud_updated_at = NULL")
  return { success: true }
}

function countApplications() {
  return queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0
}

// Local ids the desktop has deleted and the cloud has not been told about yet.
// Guarded against a tombstone whose id was later reused by AUTOINCREMENT reuse
// or a restore — a row that exists again is not a deletion.
function getTombstones() {
  return query(
    'SELECT local_id FROM deleted_applications WHERE local_id NOT IN (SELECT id FROM applications)'
  ).map(r => r.local_id)
}

// Dropped only after the cloud delete is confirmed, so an interrupted sync
// retries the deletion next time instead of losing it.
function clearTombstones(ids) {
  if (!ids || ids.length === 0) return
  batch(() => {
    for (const id of ids) run('DELETE FROM deleted_applications WHERE local_id = ?', [id])
  })
}

// Write a cloud row back into the local database under its original id. Used
// when this device has never seen the row (fresh install, restored machine) —
// the cloud is the only remaining copy, so it is a recovery, not a conflict.
// Inserted clean (cloud_dirty = 0) so restoring does not immediately re-push
// everything it just pulled down.
function restoreApplicationFromCloud(r) {
  run(
    `INSERT OR IGNORE INTO applications
      (id, job_title, company, platform, salary, salary_min, salary_max, job_url,
       job_description, match_score, match_explanation, tailored_resume, cover_letter,
       screening_qa, comment, recruiter_email, status, resume_id, resume_name,
       held_at, applied_at, updated_at, cloud_dirty, cloud_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    [
      r.local_id, r.job_title || '', r.company || '', r.platform || '', r.salary || '',
      r.salary_min ?? null, r.salary_max ?? null, r.job_url || '', r.job_description || '',
      r.match_score ?? null, r.match_explanation || '', r.tailored_resume || '',
      r.cover_letter || '', r.screening_qa || '', r.comment || '', r.recruiter_email || '',
      r.status || 'applied', r.resume_id || null, r.resume_name || null,
      r.held_at || null, r.applied_at || null, r.updated_at || null, r.updated_at || null,
    ]
  )
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
           a.job_title, a.company, a.platform, a.job_url
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
  `)
}

// Move an interview. Used by calendar sync when the user rescheduled the event in
// their own calendar: the time changes and so does `source`, because it is no
// longer the time Hiro parsed out of an email and pretending otherwise would
// mislabel it as auto-detected forever.
function updateInterviewEventTime(id, { scheduledAt, hasTime = true, source = null }) {
  if (source) {
    run('UPDATE interview_events SET scheduled_at = ?, has_time = ?, source = ? WHERE id = ?',
      [scheduledAt, hasTime ? 1 : 0, source, id])
  } else {
    run('UPDATE interview_events SET scheduled_at = ?, has_time = ? WHERE id = ?',
      [scheduledAt, hasTime ? 1 : 0, id])
  }
  return { success: true }
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

  // Every nullable binding is coerced, because sql.js refuses `undefined` — and
  // it refuses it by throwing a bare STRING, not an Error. The applicator's
  // catch logged `err.message`, so a caller that omitted one optional field
  // produced "Scan error: undefined" and lost the job. That is exactly what
  // happened to every ATS-board match: nothing set job_description on the job
  // object, so the insert threw and the whole feature silently saved nothing.
  run(`
    INSERT INTO attention_jobs
      (job_title, company, platform, salary, job_url, job_description, match_score, talking_points, reason, closing_date, salary_min, salary_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title ?? '', data.company ?? '', data.platform ?? '', data.salary || '',
    data.job_url ?? '', data.job_description ?? '', data.match_score ?? null,
    JSON.stringify(data.talking_points || []), data.reason || '',
    data.closing_date || null,
    parsed.salary_min ?? null, parsed.salary_max ?? null,
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
const UNSENT_ONLY = `status IN (${UNSENT_SQL})`

function getStats() {
  const interviews = queryOne("SELECT COUNT(*) as c FROM applications WHERE status IN ('interview', 'offer')")?.c || 0
  const responded = queryOne(`SELECT COUNT(*) as c FROM applications WHERE status IN (${RESPONDED_SQL})`)?.c || 0
  const appliedCount = queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY}`)?.c || 0

  return {
    // Every "applied" count is SENT_ONLY. They used to be plain COUNT(*), so a
    // dry run that skipped everything below the threshold — or a review-mode
    // scan that held ten jobs — reported ten applications the employer never
    // received. The unsent rows are still surfaced, as unsentToday/heldCount
    // and in byStatus, rather than hidden.
    totalAllTime: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY}`)?.c || 0,
    totalToday: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${TODAY_START}`)?.c || 0,
    totalThisWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${WEEK_START}`)?.c || 0,
    totalLastWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${LAST_WEEK_START} AND applied_at < ${WEEK_START}`)?.c || 0,
    // Scored-and-skipped or held today. Lets the UI say "3 applied · 12 skipped"
    // instead of leaving the user wondering where a busy scan went.
    unsentToday: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${UNSENT_ONLY} AND applied_at >= ${TODAY_START}`)?.c || 0,
    // Rows of every kind, including never-submitted ones — the size of the
    // local database rather than a count of applications.
    rowsAllTime: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    interviews,
    attentionCount: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    // Jobs parked by review mode, waiting for the user to approve or reject.
    heldCount: queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'held'")?.c || 0,
    byPlatform: query(`SELECT platform, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} GROUP BY platform`),
    // byStatus deliberately keeps every row: it is a breakdown BY status, so
    // 'skipped' and 'held' are the point rather than a distortion.
    byStatus: query("SELECT status, COUNT(*) as count FROM applications GROUP BY status"),
    todayJobs: query(`SELECT job_title, company, platform, match_score, status FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${TODAY_START} ORDER BY applied_at DESC`),
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

// Both chart series count SUBMITTED applications only, matching the "Today" and
// "This Week" tiles. A skipped or held row on the same day would otherwise draw
// a spike that no employer ever saw.
function getApplicationsByDate() {
  return query(`SELECT DATE(applied_at,'localtime') as date, platform, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} GROUP BY DATE(applied_at,'localtime'), platform ORDER BY date DESC`)
}

function getApplicationsPerDay(days) {
  const rows = query(
    `SELECT DATE(applied_at,'localtime') as date, COUNT(*) as count FROM applications
     WHERE ${SENT_ONLY}
       AND applied_at >= datetime('now','localtime','start of day','-' || ? || ' days','utc')
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

// ─── Pipeline: next actions ──────────────────────────────────────
// `status` records where an application GOT TO. It cannot record what the user
// still owes it — chase the recruiter on Thursday, send the take-home by Friday
// — which is why applications quietly died of neglect while the board looked
// healthy. next_action_at/note is that missing half.
//
// Dates are local "YYYY-MM-DD": a follow-up is a day, not an instant, and
// storing it as UTC would move it across midnight for half the world.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function setNextAction(id, { date, note }) {
  const clean = date && DATE_ONLY.test(String(date).trim()) ? String(date).trim() : null
  if (date && !clean) return { success: false, reason: 'Date must be YYYY-MM-DD.' }
  run(
    `UPDATE applications
     SET next_action_at = ?, next_action_note = ?, next_action_done_at = NULL,
         updated_at = datetime('now'), cloud_dirty = 1
     WHERE id = ?`,
    [clean, note || '', id]
  )
  return { success: true }
}

// Completing an action is not the same as never having had one: the date is
// cleared so it stops being due, but next_action_done_at records that it was
// dealt with, which is what stops the pipeline nudge re-flagging the row
// immediately.
function completeNextAction(id) {
  run(
    `UPDATE applications
     SET next_action_at = NULL, next_action_done_at = datetime('now'),
         updated_at = datetime('now'), cloud_dirty = 1
     WHERE id = ?`,
    [id]
  )
  return { success: true }
}

// Actions due today or overdue. Drives the pipeline's "Overdue" column and the
// follow-up push notification.
function getDueNextActions() {
  return query(`
    SELECT id, job_title, company, status, next_action_at, next_action_note
    FROM applications
    WHERE next_action_at IS NOT NULL
      AND next_action_at <= date('now','localtime')
      AND ${SENT_ONLY}
    ORDER BY next_action_at ASC
  `)
}

// Which pipeline column a row belongs to. Derived from status rather than stored
// so an existing database needs no backfill and the board can never disagree
// with the status shown everywhere else.
const PIPELINE_STAGES = [
  { id: 'applied', label: 'Applied', statuses: ['applied'] },
  { id: 'waiting', label: 'No reply yet', statuses: ['no_response', 'pending'] },
  { id: 'interview', label: 'Interviewing', statuses: ['interview'] },
  { id: 'offer', label: 'Offer', statuses: ['offer'] },
  { id: 'closed', label: 'Closed', statuses: ['rejected'] },
]

// Everything the pipeline board needs in one read: the rows, their stage, and
// how overdue each one is. Held and skipped rows are excluded — they were never
// sent, so there is nothing to chase.
function getPipeline() {
  const rows = query(`
    SELECT id, job_title, company, platform, status, match_score, salary,
           applied_at, updated_at, next_action_at, next_action_note, next_action_done_at,
           recruiter_email, closing_date, job_url
    FROM applications
    WHERE ${SENT_ONLY}
    ORDER BY
      CASE WHEN next_action_at IS NULL THEN 1 ELSE 0 END,
      next_action_at ASC,
      applied_at DESC
  `)

  const today = queryOne("SELECT date('now','localtime') as d")?.d || ''
  const stageOf = (status) => PIPELINE_STAGES.find(s => s.statuses.includes(status))?.id || 'applied'

  // A row nobody has looked at in this long, with no action booked, is the thing
  // that actually goes missing — no status change, no reply, no reminder.
  const nudgeDays = Number(configService.load().pipelineNudgeDays) || 0
  const staleBefore = nudgeDays > 0
    ? queryOne("SELECT date('now','localtime','-' || ? || ' days') as d", [nudgeDays])?.d
    : null

  const upcomingByApp = new Map()
  for (const ev of getUpcomingInterviews(200)) {
    if (!upcomingByApp.has(ev.application_id)) upcomingByApp.set(ev.application_id, ev)
  }

  return {
    stages: PIPELINE_STAGES.map(({ id, label }) => ({ id, label })),
    today,
    items: rows.map(r => {
      const due = r.next_action_at || null
      const lastTouched = (r.updated_at || r.applied_at || '').slice(0, 10)
      return {
        ...r,
        stage: stageOf(r.status),
        overdue: !!(due && due < today),
        dueToday: !!(due && due === today),
        // Only for rows that are still live: a rejection needs no nudge.
        needsAction: !due
          && !!staleBefore
          && lastTouched !== '' && lastTouched < staleBefore
          && !['rejected', 'offer'].includes(r.status),
        nextInterview: upcomingByApp.get(r.id)
          ? {
            scheduled_at: upcomingByApp.get(r.id).scheduled_at,
            has_time: upcomingByApp.get(r.id).has_time,
          }
          : null,
      }
    }),
  }
}

// Applications and Needs Attention jobs whose listing closes within `days` and
// which have NOT been submitted — the only ones where the deadline still means
// something. `source` tells the caller which table a row came from, since the
// two have separate id spaces.
function getClosingSoon(days) {
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0) return []
  const bound = "date('now','localtime','+' || ? || ' days')"
  const held = query(`
    SELECT id, job_title, company, closing_date, 'application' as source
    FROM applications
    WHERE status = 'held' AND closing_date IS NOT NULL AND closing_date != ''
      AND closing_date >= date('now','localtime') AND closing_date <= ${bound}
  `, [n])
  const attention = query(`
    SELECT id, job_title, company, closing_date, 'attention' as source
    FROM attention_jobs
    WHERE dismissed = 0 AND closing_date IS NOT NULL AND closing_date != ''
      AND closing_date >= date('now','localtime') AND closing_date <= ${bound}
  `, [n])
  return [...held, ...attention].sort((a, b) => a.closing_date.localeCompare(b.closing_date))
}

// ─── Push notification ledger ────────────────────────────────────
// Claim a dedupe key. Returns false when this event has already been notified —
// the INSERT is the claim, so two callers racing cannot both win.
function claimPushKey(dedupeKey, kind, title, body) {
  try {
    run('INSERT INTO push_log (dedupe_key, kind, title, body) VALUES (?, ?, ?, ?)',
      [dedupeKey, kind, title || '', body || ''])
    return true
  } catch {
    // PRIMARY KEY violation: already claimed.
    return false
  }
}

function getPushLog(limit = 50) {
  return query('SELECT * FROM push_log ORDER BY sent_at DESC LIMIT ?', [limit])
}

// The ledger is a dedupe mechanism, not history — nothing needs a reminder key
// from six months ago, and interview keys embed a date that can never recur.
function prunePushLog(days = 90) {
  run("DELETE FROM push_log WHERE sent_at < datetime('now', '-' || ? || ' days')", [days])
  return { success: true }
}

// ─── Calendar links ──────────────────────────────────────────────
// See the calendar_links CREATE TABLE for why two-way sync needs its own table.

function getCalendarLink({ interviewId, provider, externalId }) {
  if (externalId) {
    return queryOne('SELECT * FROM calendar_links WHERE provider = ? AND external_id = ?', [provider, externalId])
  }
  return queryOne('SELECT * FROM calendar_links WHERE provider = ? AND interview_id = ?', [provider, interviewId])
}

function saveCalendarLink({ interviewId, provider, externalId, origin = 'hiro', localHash = null, remoteUpdatedAt = null }) {
  const existing = getCalendarLink({ provider, externalId })
  if (existing) {
    run(
      `UPDATE calendar_links
       SET interview_id = ?, local_hash = ?, remote_updated_at = ?, synced_at = datetime('now')
       WHERE id = ?`,
      [interviewId ?? null, localHash, remoteUpdatedAt, existing.id]
    )
    return { success: true, id: existing.id }
  }
  run(
    `INSERT INTO calendar_links (interview_id, provider, external_id, origin, local_hash, remote_updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [interviewId ?? null, provider, externalId, origin, localHash, remoteUpdatedAt]
  )
  return { success: true }
}

function getCalendarLinks(provider) {
  return query('SELECT * FROM calendar_links WHERE provider = ?', [provider])
}

function deleteCalendarLink(id) {
  run('DELETE FROM calendar_links WHERE id = ?', [id])
  return { success: true }
}

// Links whose interview no longer exists locally. The calendar event they point
// at has to be removed too, but only when Hiro created it — an event the user
// made in their own calendar is theirs.
function getOrphanedCalendarLinks(provider) {
  return query(`
    SELECT c.* FROM calendar_links c
    LEFT JOIN interview_events e ON e.id = c.interview_id
    WHERE c.provider = ? AND (c.interview_id IS NULL OR e.id IS NULL)
  `, [provider])
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

  // Every row in the window, so byStatus can report what was held or skipped.
  // Each headline number below is then derived from the SUBMITTED subset — a
  // weekly report that counts held jobs as applications is worse than no report.
  const rows = query('SELECT * FROM applications WHERE applied_at >= ? AND applied_at < ?', [dateFrom, dateTo])
  const byStatus = {}
  for (const a of rows) byStatus[a.status] = (byStatus[a.status] || 0) + 1

  const apps = rows.filter(a => !UNSENT_STATUSES.includes(a.status))
  const totalApps = apps.length
  const byPlatform = {}
  let matchSum = 0
  for (const a of apps) {
    byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1
    matchSum += a.match_score || 0
  }
  const interviews = (byStatus.interview || 0) + (byStatus.offer || 0)
  const responded = RESPONDED_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0)
  const unsent = rows.length - totalApps

  return {
    // Labels stay in local time — toISOString() is UTC and would shift the
    // displayed dates back a day in UTC+ timezones.
    dateFrom: localDate(monday),
    dateTo: localDate(sunday),
    totalApps,
    // Drafted but never sent this week, reported alongside rather than folded in.
    unsentApps: unsent,
    byPlatform,
    byStatus,
    avgMatchScore: totalApps > 0 ? Math.round(matchSum / totalApps) : 0,
    responseRate: totalApps > 0 ? Math.round((responded / totalApps) * 100) : 0,
    interviewRate: totalApps > 0 ? Math.round((interviews / totalApps) * 100) : 0,
    perDay: query(`SELECT DATE(applied_at,'localtime') as date, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} AND applied_at >= ? AND applied_at < ? GROUP BY DATE(applied_at,'localtime') ORDER BY date`, [dateFrom, dateTo]),
    topCompanies: query(`SELECT company, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} AND applied_at >= ? AND applied_at < ? GROUP BY company ORDER BY count DESC LIMIT 5`, [dateFrom, dateTo]),
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

function backupFileNames() {
  if (!fs.existsSync(BACKUP_DIR)) return []
  return fs.readdirSync(BACKUP_DIR).filter(f => /^autoapply-[\w.-]+\.db$/.test(f))
}

function listBackups() {
  try {
    return backupFileNames()
      .sort().reverse()
      .map(name => {
        const file = path.join(BACKUP_DIR, name)
        const st = fs.statSync(file)
        let encrypted = false
        try {
          // Only the header is needed to classify a file; reading a 40 MB backup
          // to answer "is this encrypted" would make opening Settings slow.
          const fd = fs.openSync(file, 'r')
          try {
            const head = Buffer.alloc(dbCrypto.HEADER_BYTES)
            fs.readSync(fd, head, 0, head.length, 0)
            encrypted = dbCrypto.isEncrypted(head)
          } finally { fs.closeSync(fd) }
        } catch { /* report it as plaintext rather than failing the list */ }
        return { name, size: st.size, mtime: st.mtime.toISOString(), encrypted }
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
  // A backup made before encryption was turned on is plaintext, and one made
  // after is not — readFile accepts either, so a restore never depends on which
  // era the file came from. It can still fail (a backup from a profile whose key
  // is gone), and that has to be reported rather than leaving an empty database.
  let data
  try {
    ({ data } = dbCrypto.readFile(file))
  } catch (err) {
    return { success: false, error: err.message, snapshot }
  }
  db = new SQL.Database(data)
  createTables()
  migrate()
  persist()
  prunePreRestoreSnapshots()
  return { success: true, snapshot }
}

// ─── Encryption at rest ──────────────────────────────────────────
// See services/dbCrypto.js for the scheme and its one unavoidable cost.

// Every file whose contents are the database: the live one and every backup.
// Turning encryption on has to cover all of them — an encrypted database beside
// seven plaintext daily backups protects nothing.
function encryptedFileSet() {
  return [DB_PATH, ...backupFileNames().map(n => path.join(BACKUP_DIR, n))]
}

function setEncryption(enabled) {
  const want = !!enabled
  if (want === !!configService.load().encryptDatabase) {
    return { success: true, unchanged: true }
  }
  // Flush first: the in-memory database is the truth, and converting a stale file
  // would lose whatever has not been written yet.
  persist()

  let result
  try {
    result = dbCrypto.convertAll(encryptedFileSet(), want)
  } catch (err) {
    return { success: false, error: err.message }
  }
  // The setting flips only after the files are already in the target state, so an
  // interrupted switch leaves files the CURRENT setting can still read.
  configService.update({ encryptDatabase: want })
  logger().append(
    `Database encryption ${want ? 'enabled' : 'disabled'} — converted ${result.converted.length} file(s)`
    + (result.failed.length ? `, ${result.failed.length} could not be converted` : '')
  )
  return { success: true, ...result, enabled: want }
}

// Lazy: logger requires config, and requiring it at the top of database.js would
// add a second edge to a module graph that is already circular through config.
function logger() {
  return require('./logger')
}

function getEncryptionStatus() {
  const status = dbCrypto.getStatus()
  const backups = listBackups()
  return {
    ...status,
    // "Enabled" is not the same as "everything is actually encrypted": a backup
    // that could not be converted is still readable plaintext, and the UI has to
    // be able to say so.
    databaseEncrypted: (() => {
      try {
        if (!fs.existsSync(DB_PATH)) return false
        const fd = fs.openSync(DB_PATH, 'r')
        try {
          const head = Buffer.alloc(dbCrypto.HEADER_BYTES)
          fs.readSync(fd, head, 0, head.length, 0)
          return dbCrypto.isEncrypted(head)
        } finally { fs.closeSync(fd) }
      } catch { return false }
    })(),
    backupCount: backups.length,
    plaintextBackups: backups.filter(b => !b.encrypted).map(b => b.name),
  }
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
  return { dbSize, counts, encryption: getEncryptionStatus() }
}

module.exports = {
  init, batch, pruneOrphanedRows, backfillSalaryColumns,
  getApplications, getApplicationsList, getApplication, hasJobUrl, hasAttentionJobUrl, hasSeenJobUrl,
  findRecentApplicationToCompany, insertApplication, updateApplicationStatus,
  getHeldApplications, markHeldApplied, rejectHeldApplication,
  recordSnapshot, getSnapshots, getSnapshot, getSnapshotDiff, compareSnapshots, restoreSnapshot,
  recordAutomationEvent, getAutomationEvents, clearAutomationEvents,
  recordSyncConflict, getSyncConflicts, countSyncConflicts, clearSyncConflicts, applyConflictResolution,
  getResumeConversion, recordAiUsage, getAiUsageSummary, getMonthlyAiSpend, pruneAiUsage, clearAiUsage,
  UNSENT_STATUSES,
  updateApplicationAfterApply, updateApplicationComment, updateRecruiterEmail, deleteApplication, clearAllApplications,
  getDirtyApplications, getAllApplicationIds, markCloudSynced, markCloudSeen, applyCloudEdit,
  countApplications, markAllDirty, getTombstones, clearTombstones, restoreApplicationFromCloud,
  getAttentionJobs, getAttentionJob, insertAttentionJob, dismissAttentionJob, deleteAttentionJob, clearAllAttentionJobs,
  getAllInterviewEventsForSync,
  getCachedAnswer, saveCachedAnswer, getAllCachedAnswers, deleteCachedAnswer, clearAllCachedAnswers,
  getStats, getTodayCountByPlatform, getSalaryStats,
  findDuplicateAcrossPlatforms, getApplicationsByDate, getApplicationsPerDay,
  getApplicationsForFollowUp, markFollowUpSent,
  getApplicationsAwaitingReply, setLastReplyUid, markStaleApplications, OPEN_STATUSES,
  saveInterviewPrep, getInterviewPrep, deleteInterviewPrep,
  addInterviewEvent, upsertDetectedInterview, getInterviewEvents, getUpcomingInterviews, getInterviewEvent, deleteInterviewEvent,
  updateInterviewEventTime,
  updateClosingDate, getScoreBandConversion,
  setNextAction, completeNextAction, getDueNextActions, getPipeline, getClosingSoon, PIPELINE_STAGES,
  claimPushKey, getPushLog, prunePushLog,
  getCalendarLink, getCalendarLinks, saveCalendarLink, deleteCalendarLink, getOrphanedCalendarLinks,
  getWeeklyReportData, getStorageInfo,
  getStatusHistory,
  backupNow, maybeBackup, listBackups, restoreBackup,
  setEncryption, getEncryptionStatus,
  exportRecoveryKey: () => dbCrypto.exportRecoveryKey(),
  importRecoveryKey: (text) => dbCrypto.importRecoveryKey(text),
}
