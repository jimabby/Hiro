import { useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, Alert } from 'react-native'
import { getPending, editPending, cancelPending, flush, resetCorruptQueue, kindOf } from '../scanQueue'
import { useTheme } from '../theme'

// Turns a flush result into one line for the user. Exported for the Dashboard,
// which flushes on every load and needs to say the same thing.
export function describeFlush(result) {
  if (!result) return ''
  const parts = []
  for (const d of result.dropped || []) {
    parts.push(`${d.kind === 'import' ? 'Import' : 'Scan'} "${d.label}" was refused and removed: ${d.error}`)
  }
  if (result.needsPairing) parts.push('The desktop no longer accepts this phone — re-pair to send what is waiting.')
  return parts.join('\n')
}

export default function ScanQueue({ client, refreshKey, onChanged, onNeedsPairing }) {
  const colors = useTheme()
  const [rows, setRows] = useState([]), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(null), [keywords, setKeywords] = useState(''), [location, setLocation] = useState('')
  useEffect(() => {
    let live = true
    getPending().then(r => { if (live) { setRows(r); setError(null) } }).catch(e => { if (live) setError(e) })
    return () => { live = false }
  }, [client, refreshKey])
  async function act(fn) {
    setBusy(true); setError(null); setNotice('')
    try {
      const result = await fn()
      if (result && typeof result === 'object') {
        setNotice(describeFlush(result))
        if (result.needsPairing) onNeedsPairing?.()
      }
      const next = await getPending(); setRows(next); onChanged(next.length); setEditing(null)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  // Resetting discards what could not be read, so it is never one tap.
  function confirmReset() {
    Alert.alert('Reset the request queue?',
      'The saved queue could not be read. Resetting starts an empty one; the unreadable copy is kept on this phone.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Reset', style: 'destructive', onPress: () => act(resetCorruptQueue) }])
  }
  const button = (title, fn, disabled = false) => <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy || disabled }} disabled={busy || disabled} onPress={() => act(fn)} style={{ padding: 10, opacity: busy || disabled ? 0.4 : 1 }}><Text style={{ color: colors.accent }}>{title}</Text></TouchableOpacity>
  if (!rows.length && !error && !notice) return null
  return <View style={{ padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 12, marginBottom: 16 }}>
    <Text style={{ color: colors.text, fontWeight: '700' }}>Waiting to send</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.red }}>{error.message}</Text> : null}
    {error?.corrupt ? <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={confirmReset} style={{ padding: 10 }}><Text style={{ color: colors.red }}>Reset queue</Text></TouchableOpacity> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={{ color: colors.yellow, marginTop: 8 }}>{notice}</Text> : null}
    {rows.map(row => {
      const isImport = kindOf(row) === 'import'
      return <View key={row.id} style={{ paddingTop: 12 }}>
        <Text style={{ color: colors.text }}>{isImport ? `Import: ${row.title || row.url}` : (row.keywords || 'Default search')}</Text>
        <Text style={{ color: colors.textMuted }}>{row.destination?.label || 'Unknown original destination — cancel and create a new request'}</Text>
        {row.location ? <Text style={{ color: colors.textMuted }}>{row.location}</Text> : null}
        {row.lastError ? <Text style={{ color: colors.textMuted }}>{row.lastError}</Text> : null}
        {editing === row.id ? <View>
          <TextInput accessibilityLabel="Queued search keywords" value={keywords} onChangeText={setKeywords} style={{ color: colors.text, padding: 8 }} />
          <TextInput accessibilityLabel="Queued search location" value={location} onChangeText={setLocation} style={{ color: colors.text, padding: 8 }} />
          {button('Save changes', () => editPending(row.id, { keywords, location }))}
        </View> : <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {!isImport && <TouchableOpacity disabled={busy} accessibilityRole="button" onPress={() => { setEditing(row.id); setKeywords(row.keywords || ''); setLocation(row.location || '') }} style={{ padding: 10 }}><Text style={{ color: colors.accent }}>Edit</Text></TouchableOpacity>}
          {button('Retry', () => flush(client, row.id), !row.destination?.key || row.destination.key !== client.queueDestination?.key)}
          {button('Cancel request', () => cancelPending(row.id))}
        </View>}
      </View>
    })}
  </View>
}
