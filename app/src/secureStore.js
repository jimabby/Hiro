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

async function clearChunks(key) {
  const base = safeKey(key)
  let count = 0
  try {
    count = parseInt(await SecureStore.getItemAsync(base + COUNT_SUFFIX), 10) || 0
  } catch { count = 0 }
  const deletions = [SecureStore.deleteItemAsync(base + COUNT_SUFFIX).catch(() => {})]
  for (let i = 0; i < count; i++) {
    deletions.push(SecureStore.deleteItemAsync(`${base}.${i}`).catch(() => {}))
  }
  await Promise.all(deletions)
}

async function setItem(key, value) {
  if (!(await available())) return AsyncStorage.setItem(key, value)
  const base = safeKey(key)
  await clearChunks(key)
  const chunks = splitIntoChunks(value)
  // Chunks first, count last: a write interrupted partway leaves no count, so
  // getItem reports "nothing stored" rather than reassembling a truncated
  // token and failing authentication in a way that looks like a server fault.
  await Promise.all(chunks.map((c, i) => SecureStore.setItemAsync(`${base}.${i}`, c)))
  await SecureStore.setItemAsync(base + COUNT_SUFFIX, String(chunks.length))
}

async function getItem(key) {
  if (!(await available())) return AsyncStorage.getItem(key)
  const base = safeKey(key)
  let count = null
  try {
    count = await SecureStore.getItemAsync(base + COUNT_SUFFIX)
  } catch { count = null }

  if (count == null) {
    // Nothing in SecureStore yet — an install upgrading from the AsyncStorage
    // version. Move the value across, then remove the plaintext original.
    const legacy = await AsyncStorage.getItem(key).catch(() => null)
    if (legacy == null) return null
    try {
      await setItem(key, legacy)
      await AsyncStorage.removeItem(key)
    } catch {
      // Migration failed (keychain locked, out of space). Keep the legacy value
      // rather than stranding the user signed out; the next read retries.
      return legacy
    }
    return legacy
  }

  const n = parseInt(count, 10) || 0
  const parts = await Promise.all(
    Array.from({ length: n }, (_, i) => SecureStore.getItemAsync(`${base}.${i}`).catch(() => null))
  )
  // A missing chunk means the stored value is unusable; report absence so the
  // caller re-authenticates instead of sending a corrupted token.
  if (parts.some(p => p == null)) {
    await clearChunks(key)
    return null
  }
  return parts.join('')
}

async function removeItem(key) {
  await clearChunks(key)
  // Always clear the legacy copy too, so "log out" really removes everything.
  await AsyncStorage.removeItem(key).catch(() => {})
}

// Shaped as an AsyncStorage-compatible adapter so it can be handed straight to
// supabase-js as its `auth.storage`.
export default { getItem, setItem, removeItem }
