// This phone's standing on the Hiro cloud account.
//
// Until now only the desktop registered itself, so the desktop's "devices on this
// account" list was a list of desktops — a phone holding a refresh token with full
// access to every application, cover letter and recruiter address was invisible
// there, and there was nothing to revoke. This is the other half.
//
// Three jobs, all of them tied to the same row in `devices`:
//
//   1. Register. One row per phone, keyed by a device id generated once and kept
//      in the Keychain/Keystore, so the desktop can list and act on it.
//   2. Carry the push token. Notifications are addressed to the token on this row,
//      which is what makes revoking a device also stop its notifications — there
//      is no second place to remember.
//   3. Honour revocation. Supabase gives a client no way to invalidate ANOTHER
//      client's refresh token, so "revoke this phone" sets a flag here and the
//      phone is responsible for signing itself out when it sees it. Checked on
//      every foreground and every refresh, not just at launch.

import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as Device from 'expo-device'
import secureStore from './secureStore'
import { supabase } from './supabase'

const DEVICE_ID_KEY = 'hiro.deviceId'

// Generated once and never regenerated: a device whose id changes on every launch
// cannot be listed, trusted or revoked, which defeats the point of the registry.
// Stored in the Keychain/Keystore alongside the session it identifies.
export async function getDeviceId() {
  try {
    const existing = await secureStore.getItem(DEVICE_ID_KEY)
    if (existing) return existing
  } catch { /* fall through and mint a new one */ }

  // crypto.randomUUID is not in the Hermes/RN global scope, so build one from
  // getRandomValues, which react-native-url-polyfill has already installed.
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  try { await secureStore.setItem(DEVICE_ID_KEY, id) } catch { /* best-effort */ }
  return id
}

function deviceName() {
  // "Jim's iPhone" is what the user will recognise in the desktop's device list;
  // the model name is the fallback when the OS will not give a device name.
  return Device.deviceName || Device.modelName || `${Platform.OS} phone`
}

// Session age in the desktop's device list is "when did this client
// authenticate", not "when did the device first appear", so it is stamped once
// per app process rather than read from the row.
const sessionStartedAt = new Date().toISOString()

export async function registerDevice(userId, { pushToken = undefined } = {}) {
  if (!supabase || !userId) return { success: false, reason: 'not-signed-in' }
  const deviceId = await getDeviceId()

  const row = {
    user_id: userId,
    device_id: deviceId,
    name: deviceName(),
    platform: Platform.OS,
    kind: 'mobile',
    app_version: Application.nativeApplicationVersion || '',
    session_started_at: sessionStartedAt,
    last_seen_at: new Date().toISOString(),
  }
  // Only send push_token when the caller actually has one. Sending undefined
  // would be serialised as null and wipe a token registered earlier in the
  // session — a phone that then silently stopped receiving notifications.
  if (pushToken !== undefined) row.push_token = pushToken

  const { error } = await supabase.from('devices').upsert([row], { onConflict: 'user_id,device_id' })
  if (error) {
    // A project that has not re-run schema.sql has no devices table, or an older
    // one without these columns. Neither is worth surfacing to the user on a
    // phone — the desktop's Settings page is where that gets fixed — but the
    // caller needs to know registration did not happen.
    return { success: false, reason: error.message, deviceId }
  }
  return { success: true, deviceId }
}

// Has the account owner cut this phone off? Returns true when the caller should
// treat itself as signed out.
//
// The row being MISSING is deliberately not treated as revocation: "Remove from
// list" on the desktop is bookkeeping, and a phone that vanished from the list
// simply re-registers. Only an explicit revoked_at means "sign yourself out".
export async function checkRevoked(userId) {
  if (!supabase || !userId) return false
  const deviceId = await getDeviceId()
  const { data, error } = await supabase
    .from('devices')
    .select('revoked_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle()
  if (error || !data?.revoked_at) return false

  // Clear the flag on the way out so the row is not left revoked forever if the
  // user signs back in deliberately. Best-effort: signing out matters more, and
  // after signOut() this client has no authority to write anything.
  try {
    await supabase.from('devices')
      .update({ revoked_at: null, push_token: null })
      .eq('user_id', userId).eq('device_id', deviceId)
  } catch { /* the sign-out below is the part that matters */ }

  try { await supabase.auth.signOut() } catch { /* session may already be void */ }
  return true
}

// Called when the user signs out on purpose. The row stays — the desktop's list
// should still show the phone — but the push token goes, or notifications would
// keep arriving on a phone that is no longer signed in.
export async function clearPushToken(userId) {
  if (!supabase || !userId) return
  try {
    const deviceId = await getDeviceId()
    await supabase.from('devices').update({ push_token: null })
      .eq('user_id', userId).eq('device_id', deviceId)
  } catch { /* best-effort */ }
}
