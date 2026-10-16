import { useEffect, useState } from 'react'
import { Alert, View, Text, TouchableOpacity } from 'react-native'
import { useTheme } from '../theme'

export default function CloudCommands({ client, active }) {
  const colors = useTheme()
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    if (active && client.getCloudCommands) client.getCloudCommands().then(r => { if (live) { setRows(r); setError('') } }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [active, client])
  if (!client.getCloudCommands) return null
  const load = async () => { try { setRows(await client.getCloudCommands()); setError('') } catch (e) { setError(e.message) } }
  const retry = async row => {
    setBusy(true)
    try { await client.retryCloudCommand(row.kind, row.id); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <View style={{ padding: 16, backgroundColor: colors.surface, borderRadius: 12, marginVertical: 12 }}>
    <Text style={{ color: colors.text, fontWeight: '700' }}>Phone commands</Text>
    <TouchableOpacity accessibilityRole="button" onPress={load} style={{ paddingVertical: 12 }}><Text style={{ color: colors.accent }}>Refresh commands</Text></TouchableOpacity>
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.red }}>{error}</Text>}
    {!rows.length && !error && <Text style={{ color: colors.text }}>No cloud commands yet.</Text>}
    {rows.map(row => <View key={`${row.kind}:${row.id}`} style={{ marginVertical: 8 }}>
      <Text style={{ color: colors.text }}>{row.kind === 'scan' ? `Scan: ${row.keywords || 'Saved search'}` : `${row.action}: ${row.jobTitle || row.application_cloud_id} ${row.company || ''}`} · {row.status}</Text>
      <Text style={{ color: colors.textMuted }}>{new Date(row.created_at).toLocaleString()}</Text>
      {!!row.error && <Text style={{ color: colors.red }}>{row.error}</Text>}
      {row.status === 'failed' && <TouchableOpacity disabled={busy} accessibilityRole="button" style={{ paddingVertical: 12 }} onPress={() => row.kind === 'review'
        ? Alert.alert('Check submission first', 'Only retry if the employer has not already received this application.', [{ text: 'Cancel' }, { text: 'Retry', onPress: () => retry(row) }]) : retry(row)}><Text style={{ color: colors.accent }}>Retry command</Text></TouchableOpacity>}
    </View>)}
  </View>
}
