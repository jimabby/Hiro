import { useState, useMemo } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Platform, useColorScheme } from 'react-native'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { radius, useTheme } from '../theme'
// Pure date helpers live in src/dates.js so they can be unit-tested without a
// React Native runtime; re-exported here so the screens have one import.
import { localDateIn, localDateOf, todayLocal, describeDue, isOverdue, formatDay, parseLocal } from '../dates'

export { localDateIn, todayLocal, describeDue, isOverdue }

// Booking the next follow-up, from the phone.
//
// Deciding "chase them Thursday" is exactly the sort of thing done away from the
// desk — on the train, after a call — so it must not be desktop-only. The
// relative buttons are the fast path and cover most cases; "Pick a date" is for
// the rest ("they said to call after the 14th"), using the platform's own
// picker: an inline calendar on iOS, the system dialog on Android.

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
  // iOS only: the inline calendar, and the day selected on it but not yet saved.
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState(null)
  const scheme = useColorScheme()

  const due = app?.next_action_at
  const overdue = isOverdue(due)

  async function commitDate(date) {
    setBusy(true)
    setError('')
    try {
      await onSave({ date, note })
      setOpen(false)
      setPicking(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const commit = (days) => commitDate(localDateIn(days))

  // Opens on the current follow-up when there is one, else a week out — the
  // most common choice, so the calendar starts in the right month.
  const initialPick = () => {
    const current = due && parseLocal(String(due).slice(0, 10))
    return current && current >= parseLocal(todayLocal()) ? current : parseLocal(localDateIn(7))
  }

  function pickDate() {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: initialPick(),
        mode: 'date',
        minimumDate: new Date(),
        onChange: (event, date) => {
          if (event.type === 'set' && date) commitDate(localDateOf(date))
        },
      })
      return
    }
    setPicked(initialPick())
    setPicking(true)
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
              {describeDue(due)} · {formatDay(String(due).slice(0, 10))}
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
            returnKeyType="done"
            accessibilityLabel="Follow-up note"
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
          {picking && Platform.OS === 'ios' ? (
            <View style={styles.pickerWrap}>
              <DateTimePicker
                value={picked || initialPick()}
                mode="date"
                display="inline"
                minimumDate={new Date()}
                accentColor={colors.accent}
                themeVariant={scheme === 'light' ? 'light' : 'dark'}
                onChange={(_, date) => date && setPicked(date)}
              />
              <TouchableOpacity style={[styles.btn, styles.pickerConfirm]} disabled={busy || !picked}
                onPress={() => picked && commitDate(localDateOf(picked))}
                accessibilityRole="button"
                accessibilityLabel={picked ? `Follow up on ${formatDay(localDateOf(picked))}` : 'Choose a day'}
                accessibilityState={{ disabled: busy || !picked, busy }}>
                <Text style={styles.btnText}>
                  {picked ? `Follow up ${formatDay(localDateOf(picked))}` : 'Choose a day'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.btnGhost} onPress={pickDate} disabled={busy}
              accessibilityRole="button" accessibilityLabel="Pick an exact date for the follow-up">
              <Text style={styles.btnGhostText}>Pick a date…</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.btnGhost} onPress={() => { setOpen(false); setPicking(false) }}
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
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 14,
    marginBottom: 10,
  },
  // Four equal buttons in a row, each tall enough to hit with a thumb. They
  // used to be ~30pt chips, the smallest targets in the app for the one action
  // most likely to be taken standing up.
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quick: {
    flexGrow: 1,
    flexBasis: '22%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.bg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    minHeight: 42,
  },
  quickText: { color: c.accent, fontSize: 13, fontWeight: '600' },
  btn: {
    backgroundColor: c.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    minHeight: 38,
    justifyContent: 'center',
  },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pickerWrap: { marginTop: 8 },
  pickerConfirm: { alignItems: 'center', marginTop: 4, minHeight: 42 },
  btnGhost: { marginTop: 6, alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' },
  btnGhostText: { color: c.accent, fontSize: 13, fontWeight: '600' },
  error: { color: c.red, fontSize: 12, marginTop: 8 },
})
