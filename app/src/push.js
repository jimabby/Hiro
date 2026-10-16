// Push notification registration on the phone.
//
// The desktop is the sender (see web/electron/services/push.js); this side only
// has to obtain a token, put it where the desktop can find it, and decide what
// happens when a notification is tapped.
//
// Deliberate choices:
//
//   Permission is requested lazily. Asking for notification permission on first
//   launch, before the user has seen what the app does, is how apps get denied
//   permanently — iOS only ever shows that prompt once. It is requested when the
//   user turns notifications on in Settings, or on a later launch if they already
//   have them on.
//
//   Nothing is stored locally. The token lives on this phone's row in `devices`,
//   which means revoking the device revokes its notifications too.

import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { registerDevice, clearPushToken, getRegisteredPushToken } from './deviceRegistry'

// A notification that arrives while the app is open should still be visible —
// otherwise a reply that lands while the user is looking at the dashboard is
// silently swallowed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

// Android requires an explicit channel or notifications arrive with no sound and
// no heads-up display, which reads as "notifications are broken".
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Hiro',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default',
  })
}

export async function getPermissionStatus() {
  try {
    const { status } = await Notifications.getPermissionsAsync()
    return status
  } catch {
    return 'undetermined'
  }
}

// Ask for permission and return an Expo push token, or a reason it could not.
export async function requestPushToken() {
  // A simulator has no APNs/FCM registration, so this fails in a way that looks
  // like a bug unless it is named.
  if (!Device.isDevice) {
    return { token: null, reason: 'Push notifications need a real device — a simulator cannot register for them.' }
  }
  await ensureAndroidChannel()

  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted') {
    ({ status } = await Notifications.requestPermissionsAsync())
  }
  if (status !== 'granted') {
    return { token: null, reason: 'Notifications are turned off for Hiro in your phone’s settings.' }
  }

  // The project id is what routes a token to the right Expo account. Without it
  // getExpoPushTokenAsync throws an unhelpful error in a standalone build.
  const projectId = Constants.expoConfig?.extra?.eas?.projectId
    || Constants.easConfig?.projectId
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)
    return { token: data, reason: null }
  } catch (err) {
    return { token: null, reason: err.message }
  }
}

// Turn notifications on: get a token and hand it to the desktop by writing it to
// this phone's device row.
export async function enablePush(userId) {
  const { token, reason } = await requestPushToken()
  if (!token) return { success: false, reason }
  const res = await registerDevice(userId, { pushToken: token })
  if (!res.success) {
    return {
      success: false,
      reason: /devices/.test(res.reason || '')
        ? 'Your Supabase project needs the devices table — re-run supabase/schema.sql, then try again.'
        : res.reason,
    }
  }
  return { success: true, token }
}

export async function disablePush(userId) {
  await clearPushToken(userId)
  return { success: true }
}

// What "notifications on this phone" actually is. The OS permission alone said
// "Enabled" on a phone whose token had been cleared (signed out and back in, a
// revoked device, notifications turned off here) — the permission was still
// granted, but the desktop had nothing to send to.
//   'on'          permission granted and a token on this phone's row
//   'off'         no token registered
//   'blocked'     a token is registered but the OS permission is off, so
//                 nothing will be shown
//   'unknown'     the row could not be read (offline); say so, do not guess
export async function getPushState(userId) {
  const [permission, token] = await Promise.all([getPermissionStatus(), getRegisteredPushToken(userId)])
  if (token === undefined) return 'unknown'
  if (!token) return 'off'
  return permission === 'granted' ? 'on' : 'blocked'
}

// Keep the registered token current. Run on launch and on every foreground
// while signed in. Only refreshes a token that is already registered: a phone
// whose owner turned notifications off here must not be turned back on just
// because the OS permission is still granted.
export async function syncPushToken(userId) {
  if (!userId || !Device.isDevice) return
  const registered = await getRegisteredPushToken(userId)
  if (!registered) return
  if ((await getPermissionStatus()) !== 'granted') return
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)
    if (data && data !== registered) await registerDevice(userId, { pushToken: data })
  } catch { /* the old token stays; the next launch tries again */ }
}

// APNs and FCM rotate the device token (a restore onto a new phone, an app
// reinstall, FCM's own refresh). Without a listener the row kept the old one
// and notifications silently stopped until the user toggled them off and on.
export function subscribeToTokenRotation(userId) {
  if (!userId) return () => {}
  const sub = Notifications.addPushTokenListener(() => { syncPushToken(userId) })
  return () => sub.remove()
}

// Tapping a notification should land on the thing it was about. The desktop puts
// a `kind` and the relevant id in the payload; this maps that to a screen the app
// already has, and returns null when there is nothing specific to open.
export function routeForNotification(data) {
  if (!data) return null
  // Checked BEFORE the applicationId branch, which every kind carrying an id
  // would otherwise swallow. An offer-deadline notification names an
  // application, but the thing the reader wants is the offer board — the
  // deadline, the number, and what else is on the table beside it. Opening the
  // application detail instead would show them the job advert.
  if (data.kind === 'offer-deadline') return { tab: 'offers' }
  if (data.applicationId != null) return { tab: 'applications', applicationId: data.applicationId }
  if (data.kind === 'review' || data.kind === 'expiring') return { tab: 'applications' }
  if (data.kind === 'new-device') return { tab: 'settings' }
  return { tab: 'dashboard' }
}

// Subscribe to taps. Also handles the case where the notification tap is what
// launched the app, which arrives through a different API than a tap on a running
// app and is easy to miss.
export function subscribeToTaps(onRoute) {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const route = routeForNotification(response?.notification?.request?.content?.data)
    if (route) onRoute(route)
  })
  Notifications.getLastNotificationResponseAsync().then(response => {
    if (!response) return
    const route = routeForNotification(response?.notification?.request?.content?.data)
    if (route) onRoute(route)
  }).catch(() => {})
  return () => subscription.remove()
}
