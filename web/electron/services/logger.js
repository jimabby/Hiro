// Persistent activity log. Scan/scheduler/apply messages are appended to a file
// in the config dir so failed scrapes stay diagnosable after the app is closed
// (the in-memory renderer log is lost on quit). Size-capped with one rotation.

const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')

const LOG_DIR = path.join(CONFIG_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'hiro.log')
const OLD_FILE = path.join(LOG_DIR, 'hiro.log.1')
const MAX_BYTES = 2 * 1024 * 1024 // 2 MB, then rotate to .1

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
}

// Logging must never throw — a disk error here should not abort a scan.
function append(msg) {
  try {
    ensureDir()
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
      try { fs.renameSync(LOG_FILE, OLD_FILE) } catch { /* keep appending to current */ }
    }
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`)
  } catch { /* ignore */ }
}

// Return the most recent `maxLines` lines (oldest → newest).
function tail(maxLines = 500) {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-maxLines)
  } catch {
    return []
  }
}

function clear() {
  try {
    if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '')
    if (fs.existsSync(OLD_FILE)) fs.unlinkSync(OLD_FILE)
  } catch { /* ignore */ }
  return { success: true }
}

// Ensure the file exists (so "open log file" never fails) and return its path.
function getPath() {
  try { ensureDir(); if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '') } catch { /* ignore */ }
  return LOG_FILE
}

module.exports = { append, tail, clear, getPath }
