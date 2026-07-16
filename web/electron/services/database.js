const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')

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

function persist() {
  if (!db) return
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
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

  // Indexes for frequent queries
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_applied_at ON applications(applied_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_platform ON applications(platform)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_dismissed ON attention_jobs(dismissed)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_history_app ON status_history(application_id)') } catch {}
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

function getApplications(filters = {}) {
  let sql = 'SELECT * FROM applications'
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

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY applied_at DESC'
  return query(sql, params)
}

function getApplication(id) {
  return queryOne('SELECT * FROM applications WHERE id = ?', [id])
}

function hasJobUrl(jobUrl) {
  return !!queryOne('SELECT 1 FROM applications WHERE job_url = ? LIMIT 1', [jobUrl])
}

function hasAppliedToCompany(company) {
  const result = queryOne(
    "SELECT COUNT(*) as c FROM applications WHERE LOWER(company) = LOWER(?) AND status != 'skipped'",
    [company]
  )
  return (result?.c || 0) > 0
}

function insertApplication(data) {
  db.run(`
    INSERT INTO applications
      (job_title, company, platform, salary, job_url, job_description, match_score, match_explanation, tailored_resume, cover_letter, screening_qa, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title, data.company, data.platform, data.salary || '',
    data.job_url, data.job_description, data.match_score,
    data.match_explanation || '',
    data.tailored_resume, data.cover_letter || '',
    JSON.stringify(data.screening_qa || []),
    data.status || 'applied',
  ])
  // Read the new row id BEFORE persist(): db.export() resets last_insert_rowid.
  const newId = queryOne('SELECT last_insert_rowid() as id')?.id
  if (newId) db.run('INSERT INTO status_history (application_id, status) VALUES (?, ?)', [newId, data.status || 'applied'])
  persist()
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

function updateApplicationAfterApply(id, tailoredResume, coverLetter) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(
    "UPDATE applications SET status = 'applied', tailored_resume = ?, cover_letter = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?",
    [tailoredResume, coverLetter, id]
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

function deleteApplication(id) {
  run('DELETE FROM applications WHERE id = ?', [id])
  run('DELETE FROM status_history WHERE application_id = ?', [id])
  return { success: true }
}

function clearAllApplications() {
  run('DELETE FROM applications')
  run('DELETE FROM status_history')
  return { success: true }
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

// ─── Attention Jobs ──────────────────────────────────────────────

function getAttentionJobs() {
  return query('SELECT * FROM attention_jobs WHERE dismissed = 0 ORDER BY found_at DESC')
}

function getAttentionJob(id) {
  return queryOne('SELECT * FROM attention_jobs WHERE id = ?', [id])
}

function insertAttentionJob(data) {
  run(`
    INSERT INTO attention_jobs
      (job_title, company, platform, salary, job_url, job_description, match_score, talking_points, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title, data.company, data.platform, data.salary || '',
    data.job_url, data.job_description, data.match_score,
    JSON.stringify(data.talking_points || []), data.reason || '',
  ])
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

function getStats() {
  const interviews = queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'interview'")?.c || 0
  const appliedCount = queryOne("SELECT COUNT(*) as c FROM applications WHERE status != 'skipped'")?.c || 0

  return {
    totalAllTime: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    totalToday: queryOne(`SELECT COUNT(*) as c FROM applications WHERE applied_at >= ${TODAY_START}`)?.c || 0,
    totalThisWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE applied_at >= ${WEEK_START}`)?.c || 0,
    totalLastWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE applied_at >= ${LAST_WEEK_START} AND applied_at < ${WEEK_START}`)?.c || 0,
    interviews,
    attentionCount: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    byPlatform: query("SELECT platform, COUNT(*) as count FROM applications GROUP BY platform"),
    byStatus: query("SELECT status, COUNT(*) as count FROM applications GROUP BY status"),
    todayJobs: query(`SELECT job_title, company, platform, match_score, status FROM applications WHERE applied_at >= ${TODAY_START} ORDER BY applied_at DESC`),
    responseRate: appliedCount > 0 ? Math.round((interviews / appliedCount) * 100) : 0,
  }
}

function getTodayCountByPlatform(platform) {
  return queryOne(
    `SELECT COUNT(*) as c FROM applications WHERE platform = ? AND applied_at >= ${TODAY_START}`,
    [platform]
  )?.c || 0
}

function findDuplicateAcrossPlatforms(jobTitle, company, currentPlatform) {
  return queryOne(
    "SELECT id, platform FROM applications WHERE LOWER(job_title) = LOWER(?) AND LOWER(company) = LOWER(?) AND platform != ? AND status != 'skipped' LIMIT 1",
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

function getApplicationsForFollowUp(daysOld) {
  return query("SELECT * FROM applications WHERE status = 'applied' AND follow_up_sent = 0 AND applied_at <= datetime('now', '-' || ? || ' days')", [daysOld])
}

function markFollowUpSent(id) {
  run('UPDATE applications SET follow_up_sent = 1 WHERE id = ?', [id])
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
  const interviews = byStatus.interview || 0
  const applied = totalApps - (byStatus.skipped || 0)

  return {
    // Labels stay in local time — toISOString() is UTC and would shift the
    // displayed dates back a day in UTC+ timezones.
    dateFrom: localDate(monday),
    dateTo: localDate(sunday),
    totalApps,
    byPlatform,
    byStatus,
    avgMatchScore: totalApps > 0 ? Math.round(matchSum / totalApps) : 0,
    responseRate: applied > 0 ? Math.round((interviews / applied) * 100) : 0,
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
  } catch { /* pruning is best-effort */ }
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
  try { fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, 'autoapply-pre-restore.db')) } catch {}
  db = new SQL.Database(fs.readFileSync(file))
  createTables()
  migrate()
  persist()
  return { success: true }
}

function getStorageInfo() {
  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0
  const counts = {
    applications: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    attentionJobs: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    cachedAnswers: queryOne('SELECT COUNT(*) as c FROM screening_cache')?.c || 0,
    interviewPreps: queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0,
  }
  return { dbSize, counts }
}

module.exports = {
  init,
  getApplications, getApplication, hasJobUrl, hasAppliedToCompany, insertApplication, updateApplicationStatus,
  updateApplicationAfterApply, updateApplicationComment, updateRecruiterEmail, deleteApplication, clearAllApplications,
  getDirtyApplications, getAllApplicationIds, markCloudSynced, markCloudSeen, applyCloudEdit,
  getAttentionJobs, getAttentionJob, insertAttentionJob, dismissAttentionJob, deleteAttentionJob, clearAllAttentionJobs,
  getCachedAnswer, saveCachedAnswer, getAllCachedAnswers, deleteCachedAnswer, clearAllCachedAnswers,
  getStats, getTodayCountByPlatform,
  findDuplicateAcrossPlatforms, getApplicationsByDate, getApplicationsPerDay,
  getApplicationsForFollowUp, markFollowUpSent,
  saveInterviewPrep, getInterviewPrep, deleteInterviewPrep,
  getWeeklyReportData, getStorageInfo,
  getStatusHistory,
  backupNow, maybeBackup, listBackups, restoreBackup,
}
