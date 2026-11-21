import { useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity } from 'react-native'
import { useTheme, radius } from '../theme'
import { todayLocal } from '../dates'

export default function ApplicationChecklist({ client, applicationId }) {
  const colors = useTheme()
  const [items, setItems] = useState([]), [title, setTitle] = useState(''), [due, setDue] = useState('')
  const [editing, setEditing] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    client.getChecklist(applicationId).then(rows => { if (live) setItems(rows) }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [client, applicationId])
  async function change(input, reset = false) {
    setBusy(true); setError('')
    try { setItems(await client.updateChecklist(applicationId, input)); if (reset) { setTitle(''); setDue(''); setEditing(null) } }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  // The same card as the rest of the detail screen. This one had no border and
  // only a bottom margin, so it sat flush against the Match card above it, and
  // its two text fields had no fill or outline — they read as grey captions,
  // not as somewhere to type.
  const input = {
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: radius,
    color: colors.text, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, marginTop: 10,
  }
  return <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 14, borderRadius: radius, marginTop: 12 }}>
    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>Application checklist · {items.filter(t => t.done).length}/{items.length}</Text>
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.red }}>{error}</Text>}
    {items.map(item => <View key={item.id} style={{ marginTop: 12 }}>
      <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: !!item.done, disabled: busy }} disabled={busy} onPress={() => change({ id: item.id, done: !item.done })} style={{ paddingVertical: 8 }}>
        <Text style={{ color: colors.text }}>{item.done ? '☑' : '☐'} {item.title}</Text>
      </TouchableOpacity>
      {!!item.due && <Text style={{ color: !item.done && item.due < todayLocal() ? colors.red : colors.textMuted }}>{item.due}</Text>}
      <View style={{ flexDirection: 'row', gap: 20 }}>
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { setEditing(item.id); setTitle(item.title); setDue(item.due || '') }} style={{ paddingVertical: 8 }}><Text style={{ color: colors.accent }}>Edit</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete ${item.title}`} disabled={busy} onPress={() => change({ id: item.id, remove: true })} style={{ paddingVertical: 8 }}><Text style={{ color: colors.accent }}>Delete</Text></TouchableOpacity>
      </View>
    </View>)}
    <TextInput accessibilityLabel="Checklist task" placeholder="Assessment, references, portfolio…" placeholderTextColor={colors.textMuted} value={title} onChangeText={setTitle} maxLength={200} style={input} />
    <TextInput accessibilityLabel="Task due date, YYYY-MM-DD" placeholder="Due date (YYYY-MM-DD), optional" placeholderTextColor={colors.textMuted} value={due} onChangeText={setDue} maxLength={10} style={input} />
    <TouchableOpacity accessibilityRole="button" disabled={busy || !title.trim()} onPress={() => change({ id: editing, title, due }, true)} style={{ marginTop: 10, minHeight: 44, borderRadius: radius, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', opacity: busy || !title.trim() ? 0.45 : 1 }}><Text style={{ color: colors.accent, fontSize: 13, fontWeight: '600' }}>{editing ? 'Save task' : 'Add task'}</Text></TouchableOpacity>
    {!!error && <TouchableOpacity accessibilityRole="button" onPress={async () => { try { setItems(await client.getChecklist(applicationId)); setError('') } catch (e) { setError(e.message) } }}><Text style={{ color: colors.accent }}>Refresh checklist</Text></TouchableOpacity>}
    {!!editing && <TouchableOpacity accessibilityRole="button" onPress={() => { setEditing(null); setTitle(''); setDue('') }}><Text style={{ color: colors.accent }}>Cancel edit</Text></TouchableOpacity>}
  </View>
}
