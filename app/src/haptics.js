// Haptic feedback, in the three strengths the app uses.
//
// Every call is fire-and-forget and swallows failure: a device with no haptic
// engine, the iOS setting that disables system haptics, or a simulator all
// reject, and none of those should surface as an error on the action that
// triggered the buzz.
import * as Haptics from 'expo-haptics'

const quiet = (p) => { p?.catch?.(() => {}) }

// A choice changed — a status chip, a sort, a filter.
export function selection() {
  quiet(Haptics.selectionAsync())
}

// Something was saved or queued.
export function success() {
  quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
}

// A save failed and the screen rolled it back.
export function failure() {
  quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error))
}

// A swipe crossed the point where letting go keeps the row open.
export function threshold() {
  quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
}
