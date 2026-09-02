// The activity log: what it refuses to write in the clear, and what happens
// when it is encrypted.
//
// Settings → Data offers "encrypt local data", and it used to mean the database
// and its backups. This file was the hole in that promise: it records job
// titles, employers, the recruiter address pulled out of each ad, paired device
// names and full error stacks — which is to say it records that you are job
// hunting, and where — in plaintext in the home directory.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-log-test-'))

// A stand-in for Electron's safeStorage. The real one wraps with the OS
// keychain; what matters here is that the log key is not readable from the file
// on disk, which round-tripping through a fixed key models faithfully enough to
// test everything above it.
const VAULT_KEY = crypto.createHash('sha256').update('test-vault').digest()
let keychainAvailable = true

stub({
  './config': { CONFIG_DIR: DIR },
  electron: {
    safeStorage: {
      isEncryptionAvailable: () => keychainAvailable,
      encryptString: (text) => {
        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv)
        return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
      },
      decryptString: (buf) => {
        const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, buf.subarray(0, 12))
        decipher.setAuthTag(buf.subarray(-16))
        return Buffer.concat([decipher.update(buf.subarray(12, -16)), decipher.final()]).toString('utf8')
      },
    },
  },
})

const logger = service('logger.js')
const { check, done } = createChecker()

const raw = () => fs.readFileSync(logger.LOG_FILE, 'utf8')

// ── Redaction, which applies whether or not the log is encrypted ──
// These are values with no diagnostic worth in the clear: knowing an API key was
// present is the whole of the information, and knowing which one it was only
// creates a way to lose it. A log pasted into a bug report is the case.
check('an OpenAI-style key is redacted',
  logger.redact('using sk-abc123def456ghi789'), 'using [api-key redacted]')
check('an Anthropic-style key is redacted',
  logger.redact('key sk-ant-api03-abcdefghijklmnop'), 'key [api-key redacted]')
check('a Google key is redacted',
  logger.redact('AIzaSyA1234567890abcdefghijklmnop'), '[api-key redacted]')
check('a bearer token is redacted',
  logger.redact('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer [redacted]')
check('a wrapped config secret is redacted',
  logger.redact('value enc:v1:AAAAbbbbCCCC='), 'value enc:v1:[redacted]')
check('a long hex blob is redacted',
  logger.redact(`device ${'a'.repeat(64)}`), 'device [token redacted]')
check('a JWT is redacted',
  logger.redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcd'), '[jwt redacted]')

// A short hex string is an id, not a secret, and redacting it would make the log
// useless for the thing it is mostly used for.
check('a short id is left alone', logger.redact('job a1b2c3'), 'job a1b2c3')

// ── Email addresses: masked only when the line goes to disk in the clear ──
check('an address is masked when the log is not encrypted',
  logger.redact('Contact for follow-up: jane.doe@acme.example', { encrypted: false }),
  'Contact for follow-up: j••••••@acme.example')
check('the domain survives, because that is the useful half',
  /acme\.example/.test(logger.redact('x jane@acme.example')), true)
// When the log IS encrypted the address is protected by that, and checking which
// contact was pulled out of an ad is a real reason someone reads this file.
check('an address is kept whole when the log is encrypted',
  logger.redact('Contact: jane.doe@acme.example', { encrypted: true }),
  'Contact: jane.doe@acme.example')

// ── Plaintext mode ───────────────────────────────────────────────
logger._resetKeyCache()
logger.append('Processing: Data Engineer at Acme')
check('an unencrypted log is readable on disk', raw().includes('Data Engineer at Acme'), true)
check('and tail returns it', logger.tail(5).some(l => l.includes('Data Engineer at Acme')), true)
check('and reports itself as unencrypted', logger.getStatus().encrypted, false)

// ── Turning encryption on ────────────────────────────────────────
const enabled = logger.setEncryption(true)
check('encryption can be enabled', enabled.success, true)
check('and the log reports itself encrypted', logger.isEncrypted(), true)

// The history is converted too. An encrypted database beside a plaintext log of
// what went into it protects very little, and that includes the log's past.
check('the existing history is no longer readable on disk',
  raw().includes('Data Engineer at Acme'), false)
check('but is still readable through tail',
  logger.tail(5).some(l => l.includes('Data Engineer at Acme')), true)

logger.append('Processing: Platform Engineer at Globex')
check('a new line is written as ciphertext',
  raw().includes('Platform Engineer at Globex'), false)
check('every stored line is prefixed as encrypted',
  raw().split('\n').filter(Boolean).every(l => l.startsWith('#1:')), true)
check('and decrypts back through tail',
  logger.tail(5).some(l => l.includes('Platform Engineer at Globex')), true)

// The key is a real key, not a rename.
check('the key file exists', fs.existsSync(logger.LOG_KEY_FILE), true)
check('and the log key is not in the log file',
  raw().includes(JSON.parse(fs.readFileSync(logger.LOG_KEY_FILE, 'utf8')).key), false)

// ── A readable copy, for an editor or a bug report ───────────────
const copy = path.join(DIR, 'plain.txt')
logger.writePlainCopy(copy)
const plain = fs.readFileSync(copy, 'utf8')
check('the plain copy carries the whole history', plain.includes('Data Engineer at Acme'), true)
check('including lines written after encryption', plain.includes('Platform Engineer at Globex'), true)

// ── A tampered line ──────────────────────────────────────────────
// GCM's tag means a modified line is refused rather than shown as garbage, and
// one damaged line must not take the rest of the log with it.
const lines = raw().split('\n').filter(Boolean)
const corrupted = `${lines[0].slice(0, -6)}AAAAAA`
fs.writeFileSync(logger.LOG_FILE, `${[corrupted, ...lines.slice(1)].join('\n')}\n`)
const afterTamper = logger.tail(10)
check('a tampered line is reported rather than shown',
  afterTamper[0].includes('could not be decrypted'), true)
check('and the rest of the log survives it',
  afterTamper.some(l => l.includes('Platform Engineer at Globex')), true)

// ── Turning it back off ──────────────────────────────────────────
logger.setEncryption(false)
check('the log reports itself unencrypted again', logger.isEncrypted(), false)
check('and the history is readable on disk once more',
  raw().includes('Platform Engineer at Globex'), true)
check('the key file is gone', fs.existsSync(logger.LOG_KEY_FILE), false)

// ── No keychain ──────────────────────────────────────────────────
// Diagnostics that stop working during an incident are worse than diagnostics
// that are less private than intended, so this reports rather than throws.
keychainAvailable = false
logger._resetKeyCache()
const refused = logger.setEncryption(true)
check('encryption without a keychain fails cleanly', refused.success, false)
check('and says why', /keychain/i.test(refused.error), true)
logger.append('still logging')
check('and logging carries on regardless',
  logger.tail(3).some(l => l.includes('still logging')), true)

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
done()
