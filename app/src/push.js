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
import { registerDevice, clearPushToken } from './deviceRegistry'

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
