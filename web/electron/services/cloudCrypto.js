// End-to-end encryption for the cloud mirror.
//
// The account password never reaches the server. Earlier versions derived the
// data key straight from the password that was ALSO handed to Supabase via
// signInWithPassword — so the provider held everything needed to re-derive the
// key, and "end-to-end encrypted" was not true against the one adversary the
// encryption exists to defend against.
//
// The password is now stretched once into a master secret, and two independent
// keys are split out of it by HKDF:
//
//   authSecret — sent to Supabase in place of the password. The server stores
//                its own hash of this; it is not the password and cannot be
//                turned back into one.
//   dataKey    — encrypts the payloads. Derived only on the device, from the
//                password, and never transmitted anywhere.
//
// Knowing authSecret does not yield dataKey: HKDF's outputs are independent
// given distinct `info` strings, so a full compromise of the Supabase project
// reveals ciphertext and nothing else.

const crypto = require('crypto')

const PBKDF2_ROUNDS = 200000
const MASTER_BYTES = 32
const INFO_AUTH = 'hiro-auth-v3'
const INFO_DATA = 'hiro-data-v3'

// The account address is the salt. It has to be, because both the desktop and
// the phone must arrive at the same key from the password alone, with nothing
// to exchange — a random salt would have to be stored server-side, which puts
// it back in reach of the party being defended against.
function saltFor(email) {
  return `hiro-cloud:${String(email).trim().toLowerCase()}`
}

function masterKey(email, password) {
  return crypto.pbkdf2Sync(password, saltFor(email), PBKDF2_ROUNDS, MASTER_BYTES, 'sha256')
}

function expand(master, info, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(salt), Buffer.from(info), 32))
}

// The payload key. Base64 so it can live in config alongside the other secrets.
function deriveKey(email, password) {
  return expand(masterKey(email, password), INFO_DATA, saltFor(email)).toString('base64')
}

// What is actually sent to Supabase as the account password. Hex rather than
// base64 so it survives any provider that is fussy about password characters.
function deriveAuthSecret(email, password) {
  return expand(masterKey(email, password), INFO_AUTH, saltFor(email)).toString('hex')
}

// Both at once, so a sign-in stretches the password once instead of twice —
// PBKDF2 at 200k rounds is deliberately slow and doing it twice is felt.
function deriveAccountKeys(email, password) {
  const master = masterKey(email, password)
  const salt = saltFor(email)
  return {
    dataKey: expand(master, INFO_DATA, salt).toString('base64'),
    authSecret: expand(master, INFO_AUTH, salt).toString('hex'),
  }
}

// v1 (pre-AES-GCM) and v2 (GCM, but keyed by the password the server also saw)
// are both retired. The desktop's SQLite database holds the plaintext, so a
// re-upload after sign-in replaces them — nothing is stranded, and old rows are
// deliberately unreadable rather than silently trusted.
const ENVELOPE_VERSION = 3

function encrypt(key64, value) {
  if (!key64) return null
  const key = Buffer.from(key64, 'base64'), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return JSON.stringify({ v: ENVELOPE_VERSION, data: Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64') })
}

function decrypt(key64, payload) {
  if (!key64 || !payload) return null
  const env = typeof payload === 'string' ? JSON.parse(payload) : payload, key = Buffer.from(key64, 'base64')
  if (env.v !== ENVELOPE_VERSION) {
    const err = new Error('Cloud data uses an obsolete encryption format.')
    // Marked so a sync can skip the row and carry on. One un-upgradable row
    // must not abort the whole pull — which is exactly what it did before,
    // taking every later row down with it.
    err.obsoleteEnvelope = true
    throw err
  }
  const combined = Buffer.from(env.data, 'base64'), iv = combined.subarray(0, 12), tag = combined.subarray(-16), data = combined.subarray(12, -16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
}

module.exports = { deriveKey, deriveAuthSecret, deriveAccountKeys, encrypt, decrypt, ENVELOPE_VERSION }
