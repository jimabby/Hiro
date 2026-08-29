// Phone half of the pairing channel. Must stay byte-for-byte compatible with
// web/electron/services/pairChannel.js — see that file for the threat model and
// why the exchange looks like this.
//
// In short: the desktop's reply to a pairing request contains a 90-day device
// token, and it used to travel over plain HTTP in the clear. Now the request and
// the reply are AES-GCM encrypted under a key agreed by P-256 ECDH, and the
// pairing code — which never touches the network — authenticates the desktop's
// public key so nobody on the LAN can put their own key in its place.
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync } from 'expo-crypto'

const PBKDF2_ROUNDS = 200000
const KEY_BYTES = 32
const INFO = 'hiro-pair-v2'
export const PROTOCOL_VERSION = 2

const bytesToBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const base64ToBytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))

// Whatever the user typed, reduced to what the desktop generated. Codes are
// shown uppercase and often read aloud, so case and stray spaces are not a
// mismatch — but this normalisation has to be identical on both ends or the tag
// will never agree.
export function normaliseCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '')
}

function codeKey(code, salt) {
  return pbkdf2(sha256, utf8ToBytes(normaliseCode(code)), salt, { c: PBKDF2_ROUNDS, dkLen: KEY_BYTES })
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false
  // Constant time. The tag is the only thing standing between a real desktop and
  // one an attacker put in its place, so it is not compared with ===.
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Check that this hello really came from the desktop showing the code, then
// derive the session key from its public key and ours.
//
// Throws when the tag does not verify. That is the ONE case worth stopping on:
// it means either the code was mistyped, or something on the network answered in
// the desktop's place. Both should be told to the user rather than papered over.
export function openChannel(hello, code) {
  if (hello?.v !== PROTOCOL_VERSION) {
    throw new Error('This desktop is running an older version of Hiro. Update it to pair securely.')
  }
  const desktopKey = base64ToBytes(hello.pk)
  const salt = base64ToBytes(hello.salt)
  const expected = hmac(sha256, codeKey(code, salt),
    concat(utf8ToBytes(String(PROTOCOL_VERSION)), desktopKey, salt))
  if (!equalBytes(expected, base64ToBytes(hello.tag))) {
    throw new Error('That pairing code does not match this desktop. Check the code, and if it is right, '
      + 'something on this network may be impersonating the desktop — try a different network.')
  }

  const secretKey = p256.utils.randomSecretKey()
  // Uncompressed point, the form Node's createECDH and WebCrypto's raw export
  // both use.
  const publicKey = p256.getPublicKey(secretKey, false)
  // getSharedSecret returns a compressed point; the shared value is its
  // x-coordinate, which is what the other two implementations hand to HKDF.
  const shared = p256.getSharedSecret(secretKey, desktopKey).slice(1)
  const key = hkdf(sha256, shared, salt, utf8ToBytes(INFO), KEY_BYTES)
  return { key, publicKey: bytesToBase64(publicKey) }
}

export async function sealRequest(channel, value) {
  const key = await AESEncryptionKey.import(channel.key)
  const sealed = await aesEncryptAsync(bytesToBase64(utf8ToBytes(JSON.stringify(value))), key)
  return { v: PROTOCOL_VERSION, epk: channel.publicKey, data: await sealed.combined('base64') }
}

export async function openResponse(channel, envelope) {
  if (envelope?.v !== PROTOCOL_VERSION || !envelope.data) {
    throw new Error('The desktop answered the pairing request in the clear. Update Hiro on the desktop.')
  }
  const key = await AESEncryptionKey.import(channel.key)
  const plain = await aesDecryptAsync(AESSealedData.fromCombined(envelope.data), key, { output: 'bytes' })
  return JSON.parse(new TextDecoder().decode(plain))
}
