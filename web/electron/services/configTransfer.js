// Encrypted export/import of the Hiro configuration — resumes, cover-letter
// settings, blacklists, search criteria, personal links, webhooks.
//
// The database has its own rotating backups; config did not, so moving to a
// new machine meant redoing the whole setup wizard by hand. The bundle is
// encrypted with a user-chosen passphrase because it carries the resume text
// and (optionally) API keys — writing that to a plain file the user might sync
// to cloud storage or email to themselves is the wrong default.
//
// Format: AES-256-GCM, key derived with scrypt. Header is plaintext JSON so a
// future version can recognise the file and report a helpful error rather than
// failing to decrypt with no explanation.

const crypto = require('crypto')
const configService = require('./config')

const MAGIC = 'hiro-config-backup'
const FORMAT_VERSION = 1
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

// Runtime bookkeeping and machine-specific state. Restoring these onto another
// machine would resurrect a stale scan queue, point the phone at the wrong
// pairing token, or replay a dead Supabase session.
const RUNTIME_KEYS = new Set([
  'pendingScans', 'lastScanAt', 'lastInboxCheck', 'lastCloudSyncAt',
  'setupComplete', 'mobileApiToken', 'mobileApiEnabled',
  'supabaseRefreshToken', 'cloudSyncEnabled',
  'deviceId', 'deviceName', 'knownDeviceIds', 'mobileDevices',
  'calendarSyncCursor', 'lastCalendarSyncAt', 'encryptDatabase',
  'automationCooldowns',
  // Registers a login item pointing at THIS machine's install path, and the
  // OS-level entry is written by the tray service rather than by config alone.
  // Importing it elsewhere would tick the box without registering anything.
  'launchOnLogin', 'startMinimised',
])

// Credentials. Excluded unless the user explicitly opts in, so the default
// export is safe to keep around as a settings backup.
const SECRET_KEYS = new Set([
  'aiApiKey', 'gmailAppPassword', 'calendarRefreshToken', 'calendarClientSecret',
])

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // scrypt's default maxmem is below what these parameters need.
    maxmem: 64 * 1024 * 1024,
  })
}

// Build the payload to encrypt. `includeSecrets` decides whether API keys and
// email and calendar credentials travel with it.
function buildPayload(includeSecrets) {
  const cfg = configService.load()
  const out = {}
  for (const [key, value] of Object.entries(cfg)) {
    if (RUNTIME_KEYS.has(key)) continue
    if (!includeSecrets && SECRET_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

function exportBundle(passphrase, { includeSecrets = false } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.')
  }
  const payload = buildPayload(includeSecrets)
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(passphrase, salt)

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return JSON.stringify({
    magic: MAGIC,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    kdf: { type: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  }, null, 2)
}

// Decrypt without applying, so the UI can show what's inside and let the user
// confirm before overwriting their current settings.
function inspectBundle(raw, passphrase) {
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    throw new Error('This file is not a Hiro config backup (invalid JSON).')
  }
  if (envelope?.magic !== MAGIC) {
    throw new Error('This file is not a Hiro config backup.')
  }
  if (envelope.version > FORMAT_VERSION) {
    throw new Error(`This backup was written by a newer version of Hiro (format ${envelope.version}). Update Hiro and try again.`)
  }

  const kdf = envelope.kdf || {}
  const key = crypto.scryptSync(
    Buffer.from(passphrase || '', 'utf8'),
    Buffer.from(kdf.salt || '', 'base64'),
    kdf.keylen || SCRYPT.keylen,
    { N: kdf.N || SCRYPT.N, r: kdf.r || SCRYPT.r, p: kdf.p || SCRYPT.p, maxmem: 64 * 1024 * 1024 }
  )

  let payload
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ])
    payload = JSON.parse(plaintext.toString('utf8'))
  } catch {
    // GCM auth failure and a corrupt file are indistinguishable here, and the
    // overwhelmingly likely cause is a mistyped passphrase.
    throw new Error('Could not decrypt — check the passphrase.')
  }

  return {
    createdAt: envelope.createdAt || null,
    includesSecrets: !!envelope.includesSecrets,
    payload,
    summary: {
      resumes: Array.isArray(payload.resumes) ? payload.resumes.length : 0,
      blacklistedCompanies: Array.isArray(payload.blacklistedCompanies) ? payload.blacklistedCompanies.length : 0,
      resumeRules: Array.isArray(payload.resumeRules) ? payload.resumeRules.length : 0,
      webhooks: Array.isArray(payload.webhooks) ? payload.webhooks.length : 0,
      atsBoards: Array.isArray(payload.atsBoards) ? payload.atsBoards.length : 0,
      keys: Object.keys(payload).length,
    },
  }
}

// Apply a decrypted payload over the current config. Runtime keys in the
// bundle are ignored defensively even though export strips them — an older or
// hand-edited bundle shouldn't be able to clobber the live scan queue or the
// mobile pairing token.
function applyBundle(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Nothing to import.')
  const patch = {}
  for (const [key, value] of Object.entries(payload)) {
    if (RUNTIME_KEYS.has(key)) continue
    patch[key] = value
  }
  configService.update(cfg => ({ ...cfg, ...patch }))
  return { success: true, applied: Object.keys(patch).length }
}

module.exports = { exportBundle, inspectBundle, applyBundle, MAGIC, FORMAT_VERSION }
