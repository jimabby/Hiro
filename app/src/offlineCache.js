// The offline read cache's storage. Rules (what is kept, for how long, how it is
// labelled) are in src/cacheModel.js.
//
// Keyed by connection, so a phone that switches account or desktop never shows
// one's applications under the other. The key is a hash of the destination
// key, which itself is already a hash for LAN connections — no token is ever
// part of a storage key or a value here.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { makeEntry, readEntry, isStale } from './cacheModel'
import { classifyError } from './requestErrors'

const PREFIX = 'hiro.cache.'

function keyFor(client, name) {
  const dest = client?.queueDestination?.key
  if (!dest) return null
  return `${PREFIX}${name}.${bytesToHex(sha256(utf8ToBytes(dest))).slice(0, 32)}`
}

export async function saveCache(client, name, data) {
  const key = keyFor(client, name)
  if (!key) return
  try { await AsyncStorage.setItem(key, JSON.stringify(makeEntry(data))) } catch { /* a cache that fails to save is just no cache */ }
}

// The entry, or null when there is none or it is too old to show.
export async function loadCache(client, name) {
  const key = keyFor(client, name)
  if (!key) return null
  try {
    const entry = readEntry(await AsyncStorage.getItem(key))
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
}
