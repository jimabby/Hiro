// Encryption at rest for the SQLite database and its backups.
//
// What is actually in that file: every job description, every tailored resume,
// every cover letter, every screening answer, and every recruiter's email
// address. A job search is often the one thing a person most wants kept from
// their current employer, and all of it sat in plaintext in ~/.hiro — readable by
// any process running as the user, and carried out of the machine by whatever
// backs up the home directory.
//
// Design, and why:
//
//   AES-256-GCM over the whole file. sql.js has no incremental write — every
//   persist already replaces the entire file — so whole-file encryption fits the
//   existing write path exactly and needs no SQLite extension (SQLCipher would
//   mean a native module, a build toolchain per platform, and giving up sql.js).
//
//   A random 32-byte DATA key, wrapped by the OS keychain. The data key lives in
//   ~/.hiro/db.key, encrypted with Electron's safeStorage — Keychain on macOS,
//   DPAPI on Windows, libsecret/kwallet on Linux. Encrypting the database
//   directly with safeStorage was the simpler-looking option and is wrong: it
//   takes and returns strings, so a multi-megabyte database would be base64'd
//   through memory on every single write.
//
//   Authenticated, not just encrypted. GCM's tag means a truncated or tampered
//   file is refused rather than opened as garbage — which matters because the
//   failure mode of "opened as garbage" here is an app that looks like it has
//   lost all of your history.
//
// The unavoidable cost, stated plainly: if the OS keychain entry is lost — a
// wiped machine, a reset user profile, a Linux box with no working secret
// service — the database cannot be decrypted. That is what encryption at rest
// means. Which is why exportRecoveryKey() exists and why the UI insists on it
// before turning this on.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const configService = require('./config')
const logger = require('./logger')

const KEY_FILE = path.join(configService.CONFIG_DIR, 'db.key')

// Header: magic, format version, then the GCM nonce and tag. Fixed-width so a
// file can be classified from its first bytes without parsing anything.
const MAGIC = Buffer.from('HIRODB01', 'ascii')
const IV_BYTES = 12   // GCM standard nonce length
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES

// What an unencrypted SQLite file starts with, used to tell "plaintext database"
// apart from "encrypted database" and from "not a database at all".
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii')

let safeStorage = null
try { ({ safeStorage } = require('electron')) } catch { /* not in Electron (tests) */ }

// Cached so a burst of writes does not hit the keychain once per write; the
// keychain call is a few milliseconds and persist() can run in a tight loop.
let cachedKey = null

class DbCryptoError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DbCryptoError'
    this.code = code
  }
}

function keychainAvailable() {
  try { return !!safeStorage && safeStorage.isEncryptionAvailable() } catch { return false }
}

// ─── Key management ──────────────────────────────────────────────

function loadKey() {
  if (cachedKey) return cachedKey
  if (!fs.existsSync(KEY_FILE)) return null
  if (!keychainAvailable()) {
    throw new DbCryptoError(
      'The database is encrypted but this system\'s keychain is unavailable, so the key cannot be unwrapped. '
      + 'Unlock your keychain (or install a secret service on Linux) and restart Hiro.',
      'keychain-unavailable'
    )
  }
  let wrapped
  try {
    wrapped = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'))
  } catch {
    throw new DbCryptoError(`${KEY_FILE} is not readable as a key file.`, 'key-corrupt')
  }
  try {
    const raw = safeStorage.decryptString(Buffer.from(wrapped.key, 'base64'))
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32) throw new Error('wrong length')
    cachedKey = key
    return key
  } catch {
    // The wrapped key is present but this machine/user cannot unwrap it: a
    // restored home directory, a different OS account, a reset keychain.
    throw new DbCryptoError(
      'The database key could not be unwrapped by this system\'s keychain. This happens when the profile '
      + 'was copied from another machine or user account. Restore it with the recovery key you saved when '
      + 'you turned encryption on.',
      'key-unwrap-failed'
    )
  }
}

// Wrap and store a key. Refuses to overwrite an existing one: doing so would
// leave a database that can never be decrypted again.
function storeKey(key, { overwrite = false } = {}) {
  if (!keychainAvailable()) {
    throw new DbCryptoError(
      'This system has no usable keychain, so an encryption key cannot be stored safely. '
      + 'On Linux this needs a secret service (gnome-keyring or kwallet).',
      'keychain-unavailable'
    )
  }
  if (fs.existsSync(KEY_FILE) && !overwrite) {
    throw new DbCryptoError('A database key already exists.', 'key-exists')
  }
  const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
  const tmp = KEY_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, key: wrapped }), { mode: 0o600 })
  fs.renameSync(tmp, KEY_FILE)
  // Belt and braces on POSIX: the mode above only applies at creation.
  try { fs.chmodSync(KEY_FILE, 0o600) } catch { /* Windows ignores this */ }
  cachedKey = key
  return key
}

function createKey() {
  return storeKey(crypto.randomBytes(32))
}

function hasKey() {
  return fs.existsSync(KEY_FILE)
}

