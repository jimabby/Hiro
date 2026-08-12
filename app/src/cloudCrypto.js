import { sha256 } from '@noble/hashes/sha2.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { AESEncryptionKey, AESSealedData, aesDecryptAsync } from 'expo-crypto'
import secureStore from './secureStore'
const KEY_NAME = 'hiro.cloud-data-key'
let key64 = ''
const bytesToBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const base64ToBytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))
export async function loadCloudKey() { key64 = (await secureStore.getItem(KEY_NAME)) || ''; return key64 }
export async function setCloudKeyFromPassword(email, password) {
  key64 = bytesToBase64(pbkdf2(sha256, utf8ToBytes(password), utf8ToBytes(`hiro-cloud:${String(email).trim().toLowerCase()}`), { c: 120000, dkLen: 32 }))
  await secureStore.setItem(KEY_NAME, key64)
}
export async function clearCloudKey() {
  key64 = ''
  await secureStore.removeItem(KEY_NAME)
}
export async function decryptCloudPayload(payload) {
  if (!payload) return null
  if (!key64) throw new Error('Encrypted cloud data needs your password. Sign out and sign in again on this phone.')
  const env = typeof payload === 'string' ? JSON.parse(payload) : payload, keyBytes = base64ToBytes(key64)
  // Version 2 uses native AES-GCM. Version 1 remains readable during migration.
  if (env.v === 2) {
    const key = await AESEncryptionKey.import(keyBytes), sealed = AESSealedData.fromCombined(env.data)
    const plain = await aesDecryptAsync(sealed, key, { output: 'bytes' })
    return JSON.parse(new TextDecoder().decode(plain))
  }
  throw new Error('This cloud payload uses an obsolete encryption format. Re-sync it from the desktop.')
}
