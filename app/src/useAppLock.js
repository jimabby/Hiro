// Opt-in App Lock: Face ID / fingerprint, falling back to the device passcode.
//
// The phone already keeps the credentials in the Keychain/Keystore. What this
// adds is that someone holding an unlocked phone cannot open Hiro and read
// every application, recruiter reply and offer in it. Off by default — it is a
// preference, not a requirement — and the setting is not a secret, so it lives
// in AsyncStorage.
import { useState, useEffect, useCallback, useRef } from 'react'
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as LocalAuthentication from 'expo-local-authentication'
import { SETTINGS_KEY, parseLockSettings, shouldLock } from './appLock'

// Whether this phone can lock at all: biometrics enrolled, or at least a
// passcode set (the fallback). A phone with neither has nothing to unlock with.
export async function lockAvailability() {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync()
    return level !== LocalAuthentication.SecurityLevel.NONE
  } catch {
    return false
  }
}

async function authenticate(promptMessage) {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage,
      // The passcode fallback is the point: a wet finger or a mask must not
      // lock someone out of their own app.
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    })
    return res.success ? { ok: true } : { ok: false, reason: res.error }
  } catch (err) {
    return { ok: false, reason: err?.message || 'unavailable' }
  }
}

export function useAppLock() {
  // undefined while the setting loads, so the app shows nothing rather than
  // flashing the unlocked content before the lock appears.
  const [settings, setSettings] = useState(undefined)
  const [locked, setLocked] = useState(false)
  const backgroundedAt = useRef(null)
  // The passcode screen (and on some Android builds the biometric sheet) is
  // another activity, so asking for it sends Hiro to the "background" and
  // back. Without this, a zero-minute timeout re-locked the app the instant it
  // unlocked. Transitions are ignored while a prompt is up and just after.
  const promptingUntil = useRef(0)
  const settingsRef = useRef(null)
  settingsRef.current = settings

  useEffect(() => {
    let live = true
    AsyncStorage.getItem(SETTINGS_KEY)
      .then(raw => parseLockSettings(raw))
      .catch(() => parseLockSettings(null))
      .then(s => {
        if (!live) return
        setSettings(s)
        if (s.enabled) setLocked(true) // a cold launch always asks
      })
    return () => { live = false }
  }, [])

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (Date.now() < promptingUntil.current) {
        backgroundedAt.current = null
        return
      }
      if (state === 'background') {
        if (backgroundedAt.current == null) backgroundedAt.current = Date.now()
        return
      }
      if (state === 'active') {
        const s = settingsRef.current
        if (s && shouldLock({ ...s, backgroundedAt: backgroundedAt.current })) setLocked(true)
        backgroundedAt.current = null
      }
    })
    return () => sub.remove()
  }, [])

  const prompt = useCallback(async (message) => {
    promptingUntil.current = Number.MAX_SAFE_INTEGER
    try {
      return await authenticate(message)
    } finally {
      promptingUntil.current = Date.now() + 1500
      backgroundedAt.current = null
    }
  }, [])

  const unlock = useCallback(async () => {
    const res = await prompt('Unlock Hiro')
    if (res.ok) setLocked(false)
    return res
  }, [prompt])

  const save = useCallback(async (next) => {
    setSettings(next)
    try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* applies for this session */ }
  }, [])

  // Turning the lock on proves it works first — otherwise a phone whose
  // biometrics fail would lock its owner out on the next launch.
  const setEnabled = useCallback(async (enabled) => {
    const current = settingsRef.current || parseLockSettings(null)
    if (enabled) {
      if (!(await lockAvailability())) {
        return { ok: false, reason: 'Set up Face ID, a fingerprint or a passcode on this phone first.' }
      }
      const res = await prompt('Turn on App Lock')
      if (!res.ok) return { ok: false, reason: res.reason === 'user_cancel' ? '' : 'Could not confirm it is you.' }
    }
    await save({ ...current, enabled })
    return { ok: true }
  }, [save, prompt])

  const setTimeoutMinutes = useCallback(async (timeoutMinutes) => {
    await save({ ...(settingsRef.current || parseLockSettings(null)), timeoutMinutes })
  }, [save])

  return { settings, locked, unlock, setEnabled, setTimeoutMinutes }
}
