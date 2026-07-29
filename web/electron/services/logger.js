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
//
// Reads only the tail of the file rather than all of it. The phone polls this
// through /api/logs every couple of seconds while a scan runs, and the log is
// capped at 2 MB — so the naive readFileSync was re-reading and re-splitting
// two megabytes several times a second to show forty lines.
const AVG_LINE_BYTES = 160

function tail(maxLines = 500) {
  let fd = null
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    const size = fs.statSync(LOG_FILE).size
    if (size === 0) return []

    fd = fs.openSync(LOG_FILE, 'r')

    // Over-read generously so a few long lines can't leave us short, then grow
    // the window if that still wasn't enough. A single very long line (a
    // scraper dumping a page into an error message) can be bigger than any
    // fixed guess, and reading a window that lands entirely inside one line
    // would otherwise yield nothing at all.
    let want = Math.min(size, Math.max(8192, maxLines * AVG_LINE_BYTES * 2))
    for (;;) {
      const start = size - want
      const buf = Buffer.alloc(want)
      fs.readSync(fd, buf, 0, want, start)

      let text = buf.toString('utf8')
      // A partial first line when we didn't start at byte 0 — drop it rather
      // than show a fragment.
      if (start > 0) {
        const nl = text.indexOf('\n')
        text = nl === -1 ? '' : text.slice(nl + 1)
      }
      const lines = text.split('\n').filter(Boolean)

      // Enough lines, or we've already read the whole file and this is all
      // there is.
      if (lines.length >= maxLines || want >= size) return lines.slice(-maxLines)
      want = Math.min(size, want * 4)
    }
  } catch {
    return []
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
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
