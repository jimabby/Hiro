import { useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity } from 'react-native'
import { getPending, editPending, cancelPending, flush } from '../scanQueue'
import { useTheme } from '../theme'

export default function ScanQueue({ client, refreshKey, onChanged }) {
  const colors = useTheme()
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null), [keywords, setKeywords] = useState(''), [location, setLocation] = useState('')
  useEffect(() => {
    let live = true
    getPending().then(r => { if (live) setRows(r) }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [client, refreshKey])
  async function act(fn) {
    setBusy(true); setError('')
    try {
      await fn()
      const next = await getPending(); setRows(next); onChanged(next.length); setEditing(null)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const button = (title, fn, disabled = false) => <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy || disabled }} disabled={busy || disabled} onPress={() => act(fn)} style={{ padding: 10, opacity: busy || disabled ? 0.4 : 1 }}><Text style={{ color: colors.accent }}>{title}</Text></TouchableOpacity>
  if (!rows.length && !error) return null
  return <View style={{ padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 12, marginBottom: 16 }}>
    <Text style={{ color: colors.text, fontWeight: '700' }}>Offline scan queue</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.red }}>{error}</Text> : null}
    {rows.map(row => <View key={row.id} style={{ paddingTop: 12 }}>
      <Text style={{ color: colors.text }}>{row.keywords || 'Default search'}</Text>
      <Text style={{ color: colors.textMuted }}>{row.destination?.label || 'Unknown original destination — cancel and create a new request'}</Text>
      {row.location ? <Text style={{ color: colors.textMuted }}>{row.location}</Text> : null}
      {row.lastError ? <Text style={{ color: colors.textMuted }}>{row.lastError}</Text> : null}
      {editing === row.id ? <View>
        <TextInput accessibilityLabel="Queued search keywords" value={keywords} onChangeText={setKeywords} style={{ color: colors.text, padding: 8 }} />
        <TextInput accessibilityLabel="Queued search location" value={location} onChangeText={setLocation} style={{ color: colors.text, padding: 8 }} />
        {button('Save changes', () => editPending(row.id, { keywords, location }))}
      </View> : <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <TouchableOpacity disabled={busy} accessibilityRole="button" onPress={() => { setEditing(row.id); setKeywords(row.keywords || ''); setLocation(row.location || '') }} style={{ padding: 10 }}><Text style={{ color: colors.accent }}>Edit</Text></TouchableOpacity>
        {button('Retry', () => flush(client, row.id), !row.destination?.key || row.destination.key !== client.queueDestination?.key)}
        {button('Cancel request', () => cancelPending(row.id))}
      </View>}
    </View>)}
  </View>
}
