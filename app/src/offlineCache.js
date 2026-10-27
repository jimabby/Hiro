// The offline read cache's storage. Rules (what is kept, for how long, how it is
// labelled) are in src/cacheModel.js.
//
// Keyed by connection, so a phone that switches account or desktop never shows
// one's applications under the other. The key is a hash of the destination
// key, which itself is already a hash for LAN connections — no token is ever
// part of a storage key or a value here.
//
// Encrypted at rest. The cached list carries job titles and company names —
// exactly what the cloud's encrypted_meta exists to keep off the server — and
// AsyncStorage is a plain file that lands in device backups. So each entry is
// sealed with AES-GCM under a random key that lives only in the Keychain /
// Keystore (SecureStore, which is excluded from backups and does not leave the
// device). Clearing the caches deletes that key too, which makes any copy of
// the ciphertext that survived somewhere unreadable. Where SecureStore is not
// available nothing is cached: an offline view is a convenience, plaintext
// titles on disk are not a price worth paying for it.
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { makeEntry, readEntry, isStale } from './cacheModel'
import { classifyError } from './requestErrors'

const PREFIX = 'hiro.cache.'
const KEY_NAME = 'hiro.cache-key'
// Marks a sealed value, so a plaintext entry an older build wrote is
// recognised (and discarded) rather than mistaken for ciphertext.
const SEALED_PREFIX = 'sealed1:'

let keyPromise = null

// The cache key, created on first use. Memoised so concurrent saves agree on
// one key instead of each minting its own and orphaning the others' entries.
function cacheKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      if (!(await SecureStore.isAvailableAsync().catch(() => false))) return null
      const stored = await SecureStore.getItemAsync(KEY_NAME)
      if (stored) return AESEncryptionKey.import(stored, 'base64')
      const key = await AESEncryptionKey.generate()
      await SecureStore.setItemAsync(KEY_NAME, await key.encoded('base64'))
      return key
    })().catch(() => null)
    // A failure (keychain locked during a background refresh) is retried on
    // the next call rather than remembered.
    keyPromise.then(k => { if (!k) keyPromise = null })
  }
  return keyPromise
}

async function seal(text) {
  const key = await cacheKey()
  if (!key) return null
  const sealed = await aesEncryptAsync(utf8ToBytes(text), key)
  return SEALED_PREFIX + await sealed.combined('base64')
}

async function unseal(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(SEALED_PREFIX)) return null
  const key = await cacheKey()
  if (!key) return null
  const plain = await aesDecryptAsync(AESSealedData.fromCombined(raw.slice(SEALED_PREFIX.length)), key, { output: 'bytes' })
  return new TextDecoder().decode(plain)
}

function keyFor(client, name) {
  const dest = client?.queueDestination?.key
  if (!dest) return null
  return `${PREFIX}${name}.${bytesToHex(sha256(utf8ToBytes(dest))).slice(0, 32)}`
}

export async function saveCache(client, name, data) {
  const key = keyFor(client, name)
  if (!key) return
  try {
    const sealed = await seal(JSON.stringify(makeEntry(data)))
    if (sealed) await AsyncStorage.setItem(key, sealed)
  } catch { /* a cache that fails to save is just no cache */ }
}

// The entry, or null when there is none or it is too old to show.
export async function loadCache(client, name) {
  const key = keyFor(client, name)
  if (!key) return null
  try {
    const raw = await AsyncStorage.getItem(key)
    // An unsealed entry is a plaintext one from before encryption: remove it
    // rather than show it, so the upgrade also cleans the old file.
    if (raw && !raw.startsWith(SEALED_PREFIX)) {
      await AsyncStorage.removeItem(key)
      return null
    }
    const entry = readEntry(await unseal(raw))
    if (!entry || isStale(entry)) return null
    return entry
  } catch {
    return null
  }
}

// Whether a failed load should fall back to the cache: only when the source
// could not be reached. A revoked token or a refusal is shown as itself.
export function shouldUseCache(err) {
  const kind = classifyError(err)
  return kind === 'offline' || kind === 'busy'
}

// On sign-out or disconnect: nothing from the old connection stays behind.
export async function clearCaches() {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX))
    if (keys.length) await AsyncStorage.multiRemove(keys)
  } catch { /* best-effort */ }
  // Crypto-shred: without the key, a ciphertext that escaped the removal (a
  // backup taken earlier) cannot be read either. The next save mints a new one.
  keyPromise = null
  try { await SecureStore.deleteItemAsync(KEY_NAME) } catch { /* best-effort */ }
}
