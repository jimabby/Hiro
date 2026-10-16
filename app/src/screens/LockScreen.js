// What Hiro shows while App Lock is engaged. Asks straight away, so opening the
// app is one Face ID glance rather than a glance and a tap; the button is there
// for after a cancel or a failed attempt.
import { useEffect, useMemo, useState, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { radius, useTheme } from '../theme'

export default function LockScreen({ onUnlock }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const attempt = useCallback(async () => {
    setBusy(true)
    setMessage('')
    const res = await onUnlock()
    if (!res.ok) {
      setMessage(res.reason === 'user_cancel' || res.reason === 'system_cancel' || res.reason === 'app_cancel'
        ? ''
        : 'Could not confirm it is you. Try again, or use your passcode.')
    }
    setBusy(false)
  }, [onUnlock])

  useEffect(() => { attempt() }, [attempt])

  return (
    <View style={styles.root}>
      <Text style={styles.glyph} importantForAccessibility="no" accessibilityElementsHidden>🔒︎</Text>
      <Text style={styles.title} accessibilityRole="header">Hiro is locked</Text>
      <Text style={styles.text}>Unlock with Face ID, your fingerprint or your phone’s passcode.</Text>
      <TouchableOpacity style={[styles.button, busy && { opacity: 0.6 }]} onPress={attempt} disabled={busy}
        accessibilityRole="button" accessibilityLabel="Unlock Hiro"
        accessibilityState={{ disabled: busy, busy }}>
        <Text style={styles.buttonText}>{busy ? 'Waiting…' : 'Unlock'}</Text>
      </TouchableOpacity>
      {!!message && <Text style={styles.error} accessibilityLiveRegion="polite">{message}</Text>}
    </View>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32 },
  glyph: { fontSize: 40, color: c.textMuted, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: c.text, marginBottom: 8 },
  text: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  button: {
    backgroundColor: c.accent, borderRadius: radius, paddingVertical: 12, paddingHorizontal: 40,
    minHeight: 46, alignItems: 'center', justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  error: { color: c.red, fontSize: 13, marginTop: 16, textAlign: 'center' },
})
