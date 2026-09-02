// Persistent activity log. Scan/scheduler/apply messages are appended to a file
// in the config dir so failed scrapes stay diagnosable after the app is closed
// (the in-memory renderer log is lost on quit). Size-capped with one rotation.
//
// ─── Why this file is encrypted too ──────────────────────────────────────
//
// Settings → Data offers "encrypt local data", and it used to mean the database
// and its backups. This file was the hole in that promise. It records job
// titles, employers, the recruiter address pulled out of each ad, paired device
// names, peer IP addresses and full error stacks — which is to say it records
// that you are job hunting, and where — in plaintext, in the home directory,
// readable by any process running as you and carried off the machine by
// whatever backs that directory up. Encrypting the database and leaving this
// beside it protects very little.
//
// The scheme is deliberately line-at-a-time rather than whole-file:
//
//   append() must stay a single appendFileSync. Re-encrypting a 2 MB file on
//   every log line would make logging cost more than the work being logged.
//
//   tail() must stay a tail. The phone polls it every couple of seconds during
//   a scan; reading and decrypting the whole file to show forty lines is the
//   exact cost the tail-reading code below exists to avoid.
//
//   A file may hold both forms at once. Lines written before encryption was
//   turned on stay readable, and a conversion that is interrupted leaves a file
//   that still reads correctly from both halves.
//
// Each encrypted line is the prefix below followed by base64 of iv‖ciphertext‖tag
// under AES-256-GCM. Base64 contains no newline, so the line structure the tail
// reader depends on survives, and GCM's tag means a tampered line is dropped
// rather than shown as garbage.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { CONFIG_DIR } = require('./config')

const LOG_DIR = path.join(CONFIG_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'hiro.log')
const OLD_FILE = path.join(LOG_DIR, 'hiro.log.1')
const MAX_BYTES = 2 * 1024 * 1024 // 2 MB, then rotate to .1

// The log's own data key, wrapped by the OS keychain. Kept separate from
// db.key on purpose: the log is diagnostic and the database is the record, and
// losing the key to one should not take the other with it.
const LOG_KEY_FILE = path.join(CONFIG_DIR, 'log.key')

const LINE_PREFIX = '#1:'
const IV_BYTES = 12
const TAG_BYTES = 16

let safeStorage = null
try { ({ safeStorage } = require('electron')) } catch { /* not in Electron (tests) */ }

function keychainAvailable() {
  try { return !!safeStorage && safeStorage.isEncryptionAvailable() } catch { return false }
}

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
}

// ─── Key management ──────────────────────────────────────────────────────

// Cached because append() runs in tight loops during a scan and each miss is a
// keychain round trip. Invalidated explicitly by setEncryption.
let cachedKey = null
let cachedKeyChecked = false

function loadKey() {
  if (cachedKeyChecked) return cachedKey
  cachedKeyChecked = true
  cachedKey = null
  try {
    if (!fs.existsSync(LOG_KEY_FILE) || !keychainAvailable()) return null
    const wrapped = JSON.parse(fs.readFileSync(LOG_KEY_FILE, 'utf8'))
    const raw = safeStorage.decryptString(Buffer.from(wrapped.key, 'base64'))
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32) return null
    cachedKey = key
  } catch {
    // An unreadable key is treated as "no key": new lines are written in the
    // clear (redacted) rather than logging being lost altogether. Diagnostics
    // that stop working during an incident are worse than diagnostics that are
    // less private than intended — and the state is reported by getStatus() so
    // the UI can say which it is.
    cachedKey = null
  }
  return cachedKey
}

function createKey() {
  if (!keychainAvailable()) {
    throw new Error('The OS keychain is unavailable, so the activity log cannot be encrypted.')
  }
  ensureDir()
  const key = crypto.randomBytes(32)
  const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
  fs.writeFileSync(LOG_KEY_FILE, JSON.stringify({ v: 1, key: wrapped }), { mode: 0o600 })
  cachedKey = key
  cachedKeyChecked = true
  return key
}

// ─── Redaction ───────────────────────────────────────────────────────────
//
// Applied to every line, encrypted or not. These are values with no diagnostic
// worth in the clear: knowing an API key was present is the whole of the
// information, and knowing which one it was only creates a way to lose it. A log
// pasted into a bug report is the case this exists for.
const SECRET_PATTERNS = [
  // Provider API keys — OpenAI/Anthropic style, then Google style.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g, '[api-key redacted]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[api-key redacted]'],
  // Anything announcing itself as a credential.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\benc:v1:[A-Za-z0-9+/=]+/g, 'enc:v1:[redacted]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g, '[jwt redacted]'],
  // Device tokens, recovery keys, nonces, session tokens — long opaque blobs.
  // Last, so the more specific patterns above get to name what they matched.
  [/\b[A-Fa-f0-9]{32,}\b/g, '[token redacted]'],
]

// Masked only when the line is going to disk in the clear. When the log is
// encrypted the address is protected by that, and is worth keeping whole —
// checking that the right contact was pulled out of an ad is a real reason
// someone reads this file.
const EMAIL_RE = /\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g

function maskEmails(text) {
  return text.replace(EMAIL_RE, (_match, first, rest, domain) =>
    first + '•'.repeat(Math.min(rest.length, 6)) + '@' + domain)
}

function redact(text, { encrypted } = {}) {
  let out = String(text)
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement)
  if (!encrypted) out = maskEmails(out)
  return out
}

// ─── Line codec ──────────────────────────────────────────────────────────

function encryptLine(key, text) {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return LINE_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64')
}