// The escape hatch from the keychain. Printed once, for the user to keep
// somewhere the machine is not — it is the only thing that can recover an
// encrypted profile whose keychain entry is gone.
//
// Formatted in groups so it can be written down by hand without transcription
// errors, and prefixed so a stray string in a password manager is identifiable.
function exportRecoveryKey() {
  const key = loadKey()
  if (!key) throw new DbCryptoError('Encryption is not set up on this profile.', 'no-key')
  const b64 = key.toString('base64')
  return {
    key: `HIRO-RECOVERY-1:${b64}`,
    groups: (b64.match(/.{1,8}/g) || []).join(' '),
  }
}

function importRecoveryKey(text) {
  const raw = String(text || '').trim().replace(/^HIRO-RECOVERY-1:/, '').replace(/\s+/g, '')
  let key
  try { key = Buffer.from(raw, 'base64') } catch { key = Buffer.alloc(0) }
  if (key.length !== 32) {
    return { success: false, reason: 'That is not a Hiro recovery key — it should start with HIRO-RECOVERY-1:.' }
  }
  try {
    storeKey(key, { overwrite: true })
  } catch (err) {
    return { success: false, reason: err.message }
  }
  logger.append('Database: a recovery key was imported and re-wrapped with this system\'s keychain.')
  return { success: true }
}

// ─── Buffer encryption ───────────────────────────────────────────

function isEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length >= HEADER_BYTES && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

function isPlainSqlite(buf) {
  return Buffer.isBuffer(buf) && buf.length >= SQLITE_MAGIC.length
    && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)
}

function encryptBuffer(plain, key = loadKey()) {
  if (!key) throw new DbCryptoError('No encryption key is available.', 'no-key')
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

function decryptBuffer(buf, key = loadKey()) {
  if (!isEncrypted(buf)) throw new DbCryptoError('This file is not an encrypted Hiro database.', 'not-encrypted')
  if (!key) throw new DbCryptoError('No encryption key is available.', 'no-key')
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = buf.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES)
  const body = buf.subarray(HEADER_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // GCM refused the tag. Either the key is wrong or the file was altered —
    // both must fail loudly rather than hand back plausible-looking garbage.
    throw new DbCryptoError(
      'The database failed its integrity check. Either it was encrypted with a different key, '
      + 'or the file has been modified or truncated. Restore a backup rather than continuing.',
      'integrity-failed'
    )
  }
}

// ─── File-level read / write ─────────────────────────────────────

// Read a database file whatever state it is in. Callers get plain SQLite bytes
// and never have to know which.
function readFile(file) {
  const buf = fs.readFileSync(file)
  if (!isEncrypted(buf)) return { data: buf, wasEncrypted: false }
  return { data: decryptBuffer(buf), wasEncrypted: true }
}

// Encode for writing. Encryption is per-call rather than read from config inside,
// so the caller decides — which is what lets enable() rewrite existing files
// before the setting is flipped, instead of after.
function encodeForWrite(plain, encrypt) {
  if (!encrypt) return plain
  if (!hasKey()) createKey()
  return encryptBuffer(plain)
}

function shouldEncrypt() {
  return !!configService.load().encryptDatabase
}

// ─── Enabling and disabling ──────────────────────────────────────
// Both directions rewrite every file that exists — the database and every
// backup — before the setting changes, so an interrupted switch leaves files
// that the CURRENT setting can still read.

function rewriteFile(file, encrypt) {
  const buf = fs.readFileSync(file)
  const alreadyRight = encrypt ? isEncrypted(buf) : isPlainSqlite(buf)
  if (alreadyRight) return false
  const plain = isEncrypted(buf) ? decryptBuffer(buf) : buf
  const out = encrypt ? encryptBuffer(plain) : plain
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, out)
  fs.renameSync(tmp, file)
  return true
}

// `files` is supplied by the caller (database.js knows where the database and its
// backups live) rather than discovered here, so this module never has to know the
// layout of the profile directory.
function convertAll(files, encrypt) {
  if (encrypt && !hasKey()) createKey()
  const converted = []
  const failed = []
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    try {
      if (rewriteFile(file, encrypt)) converted.push(path.basename(file))
    } catch (err) {
      // One unreadable old backup must not abort the switch — but it must be
      // reported, because it is a file the user can no longer restore from.
      failed.push({ file: path.basename(file), reason: err.message })
    }
  }
  return { converted, failed }
}

function getStatus() {
  const cfg = configService.load()
  let keyError = null
  let keyReady = false
  if (hasKey()) {
    try { keyReady = !!loadKey() } catch (err) { keyError = err.message }
  }
  return {
    enabled: !!cfg.encryptDatabase,
    keychainAvailable: keychainAvailable(),
    hasKey: hasKey(),
    keyReady,
    keyError,
  }
}

module.exports = {
  DbCryptoError,
  keychainAvailable, hasKey, createKey, loadKey,
  exportRecoveryKey, importRecoveryKey,
  isEncrypted, isPlainSqlite, encryptBuffer, decryptBuffer,
  readFile, encodeForWrite, shouldEncrypt, convertAll, getStatus,
  KEY_FILE, HEADER_BYTES,
  // exported for tests
  _resetKeyCache: () => { cachedKey = null },
}
