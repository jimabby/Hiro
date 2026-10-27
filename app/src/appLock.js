// App Lock rules: when the app should ask for Face ID / fingerprint / the
// device passcode again. Pure so the timing is testable from plain Node — the
// hook that applies it is src/useAppLock.js.

const SETTINGS_KEY = 'hiro.appLock'
// Minutes in the background before the lock comes back. 0 = every time.
const TIMEOUT_CHOICES = [0, 1, 5, 15]
const DEFAULT_TIMEOUT_MINUTES = 5

function parseLockSettings(raw) {
  let value = null
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { value = null }
  const minutes = Number(value?.timeoutMinutes)
  return {
    enabled: value?.enabled === true,
    timeoutMinutes: TIMEOUT_CHOICES.includes(minutes) ? minutes : DEFAULT_TIMEOUT_MINUTES,
  }
}

// Called when the app comes back to the foreground. `backgroundedAt` is when
// it went to the background (null when it never did — a cold launch is decided
// separately: it always locks when the lock is on).
//
// Only a real trip to the background counts. iOS also reports "inactive" for
// Control Centre, the app switcher, and the Face ID sheet itself — counting
// that would re-lock the app the moment it unlocked.
function shouldLock({ enabled, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, backgroundedAt, now = Date.now() }) {
  if (!enabled || backgroundedAt == null) return false
  // A clock moved backwards cannot prove the app was away briefly; lock.
  if (now < backgroundedAt) return true
  return now - backgroundedAt >= timeoutMinutes * 60 * 1000
}

// Whether to draw the privacy cover over the app. iOS photographs the screen
// for the app switcher the moment the app goes "inactive", and Android does it
// on the way to the background — so with the lock on, both states cover the
// content, even though neither re-locks by itself (see shouldLock). Not while a
// Face ID / passcode prompt is up: that also makes the app inactive, and
// blanking the screen behind the sheet would only flicker.
function shouldObscure({ enabled, appState, prompting = false }) {
  if (!enabled || prompting) return false
  return appState === 'inactive' || appState === 'background'
}

function describeTimeout(minutes) {
  if (minutes === 0) return 'Immediately'
  return `After ${minutes} min`
}

module.exports = { SETTINGS_KEY, TIMEOUT_CHOICES, DEFAULT_TIMEOUT_MINUTES, parseLockSettings, shouldLock, shouldObscure, describeTimeout }
