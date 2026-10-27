import { useEffect, useState } from 'react'
import { Alert, View, Text, TouchableOpacity } from 'react-native'
import { useTheme } from '../theme'

// What each command state means for the person who sent it. 'accepted' differs
// by kind: a claimed scan is in the desktop's own queue, a claimed review is
// still waiting to start (and can still be changed).
const STATE = {
  queued: 'waiting for the desktop', accepted: 'picked up by the desktop', running: 'in progress',
  completed: 'done', failed: 'failed', cancelled: 'cancelled',
}
const canChange = row => row.kind === 'review' ? ['queued', 'accepted'].includes(row.status) : row.status === 'queued'

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
  // Every change re-reads the list afterwards, success or not: a refused
  // change ("too late") means the row moved on, and the list should show where.
  const act = async fn => {
    setBusy(true)
    let failed = ''
    try { await fn() } catch (e) { failed = e.message }
    await load()
    if (failed) setError(failed)
    setBusy(false)
  }
  const retry = row => act(() => client.retryCloudCommand(row.kind, row.id))
  const cancel = row => act(() => client.cancelCloudCommand(row.kind, row.id))
  const swap = row => act(() => client.requestReviewAction(row.application_cloud_id, row.action === 'approve' ? 'reject' : 'approve'))
  return <View style={{ padding: 16, backgroundColor: colors.surface, borderRadius: 12, marginVertical: 12 }}>
    <Text style={{ color: colors.text, fontWeight: '700' }}>Phone commands</Text>
    <TouchableOpacity accessibilityRole="button" onPress={load} style={{ paddingVertical: 12 }}><Text style={{ color: colors.accent }}>Refresh commands</Text></TouchableOpacity>
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.red }}>{error}</Text>}
    {!rows.length && !error && <Text style={{ color: colors.text }}>No cloud commands yet.</Text>}
    {rows.map(row => <View key={`${row.kind}:${row.id}`} style={{ marginVertical: 8 }}>
      <Text style={{ color: colors.text }}>{row.kind === 'scan' ? `Scan: ${row.keywords || 'Saved search'}` : `${row.action}: ${row.jobTitle || row.application_cloud_id} ${row.company || ''}`} · {STATE[row.status] || row.status}</Text>
      <Text style={{ color: colors.textMuted }}>{new Date(row.created_at).toLocaleString()}</Text>
      {!!row.error && <Text style={{ color: row.status === 'cancelled' ? colors.textMuted : colors.red }}>{row.error}</Text>}
      {canChange(row) && <View style={{ flexDirection: 'row', gap: 16 }}>
        {row.kind === 'review' && client.requestReviewAction && <TouchableOpacity disabled={busy} accessibilityRole="button" style={{ paddingVertical: 12 }}
          onPress={() => row.action === 'reject'
            ? Alert.alert('Approve instead?', 'The desktop will submit this application on its next sync.', [{ text: 'Keep rejection' }, { text: 'Approve', onPress: () => swap(row) }])
            : swap(row)}>
          <Text style={{ color: colors.accent }}>{row.action === 'approve' ? 'Switch to reject' : 'Switch to approve'}</Text></TouchableOpacity>}
        {client.cancelCloudCommand && <TouchableOpacity disabled={busy} accessibilityRole="button" style={{ paddingVertical: 12 }} onPress={() => cancel(row)}>
          <Text style={{ color: colors.accent }}>{row.kind === 'scan' ? 'Cancel scan' : 'Cancel decision'}</Text></TouchableOpacity>}
      </View>}
      {row.status === 'failed' && <TouchableOpacity disabled={busy} accessibilityRole="button" style={{ paddingVertical: 12 }} onPress={() => row.kind === 'review'
        ? Alert.alert('Check submission first', 'Only retry if the employer has not already received this application.', [{ text: 'Cancel' }, { text: 'Retry', onPress: () => retry(row) }]) : retry(row)}><Text style={{ color: colors.accent }}>Retry command</Text></TouchableOpacity>}
    </View>)}
  </View>
}
