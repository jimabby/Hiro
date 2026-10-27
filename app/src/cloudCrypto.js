// Phone-side half of the cloud encryption scheme. Must stay bit-for-bit
// identical to web/electron/services/cloudCrypto.js — see that file for why the
// password is split into two independent keys rather than used directly.
import { sha256 } from '@noble/hashes/sha2.js'
import { pbkdf2, pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto'
import secureStore from './secureStore'

const KEY_NAME = 'hiro.cloud-data-key'
const PBKDF2_ROUNDS = 200000
const INFO_AUTH = 'hiro-auth-v3'
const INFO_DATA = 'hiro-data-v3'
const ENVELOPE_VERSION = 3

let key64 = ''

const bytesToBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const base64ToBytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))

const saltFor = email => `hiro-cloud:${String(email).trim().toLowerCase()}`

function masterKey(email, password) {
  return pbkdf2(sha256, utf8ToBytes(password), utf8ToBytes(saltFor(email)), { c: PBKDF2_ROUNDS, dkLen: 32 })
}

// Both keys from one stretch. PBKDF2 at 200k rounds is slow on a phone, and
// deriving twice would double a delay the user feels at the sign-in button.
export function deriveAccountKeys(email, password) {
  return keysFromMaster(email, masterKey(email, password))
}

function keysFromMaster(email, master) {
  const salt = utf8ToBytes(saltFor(email))
  return {
    dataKey: bytesToBase64(hkdf(sha256, master, salt, utf8ToBytes(INFO_DATA), 32)),
    authSecret: bytesToHex(hkdf(sha256, master, salt, utf8ToBytes(INFO_AUTH), 32)),
  }
}

// The same keys, without freezing the screen. pbkdf2Async hands the event
// loop back every few milliseconds, so the sign-in button can render
// "Signing in…" and the screen keeps responding while the 200k rounds run.
// The output is identical to deriveAccountKeys — only the scheduling differs.
export async function deriveAccountKeysAsync(email, password) {
  const master = await pbkdf2Async(sha256, utf8ToBytes(password), utf8ToBytes(saltFor(email)), { c: PBKDF2_ROUNDS, dkLen: 32, asyncTick: 16 })
  return keysFromMaster(email, master)
}

export async function loadCloudKey() { key64 = (await secureStore.getItem(KEY_NAME)) || ''; return key64 }

export async function setCloudKey(dataKey) {
  key64 = dataKey
  await secureStore.setItem(KEY_NAME, key64)
}

export async function setCloudKeyFromPassword(email, password) {
  await setCloudKey(deriveAccountKeys(email, password).dataKey)
}

export async function clearCloudKey() {
  key64 = ''
  await secureStore.removeItem(KEY_NAME)
}

// The row an envelope belongs to: table, cloud id and column, fed to AES-GCM
// as additional authenticated data. Must match rowContext() in the desktop's
// cloudCrypto.js exactly — see the note there on why envelopes are bound.
export const rowContext = (table, rowId, column) => `hiro:${table}:${rowId}:${column}`

// `expectedContext` is where the caller found this envelope. When given, an
// envelope bound to a different row is refused rather than shown, because a
// valid tag only proves the key holder wrote it, not that it belongs here.
// Envelopes from before binding carry no `ctx` and are still read.
export async function decryptCloudPayload(payload, expectedContext = null) {
  if (!payload) return null
  if (!key64) throw new Error('Encrypted cloud data needs your password. Sign out and sign in again on this phone.')
  const env = typeof payload === 'string' ? JSON.parse(payload) : payload, keyBytes = base64ToBytes(key64)
  if (env.v === ENVELOPE_VERSION) {
    if (env.ctx != null && expectedContext && env.ctx !== expectedContext) {
      const err = new Error('This cloud data was moved here from another application and has been ignored.')
      err.misboundEnvelope = true
      throw err
    }
    const key = await AESEncryptionKey.import(keyBytes), sealed = AESSealedData.fromCombined(env.data)
    const options = { output: 'bytes' }
    if (env.ctx != null) options.additionalData = utf8ToBytes(String(env.ctx))
    const plain = await aesDecryptAsync(sealed, key, options)
    return JSON.parse(new TextDecoder().decode(plain))
  }
  // v1 and v2 were keyed by material the server also held. The desktop has the
  // plaintext and re-uploads these automatically; until it does, they are
  // deliberately unreadable rather than decrypted with a compromised key.
  const err = new Error('This cloud payload is still encrypted with a retired key. Open Hiro on the desktop to re-upload it.')
  err.obsoleteEnvelope = true
  throw err
}

// Separate envelopes let the phone update comments without overwriting the
// desktop's title/company/documents envelope.
// `context` binds the envelope to the row and column it is written to (see
// rowContext). Optional only for callers that cannot name the row; the
// desktop re-uploads unbound envelopes in the bound form.
export async function encryptCloudPayload(value, context = null) {
  if (!key64) throw new Error('Sign in again to encrypt this change.')
  const key = await AESEncryptionKey.import(base64ToBytes(key64))
  const options = context ? { additionalData: utf8ToBytes(String(context)) } : undefined
  const sealed = await aesEncryptAsync(utf8ToBytes(JSON.stringify(value)), key, options)
  const envelope = { v: ENVELOPE_VERSION }
  if (context) envelope.ctx = String(context)
  envelope.data = await sealed.combined('base64')
  return JSON.stringify(envelope)
}
