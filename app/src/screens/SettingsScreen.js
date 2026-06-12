import { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { colors, radius } from '../theme'

export default function SettingsScreen({ client, connection, onDisconnect }) {
  const [pingResult, setPingResult] = useState(null)
  const [pinging, setPinging] = useState(false)
  const isCloud = connection.mode === 'cloud'

  async function testConnection() {
    setPinging(true)
    setPingResult(null)
    try {
      const res = await client.ping()
      setPingResult({ ok: true, host: res.host })
    } catch (err) {
      setPingResult({ ok: false, error: err.message })
    } finally {
      setPinging(false)
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Settings</Text>

      {isCloud ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cloud account</Text>
          <Row label="Signed in" value={connection.email || '—'} />
          <Row label="Sync" value="Applications sync from the desktop" />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connection</Text>
          <Row label="Server" value={`${connection.host}:${connection.port}`} />
          <Row label="Token" value={`${connection.token.slice(0, 8)}…`} />

          <TouchableOpacity style={styles.btnGhost} onPress={testConnection} disabled={pinging}>
            <Text style={styles.btnGhostText}>{pinging ? 'Testing…' : 'Test Connection'}</Text>
          </TouchableOpacity>
          {pingResult && (
            <Text style={{ color: pingResult.ok ? colors.green : colors.red, fontSize: 13, marginTop: 8 }}>
              {pingResult.ok ? `✓ Connected to ${pingResult.host}` : `✗ ${pingResult.error}`}
            </Text>
          )}
        </View>
      )}

      <TouchableOpacity style={styles.btnDanger} onPress={onDisconnect}>
        <Text style={styles.btnDangerText}>{isCloud ? 'Sign out' : 'Disconnect'}</Text>
      </TouchableOpacity>

      <Text style={styles.footer}>
        Hiro Mobile · companion to the Hiro desktop app{'\n'}
        {isCloud ? 'Synced privately to your Supabase project.' : 'All data stays on your computer.'}
      </Text>
    </View>
  )
}

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 16 },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, padding: 16, marginBottom: 16,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  rowLabel: { color: colors.textMuted, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 13, fontWeight: '500' },
  btnGhost: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius,
    paddingVertical: 9, alignItems: 'center', marginTop: 10,
  },
  btnGhostText: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
  btnDanger: {
    backgroundColor: colors.red, borderRadius: radius,
    paddingVertical: 12, alignItems: 'center',
  },
  btnDangerText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  footer: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 'auto', lineHeight: 18, paddingBottom: 8 },
})
