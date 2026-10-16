// "Add to calendar" for an interview. The event itself is built in
// src/calendarEvent.js; this is the permission and calendar-choosing half.
//
// The legacy (function) API: SDK 57's object API is newer than this feature
// needs, and the legacy one behaves the same on both platforms.
import { Platform, Alert, Linking } from 'react-native'
import * as Calendar from 'expo-calendar/legacy'
import { interviewEvent, deviceTimeZone, pickWritableCalendar } from './calendarEvent'

// Ask once, and when the answer was "no" for good say where to change it — the
// OS will not show the prompt a second time.
async function ensurePermission() {
  const current = await Calendar.getCalendarPermissionsAsync()
  if (current.granted) return true
  if (current.canAskAgain === false) {
    Alert.alert('Calendar access is off',
      'Hiro can only add the interview with access to your calendar. You can turn it on in Settings.',
      [{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }])
    return false
  }
  const asked = await Calendar.requestCalendarPermissionsAsync()
  return asked.granted
}

async function targetCalendarId() {
  if (Platform.OS === 'ios') {
    const cal = await Calendar.getDefaultCalendarAsync()
    return cal?.id || null
  }
  const found = pickWritableCalendar(await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT))
  if (found) return found.id
  // A phone with no writable calendar (no Google account signed in): make a
  // local one rather than fail.
  return Calendar.createCalendarAsync({
    title: 'Hiro', name: 'Hiro', color: '#4f7cff', entityType: Calendar.EntityTypes.EVENT,
    source: { isLocalAccount: true, name: 'Hiro', type: Calendar.SourceType?.LOCAL || 'LOCAL' },
    ownerAccount: 'Hiro', accessLevel: Calendar.CalendarAccessLevel?.OWNER || 'owner',
  })
}

// Resolves to { added: true } or { added: false, reason }.
export async function addInterviewToCalendar(iv) {
  const event = interviewEvent(iv, { timeZone: deviceTimeZone() })
  if (!event) return { added: false, reason: 'This interview has no date Hiro can read.' }
  try {
    if (!(await ensurePermission())) return { added: false, reason: 'Calendar access was not allowed.' }
    const calendarId = await targetCalendarId()
    if (!calendarId) return { added: false, reason: 'No calendar on this phone accepts new events.' }
    await Calendar.createEventAsync(calendarId, event)
    return { added: true }
  } catch (err) {
    return { added: false, reason: err?.message || 'The calendar did not accept the event.' }
  }
}
