// What each paired device has been asking the desktop for.
//
// A device token is a 90-day credential that lives on hardware the user does not
// have in front of them. "Last seen" says that it is being used, not what for —
// and the question that matters after a phone goes missing, or an extension is
// installed on a shared browser, is exactly that: what did it do?
//
// The last MAX_PER_DEVICE requests per device are kept in memory and written to
// a small file of their own, debounced. Not config.json: that file is rewritten
// whole and its secrets re-wrapped on every save, which is far too much work to
// do per request, and an activity log is not a setting anyone exports.
//
// Recorded: the method and path (never the query string or the body — those can
// hold search terms and personal text), the time, the peer address and the HTTP
// status the desktop answered with.

const fs = require('fs')
const path = require('path')
const configService = require('./config')

const MAX_PER_DEVICE = 200
const FLUSH_DELAY_MS = 5000
const FILE = () => path.join(configService.CONFIG_DIR, 'mobile-activity.json')

let entries = null // deviceId -> [{ at, method, path, ip, status }]
let flushTimer = null

function loaded() {
  if (entries) return entries
  entries = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    for (const [id, list] of Object.entries(raw?.devices || {})) {
      if (Array.isArray(list)) entries.set(id, list.slice(-MAX_PER_DEVICE))
    }
  } catch { /* first run, or an unreadable file — start empty rather than fail */ }
  return entries
}

function flush() {
  clearTimeout(flushTimer)
  flushTimer = null
  if (!entries) return
  try {
    const out = { version: 1, devices: Object.fromEntries(entries) }
    const file = FILE()
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(out), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch { /* a lost activity entry is never worth failing a request over */ }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

function record(deviceId, { method, path: reqPath, ip, status, at = Date.now() }) {
  if (!deviceId) return
  const map = loaded()
  const list = map.get(deviceId) || []
  list.push({
    at: new Date(at).toISOString(),
    method: String(method || '').slice(0, 10),
    path: String(reqPath || '').split('?')[0].slice(0, 200),
    ip: String(ip || '').slice(0, 64),
    status: Number(status) || 0,
  })
  // Ring buffer: drop from the front once full.
  if (list.length > MAX_PER_DEVICE) list.splice(0, list.length - MAX_PER_DEVICE)
  map.set(deviceId, list)
  scheduleFlush()
}

// Newest first, which is how anyone reading it wants it.
function list(deviceId) {
  return [...(loaded().get(deviceId) || [])].reverse()
}

function forget(deviceId) {
  if (loaded().delete(deviceId)) scheduleFlush()
}

function forgetAll() {
  loaded().clear()
  scheduleFlush()
}

module.exports = {
  record, list, forget, forgetAll, flush, MAX_PER_DEVICE,
  // exported for tests
  _reset: () => { clearTimeout(flushTimer); flushTimer = null; entries = null },
}
