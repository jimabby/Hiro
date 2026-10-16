import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync, getRandomBytes } from 'expo-crypto'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { responseAad } from './responseBinding'

const bytesToBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const keyBytes = token => sha256(utf8ToBytes(token))

export async function encryptPayload(token, body) {
  const key = await AESEncryptionKey.import(keyBytes(token))
  const plain = bytesToBase64(utf8ToBytes(JSON.stringify(body)))
  const sealed = await aesEncryptAsync(plain, key)
  return { secure: 2, data: await sealed.combined('base64') }
}

// `binding` is { method, path, nonce } of the request this reply answers, or
// null for a legacy (unbound) reply. See src/responseBinding.js for when each
// is acceptable — this function only does the cryptography.
export async function decryptPayload(token, envelope, binding = null) {
  if (envelope?.secure !== 2) throw new Error('Desktop returned an unencrypted response. Re-pair this phone to upgrade the connection.')
  const key = await AESEncryptionKey.import(keyBytes(token))
  const sealed = AESSealedData.fromCombined(envelope.data)
  const options = { output: 'bytes' }
  if (binding) options.additionalData = utf8ToBytes(responseAad(binding.method, binding.path, binding.nonce))
  let plain
  try {
    plain = await aesDecryptAsync(sealed, key, options)
  } catch {
    const err = new Error(binding
      ? 'The desktop’s reply did not match this request, so it was ignored. Try again; if it keeps happening, something on this network is interfering.'
      : 'The desktop’s reply could not be decrypted. Re-pair this phone.')
    err.untrusted = true
    throw err
  }
  return JSON.parse(new TextDecoder().decode(plain))
}

export function signedHeaders(token, method, path, rawBody) {
  const timestamp = String(Date.now()), nonce = bytesToHex(getRandomBytes(16))
  const input = [method, path, timestamp, nonce, rawBody].join('\n')
  return { 'X-Hiro-Timestamp': timestamp, 'X-Hiro-Nonce': nonce, 'X-Hiro-Signature': bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(input))) }
}

// Random hex, for idempotency keys. expo-crypto rather than Math.random: the
// key only has to be unique, but there is no reason to make it guessable.
export function randomKey(bytes = 16) {
  return bytesToHex(getRandomBytes(bytes))
}
