import { useState, useMemo } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native'
import { radius, useTheme } from '../theme'
// Pure date helpers live in src/dates.js so they can be unit-tested without a
// React Native runtime; re-exported here so the screens have one import.
import { localDateIn, todayLocal, describeDue, isOverdue } from '../dates'

export { localDateIn, todayLocal, describeDue, isOverdue }

// Booking the next follow-up, from the phone.
//
// Deciding "chase them Thursday" is exactly the sort of thing done away from the
// desk — on the train, after a call — so it must not be desktop-only. It also
// must not require a date picker: there is no cross-platform inline picker in
// bare React Native, and a modal spinner for "in three days" is more friction
// than the feature is worth. Relative buttons cover every real case; an exact
// date is a rare enough need to leave to the desktop.

const QUICK = [
  { label: 'Tomorrow', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
]

export default function NextAction({ app, onSave, onComplete }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [open, setOpen] = useState(false)
  const [note, setNote] = useState(app?.next_action_note || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const due = app?.next_action_at
  const overdue = isOverdue(due)

  async function commit(days) {
    setBusy(true)
    setError('')
    try {
      await onSave({ date: localDateIn(days), note })
      setOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    setError('')
    try {
      await onComplete()
      setOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.card, overdue && styles.cardOverdue]}>
      <Text style={styles.cardTitle}>Next action</Text>

      {due ? (
        <View style={styles.dueRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.dueText, overdue && styles.overdueText]}>
              {app.next_action_note || 'Follow up'}
            </Text>
            <Text style={[styles.muted, overdue && styles.overdueText]}>
              {describeDue(due)} · {String(due).slice(0, 10)}
            </Text>
          </View>
          <TouchableOpacity style={styles.btn} disabled={busy} onPress={clear}
            accessibilityRole="button" accessibilityLabel="Mark this follow-up done"
            accessibilityState={{ disabled: busy }}>
            <Text style={styles.btnText}>Done</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={styles.muted}>
          Nothing planned. Book a follow-up so this does not go quiet.
        </Text>
      )}

      {!open ? (
        <TouchableOpacity style={styles.btnGhost} onPress={() => setOpen(true)}
          accessibilityRole="button" accessibilityLabel="Book a follow-up">
          <Text style={styles.btnGhostText}>{due ? 'Reschedule' : 'Set a follow-up'}</Text>
        </TouchableOpacity>
      ) : (
        <View style={{ marginTop: 10 }}>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={setNote}
            placeholder="What needs doing?"
            placeholderTextColor={colors.textMuted}
          />
          <View style={styles.quickRow}>
            {QUICK.map(q => (
              <TouchableOpacity key={q.days} style={styles.quick} disabled={busy}
                accessibilityRole="button" accessibilityLabel={`Follow up ${q.label}`}
                accessibilityState={{ disabled: busy }}
                onPress={() => commit(q.days)}>
                <Text style={styles.quickText}>{q.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={styles.btnGhost} onPress={() => setOpen(false)}
            accessibilityRole="button" accessibilityLabel="Close the follow-up picker">
            <Text style={styles.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderRadius: radius,
    padding: 14,
    marginTop: 14,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  cardOverdue: { borderLeftColor: c.red },
  cardTitle: { color: c.text, fontWeight: '600', fontSize: 14, marginBottom: 8 },
  dueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dueText: { color: c.text, fontSize: 14 },
  overdueText: { color: c.red },
  muted: { color: c.textMuted, fontSize: 12 },
  input: {
    backgroundColor: c.bg,
    color: c.text,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    marginBottom: 10,
  },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  quick: {
    backgroundColor: c.bg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  quickText: { color: c.accent, fontSize: 12, fontWeight: '600' },
  btn: {
    backgroundColor: c.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  btnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  btnGhost: { marginTop: 10, alignSelf: 'flex-start' },
  btnGhostText: { color: c.accent, fontSize: 12, fontWeight: '600' },
  error: { color: c.red, fontSize: 12, marginTop: 8 },
})
