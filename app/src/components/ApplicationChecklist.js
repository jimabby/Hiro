import { useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity } from 'react-native'
import { useTheme } from '../theme'
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
  return <View style={{ backgroundColor: colors.surface, padding: 16, borderRadius: 12, marginBottom: 16 }}>
    <Text style={{ color: colors.text, fontWeight: '700' }}>Application checklist · {items.filter(t => t.done).length}/{items.length}</Text>
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
    <TextInput accessibilityLabel="Checklist task" placeholder="Assessment, references, portfolio…" placeholderTextColor={colors.textMuted} value={title} onChangeText={setTitle} maxLength={200} style={{ color: colors.text, paddingVertical: 12 }} />
    <TextInput accessibilityLabel="Task due date, YYYY-MM-DD" placeholder="Due date (YYYY-MM-DD), optional" placeholderTextColor={colors.textMuted} value={due} onChangeText={setDue} maxLength={10} style={{ color: colors.text, paddingVertical: 12 }} />
    <TouchableOpacity accessibilityRole="button" disabled={busy || !title.trim()} onPress={() => change({ id: editing, title, due }, true)} style={{ paddingVertical: 12, opacity: busy || !title.trim() ? 0.4 : 1 }}><Text style={{ color: colors.accent }}>{editing ? 'Save task' : 'Add task'}</Text></TouchableOpacity>
    {!!error && <TouchableOpacity accessibilityRole="button" onPress={async () => { try { setItems(await client.getChecklist(applicationId)); setError('') } catch (e) { setError(e.message) } }}><Text style={{ color: colors.accent }}>Refresh checklist</Text></TouchableOpacity>}
    {!!editing && <TouchableOpacity accessibilityRole="button" onPress={() => { setEditing(null); setTitle(''); setDue('') }}><Text style={{ color: colors.accent }}>Cancel edit</Text></TouchableOpacity>}
  </View>
}