// Returns the plaintext, or null when the line cannot be read as one. Nothing
// here throws: one damaged line must not take the rest of the log with it.
function decryptLine(key, line) {
  if (!key) return null
  try {
    const combined = Buffer.from(line.slice(LINE_PREFIX.length), 'base64')
    if (combined.length <= IV_BYTES + TAG_BYTES) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, combined.subarray(0, IV_BYTES))
    decipher.setAuthTag(combined.subarray(-TAG_BYTES))
    return Buffer.concat([
      decipher.update(combined.subarray(IV_BYTES, -TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

function readLine(key, line) {
  if (!line.startsWith(LINE_PREFIX)) return line
  const plain = decryptLine(key, line)
  return plain === null ? '[a line here could not be decrypted with this machine\'s log key]' : plain
}

// ─── Writing ─────────────────────────────────────────────────────────────

// Logging must never throw — a disk error here should not abort a scan.
function append(msg) {
  try {
    ensureDir()
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
      try { fs.renameSync(LOG_FILE, OLD_FILE) } catch { /* keep appending to current */ }
    }
    const key = loadKey()
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = '[' + ts + '] ' + redact(msg, { encrypted: !!key })
    fs.appendFileSync(LOG_FILE, (key ? encryptLine(key, line) : line) + '\n')
  } catch { /* ignore */ }
}

// ─── Reading ─────────────────────────────────────────────────────────────

// Return the most recent `maxLines` lines (oldest → newest), decrypted.
//
// Reads only the tail of the file rather than all of it. The phone polls this
// through /api/logs every couple of seconds while a scan runs, and the log is
// capped at 2 MB — so the naive readFileSync was re-reading and re-splitting
// two megabytes several times a second to show forty lines.
//
// An encrypted line is longer than the plaintext it carries (base64 over a
// 12-byte nonce and a 16-byte tag on top of the text), so the per-line estimate
// is generous enough to cover both forms without a second read in the common
// case.
const AVG_LINE_BYTES = 260

function tail(maxLines = 500) {
  let fd = null
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    const size = fs.statSync(LOG_FILE).size
    if (size === 0) return []

    const key = loadKey()
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
      if (lines.length >= maxLines || want >= size) {
        return lines.slice(-maxLines).map(line => readLine(key, line))
      }
      want = Math.min(size, want * 4)
    }
  } catch {
    return []
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

// Every line of both files, decrypted, oldest first. Used to write the readable
// copy that "open the activity log" hands to a text editor.
function readAll() {
  const key = loadKey()
  const out = []
  for (const file of [OLD_FILE, LOG_FILE]) {
    try {
      if (!fs.existsSync(file)) continue
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line) out.push(readLine(key, line))
      }
    } catch { /* skip an unreadable half rather than losing the other */ }
  }
  return out
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

// A readable copy, for opening in an editor or attaching to a bug report.
// Callers pass somewhere temporary; this module does not choose the location,
// because writing a decrypted copy is exactly the decision that should be made
// where the lifetime of the file is known.
function writePlainCopy(destPath) {
  const lines = readAll()
  fs.writeFileSync(destPath, lines.length ? lines.join('\n') + '\n' : '')
  return destPath
}

function isEncrypted() {
  return !!loadKey()
}

function getStatus() {
  const keyPresent = fs.existsSync(LOG_KEY_FILE)
  const key = loadKey()
  return {
    encrypted: !!key,
    keyPresent,
    // Present but unreadable: the profile was copied from another machine, or
    // the keychain is locked. New lines go to disk in the clear (redacted) and
    // the old ones stay unreadable — which the UI has to be able to say rather
    // than reporting a log that simply looks empty.
    keyReadable: !keyPresent || !!key,
    keychainAvailable: keychainAvailable(),
    path: LOG_FILE,
  }
}

// ─── Turning it on and off ───────────────────────────────────────────────
//
// Converts what is already on disk, so enabling this does not leave a plaintext
// history sitting beside an encrypted present. Both the live file and the
// rotated one.
//
// Written to a temp file and renamed rather than rewritten in place: a crash
// halfway through an in-place rewrite would leave a file that is neither form.
function convertFile(file, fromKey, toKey) {
  if (!fs.existsSync(file)) return false
  const source = fs.readFileSync(file, 'utf8')
  if (!source) return false
  const converted = source.split('\n').filter(Boolean).map(line => {
    const plain = line.startsWith(LINE_PREFIX) ? decryptLine(fromKey, line) : line
    // A line that cannot be read is carried across untouched. Dropping it would
    // silently delete history to satisfy a settings toggle.
    if (plain === null) return line
    return toKey ? encryptLine(toKey, plain) : plain
  })
  const tmp = file + '.converting'
  fs.writeFileSync(tmp, converted.join('\n') + '\n')
  fs.renameSync(tmp, file)
  return true
}

function setEncryption(enabled) {
  try {
    ensureDir()
    const want = !!enabled
    const current = loadKey()
    if (want === !!current) return { success: true, unchanged: true }

    if (want) {
      const key = createKey()
      for (const file of [OLD_FILE, LOG_FILE]) convertFile(file, null, key)
      cachedKey = key
      cachedKeyChecked = true
      return { success: true, enabled: true }
    }

    for (const file of [OLD_FILE, LOG_FILE]) convertFile(file, current, null)
    try { fs.unlinkSync(LOG_KEY_FILE) } catch { /* already gone */ }
    cachedKey = null
    cachedKeyChecked = false
    return { success: true, enabled: false }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

module.exports = {
  append, tail, clear, getPath, readAll, writePlainCopy,
  isEncrypted, getStatus, setEncryption,
  LOG_FILE, LOG_KEY_FILE,
  // exported for tests
  redact, maskEmails,
  _resetKeyCache: () => { cachedKey = null; cachedKeyChecked = false },
}
