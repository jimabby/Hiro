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

  db.run('PRAGMA journal_mode = WAL')
  createTables()
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
      updated_at TEXT DEFAULT (datetime('now'))
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
  `)
  persist()
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

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY applied_at DESC'
  return query(sql, params)
}

function getApplication(id) {
  return queryOne('SELECT * FROM applications WHERE id = ?', [id])
}

function insertApplication(data) {
  run(`
    INSERT INTO applications
      (job_title, company, platform, salary, job_url, job_description, match_score, tailored_resume, screening_qa, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title, data.company, data.platform, data.salary || '',
    data.job_url, data.job_description, data.match_score,
    data.tailored_resume, JSON.stringify(data.screening_qa || []),
    data.status || 'applied',
  ])
}

function updateApplicationStatus(id, status) {
  run("UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id])
  return { success: true }
}

// ─── Attention Jobs ──────────────────────────────────────────────

function getAttentionJobs() {
  return query('SELECT * FROM attention_jobs WHERE dismissed = 0 ORDER BY found_at DESC')
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

// ─── Stats ───────────────────────────────────────────────────────

function getStats() {
  const today = new Date().toISOString().split('T')[0]
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]

  return {
    totalAllTime: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    totalToday: queryOne("SELECT COUNT(*) as c FROM applications WHERE applied_at >= ?", [today + 'T00:00:00'])?.c || 0,
    totalThisWeek: queryOne("SELECT COUNT(*) as c FROM applications WHERE applied_at >= ?", [weekAgo + 'T00:00:00'])?.c || 0,
    interviews: queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'interview'")?.c || 0,
    attentionCount: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    byPlatform: query("SELECT platform, COUNT(*) as count FROM applications GROUP BY platform"),
    byStatus: query("SELECT status, COUNT(*) as count FROM applications GROUP BY status"),
    todayJobs: query("SELECT job_title, company, platform, match_score, status FROM applications WHERE applied_at >= ? ORDER BY applied_at DESC", [today + 'T00:00:00']),
  }
}

function getTodayCountByPlatform(platform) {
  const today = new Date().toISOString().split('T')[0]
  return queryOne(
    "SELECT COUNT(*) as c FROM applications WHERE platform = ? AND applied_at >= ?",
    [platform, today + 'T00:00:00']
  )?.c || 0
}

module.exports = {
  init,
  getApplications, getApplication, insertApplication, updateApplicationStatus,
  getAttentionJobs, insertAttentionJob, dismissAttentionJob,
  getStats, getTodayCountByPlatform,
}
