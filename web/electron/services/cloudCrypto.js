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

// ─── Binding an envelope to its row ──────────────────────────────
//
// GCM proves a ciphertext was written by someone holding the key. On its own it
// does not prove WHERE it was written. Every row and every envelope column is
// sealed under the same account key, so anyone with write access to the
// project (the provider, or a stolen session) could copy one application's
// encrypted_meta onto another row, or move an encrypted_comment into a
// different application, and both clients would decrypt it without complaint.
// Nothing would look wrong; a note would simply be attached to the wrong
// employer.
//
// So an envelope written now carries a context string naming the table, the
// row's cloud id and the column, and that string is fed to GCM as additional
// authenticated data. Editing the string breaks the tag. Moving the envelope
// somewhere else is caught by the reader, which knows where it found it and
// passes that as `expectedContext`.
//
// The context is stored in the clear inside the envelope (`ctx`) so a reader
// that does not know where an envelope came from can still open it. Readers that
// do know must say so; that is where the protection comes from.
//
// Envelopes written before this have no `ctx` and are still read, because
// refusing them would strand every existing row until its desktop happened to
// rewrite it. open() reports them as `legacy` so the desktop can re-upload them
// in the bound form on its next push.
//
// The envelope version stays 3 on purpose: the phone rejects any other number
// as "retired key", which would be the wrong message. app/src/cloudCrypto.js
// reads and writes `ctx` the same way.
function rowContext(table, rowId, column) {
  return `hiro:${table}:${rowId}:${column}`
}

function encrypt(key64, value, context = null) {
  if (!key64) return null
  const key = Buffer.from(key64, 'base64'), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (context) cipher.setAAD(Buffer.from(String(context), 'utf8'))
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const envelope = { v: ENVELOPE_VERSION }
  if (context) envelope.ctx = String(context)
  envelope.data = Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64')
  return JSON.stringify(envelope)
}

// Decrypt, and say whether the envelope was bound to its row. { value, legacy }
function open(key64, payload, expectedContext = null) {
  if (!key64 || !payload) return { value: null, legacy: false }
  const env = typeof payload === 'string' ? JSON.parse(payload) : payload, key = Buffer.from(key64, 'base64')
  if (env.v !== ENVELOPE_VERSION) {
    const err = new Error('Cloud data uses an obsolete encryption format.')
    // Marked so a sync can skip the row and carry on. One un-upgradable row
    // must not abort the whole pull — which is exactly what it did before,
    // taking every later row down with it.
    err.obsoleteEnvelope = true
    throw err
  }
  if (env.ctx != null && expectedContext && env.ctx !== expectedContext) {
    const err = new Error('Cloud data was moved here from another row and has been ignored.')
    err.misboundEnvelope = true
    throw err
  }
  const combined = Buffer.from(env.data, 'base64'), iv = combined.subarray(0, 12), tag = combined.subarray(-16), data = combined.subarray(12, -16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag)
  if (env.ctx != null) decipher.setAAD(Buffer.from(String(env.ctx), 'utf8'))
  const value = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
  return { value, legacy: env.ctx == null }
}

function decrypt(key64, payload, expectedContext = null) {
  return open(key64, payload, expectedContext).value
}

module.exports = { deriveKey, deriveAuthSecret, deriveAccountKeys, encrypt, decrypt, open, rowContext, ENVELOPE_VERSION }
