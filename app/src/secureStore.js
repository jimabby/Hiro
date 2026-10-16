// Encrypted storage for the two credentials this app holds: the LAN bearer
// token and the Supabase session (a refresh token that grants full access to
// the user's cloud account).
//
// Both previously lived in AsyncStorage, which is an unencrypted file in the
// app's sandbox — readable from any backup, and trivially readable on a rooted
// or jailbroken device. SecureStore keeps them in the iOS Keychain / Android
// Keystore, which is what PRIVACY.md already told users was happening.
//
// Two wrinkles this module exists to handle:
//
//   1. SecureStore warns above 2048 bytes per value and can fail outright on
//      Android. A Supabase session comfortably exceeds that, so values are
//      split into chunks and reassembled on read.
//   2. Existing installs already have plaintext values in AsyncStorage. Those
//      are migrated on first read and then erased, so an upgrade doesn't log
//      the user out but also doesn't leave the plaintext copy behind.

import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'

// Comfortably under the 2048-byte advisory limit once multi-byte characters
// are accounted for.
const CHUNK_SIZE = 1536
const COUNT_SUFFIX = '__chunks'

// Split on whole characters, never through the middle of one.
//
// `value.slice(i, i + CHUNK_SIZE)` cuts by UTF-16 code unit, which can land
// between the two halves of a surrogate pair — an emoji, or anything outside the
// basic plane. Rejoining the halves is lossless in JavaScript, but the pieces do
// not survive the round trip to the platform store in between: SecureStore hands
// each chunk to the iOS Keychain / Android Keystore as a UTF-8 string, and a lone
// surrogate is not representable in UTF-8. It comes back as a replacement
// character, and the reassembled value is silently corrupt.
//
// Today every value stored here is ASCII (a hex device token, a base64 Supabase
// session), so nothing is broken in practice. This is here so that stays true
// when it stops being the case, because the failure it would produce — an
// authentication that fails for no visible reason, on some devices only — is one
// of the worst kinds to go looking for.
//
// Sized by UTF-8 bytes rather than characters for the same reason the limit is
// quoted in bytes.
function splitIntoChunks(value) {
  const chunks = []
  let current = ''
  let bytes = 0
  // Iterating a string yields whole code points, so a surrogate pair arrives as
  // one unit and is never split.
  for (const char of value) {
    const size = utf8Length(char)
    if (bytes + size > CHUNK_SIZE && current) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  if (current) chunks.push(current)
  return chunks
}

function utf8Length(char) {
  const code = char.codePointAt(0)
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

// SecureStore keys are restricted to alphanumerics, ".", "-" and "_"; our keys
// contain dots already but sanitise defensively so a future key can't silently
// fail to persist.
function safeKey(key) {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function available() {
  try {
    return await SecureStore.isAvailableAsync()
  } catch {
    return false
  }
}

// ── Generations ─────────────────────────────────────────────────────
// A write used to delete the old chunks and then write the new ones, with
// nothing stopping a second write (supabase-js refreshing the session while the
// app saved it) from interleaving. Killed or raced partway, that left no value
// at all — a signed-out user — or chunks from two different values under one
// count.
//
// Now each value is written under a fresh generation id, and only once every
// chunk is in place does one write to the pointer ("<gen>:<count>") make it
// the current value. A write interrupted before that leaves the old value
// intact; after it, the new one is complete. Old generations are deleted last,
// best-effort. And every operation on a key runs one at a time.
//
// The layout before this — a bare count under COUNT_SUFFIX and chunks named
// `<key>.<i>` — is still read, and replaced on the next write.

const POINTER_SUFFIX = '__ptr'

const locks = new Map()
function withLock(key, op) {
  const prev = locks.get(key) || Promise.resolve()
  const run = prev.then(op, op)
  const tail = run.then(() => {}, () => {})
  locks.set(key, tail)
  // Drop the entry once nothing is queued behind it, so the map does not grow.
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

function newGeneration() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function parsePointer(raw) {
  const m = /^([a-z0-9]+):(\d+)$/.exec(raw || '')
  return m ? { gen: m[1], count: parseInt(m[2], 10) } : null
}

const chunkKey = (base, gen, i) => `${base}.g${gen}.${i}`

async function readPointer(base) {
  try { return parsePointer(await SecureStore.getItemAsync(base + POINTER_SUFFIX)) } catch { return null }
}

async function readLegacyCount(base) {
  try {
    const raw = await SecureStore.getItemAsync(base + COUNT_SUFFIX)
    return raw == null ? null : (parseInt(raw, 10) || 0)
  } catch { return null }
}

async function deleteGeneration(base, ptr) {
  if (!ptr) return
  await Promise.all(Array.from({ length: ptr.count }, (_, i) =>
    SecureStore.deleteItemAsync(chunkKey(base, ptr.gen, i)).catch(() => {})))
}

async function deleteLegacy(base) {
  const count = await readLegacyCount(base)
  const deletions = [SecureStore.deleteItemAsync(base + COUNT_SUFFIX).catch(() => {})]
  for (let i = 0; i < (count || 0); i++) {
    deletions.push(SecureStore.deleteItemAsync(`${base}.${i}`).catch(() => {}))
  }
  await Promise.all(deletions)
}

async function writeValue(key, value) {
  const base = safeKey(key)
  const previous = await readPointer(base)
  const gen = newGeneration()
  const chunks = splitIntoChunks(value)
  try {
    await Promise.all(chunks.map((c, i) => SecureStore.setItemAsync(chunkKey(base, gen, i), c)))
  } catch (err) {
    // The pointer was never moved, so the old value is still the value. Tidy
    // whatever part of the new generation did land.
    await deleteGeneration(base, { gen, count: chunks.length })
    throw err
  }
  // The commit: one write, and the new value is current.
  await SecureStore.setItemAsync(base + POINTER_SUFFIX, `${gen}:${chunks.length}`)
  await deleteGeneration(base, previous)
  await deleteLegacy(base)
}

async function readValue(key) {
  const base = safeKey(key)
  const ptr = await readPointer(base)
  if (ptr) {
    const parts = await Promise.all(Array.from({ length: ptr.count }, (_, i) =>
      SecureStore.getItemAsync(chunkKey(base, ptr.gen, i)).catch(() => null)))
    // With writes serialised and committed by the pointer, a missing chunk
    // means the keychain lost it. The value is unusable; report absence so the
    // caller re-authenticates instead of sending a corrupted token.
    if (parts.some(p => p == null)) {
      await removeValue(key)
      return null
    }
    return parts.join('')
  }

  const legacyCount = await readLegacyCount(base)
  if (legacyCount != null) {
    const parts = await Promise.all(Array.from({ length: legacyCount }, (_, i) =>
      SecureStore.getItemAsync(`${base}.${i}`).catch(() => null)))
    if (parts.some(p => p == null)) {
      await deleteLegacy(base)
      return null
    }
    return parts.join('')
  }

  // Nothing in SecureStore yet — an install upgrading from the AsyncStorage
  // version. Move the value across, then remove the plaintext original.
  const legacy = await AsyncStorage.getItem(key).catch(() => null)
  if (legacy == null) return null
  try {
    await writeValue(key, legacy)
    await AsyncStorage.removeItem(key)
  } catch {
    // Migration failed (keychain locked, out of space). Keep the legacy value
    // rather than stranding the user signed out; the next read retries.
  }
  return legacy
}

async function removeValue(key) {
  const base = safeKey(key)
  const ptr = await readPointer(base)
  // Pointer first: from this moment there is no value, whatever happens to
  // the deletes after it.
  await SecureStore.deleteItemAsync(base + POINTER_SUFFIX).catch(() => {})
  await deleteGeneration(base, ptr)
  await deleteLegacy(base)
}

async function setItem(key, value) {
  if (!(await available())) return AsyncStorage.setItem(key, value)
  return withLock(safeKey(key), () => writeValue(key, value))
}

async function getItem(key) {
  if (!(await available())) return AsyncStorage.getItem(key)
  return withLock(safeKey(key), () => readValue(key))
}

async function removeItem(key) {
  if (await available()) await withLock(safeKey(key), () => removeValue(key))
  // Always clear the legacy copy too, so "log out" really removes everything.
  await AsyncStorage.removeItem(key).catch(() => {})
}

// Shaped as an AsyncStorage-compatible adapter so it can be handed straight to
// supabase-js as its `auth.storage`.
export default { getItem, setItem, removeItem }
