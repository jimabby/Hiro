import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync, getRandomBytes } from 'expo-crypto'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

const bytesToBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const keyBytes = token => sha256(utf8ToBytes(token))

export async function encryptPayload(token, body) {
  const key = await AESEncryptionKey.import(keyBytes(token))
  const plain = bytesToBase64(utf8ToBytes(JSON.stringify(body)))
  const sealed = await aesEncryptAsync(plain, key)
  return { secure: 2, data: await sealed.combined('base64') }
}

export async function decryptPayload(token, envelope) {
  if (envelope?.secure !== 2) throw new Error('Desktop returned an unencrypted response. Re-pair this phone to upgrade the connection.')
  const key = await AESEncryptionKey.import(keyBytes(token))
  const sealed = AESSealedData.fromCombined(envelope.data)
  const plain = await aesDecryptAsync(sealed, key, { output: 'bytes' })
  return JSON.parse(new TextDecoder().decode(plain))
}

export function signedHeaders(token, method, path, rawBody) {
  const timestamp = String(Date.now()), nonce = bytesToHex(getRandomBytes(16))
  const input = [method, path, timestamp, nonce, rawBody].join('\n')
  return { 'X-Hiro-Timestamp': timestamp, 'X-Hiro-Nonce': nonce, 'X-Hiro-Signature': bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(input))) }
}
