import { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, Linking } from 'react-native'
import { colors, radius } from '../theme'
import { deleteAccount } from '../supabase'
import { enablePush, disablePush, getPermissionStatus } from '../push'

const LEGAL_BASE = 'https://jimabby.github.io/card-assets/legal/hiro'
export const PRIVACY_POLICY_URL = `${LEGAL_BASE}/privacy-policy.html`
export const SUPPORT_URL = `${LEGAL_BASE}/support.html`

export default function SettingsScreen({ client, connection, onDisconnect }) {
  const [pingResult, setPingResult] = useState(null)
  const [pinging, setPinging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  // 'unknown' until the OS has been asked; the toggle must not claim "off" while
  // permission is actually granted.
  const [pushState, setPushState] = useState('unknown')
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState('')
  const isCloud = connection.mode === 'cloud'

  useEffect(() => {
    if (!isCloud) return
    getPermissionStatus().then(status => setPushState(status === 'granted' ? 'on' : 'off'))
  }, [isCloud])

  // In-app account deletion — required by App Store guideline 5.1.1(v) for any
  // app with account sign-in. Deletes the cloud account and every synced row;
  // the desktop's local database is untouched.
  function confirmDeleteAccount() {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your cloud account and all applications synced to it. ' +
      'Data stored locally on your desktop is not affected.\n\nThis cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: doDeleteAccount },
      ]
    )
  }

  async function doDeleteAccount() {
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteAccount()
      onDisconnect()
    } catch (err) {
      setDeleteError(err.message)
    } finally {
      setDeleting(false)
    }
  }

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

      {/* Notifications are cloud-only: the desktop addresses them to the push
          token on this phone's row in the shared `devices` table, and a LAN-only
          connection has no such row. Saying that is better than showing a toggle
          that quietly does nothing. */}
      {isCloud && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Notifications</Text>
          <Text style={styles.hint}>
            Recruiter replies, interview reminders, follow-ups that come due, and scans that
            failed — sent by your desktop while you are away from it. Choose which kinds in
            Hiro on the desktop, under Settings → Notifications.
          </Text>

          <Row label="On this phone" value={
            pushState === 'on' ? 'Enabled'
              : pushState === 'off' ? 'Off'
                : 'Checking…'
          } />

          <TouchableOpacity style={styles.btnGhost} disabled={pushBusy} onPress={async () => {
            setPushBusy(true)
            setPushError('')
            if (pushState === 'on') {
              await disablePush(connection.userId)
              setPushState('off')
            } else {
              const res = await enablePush(connection.userId)
              if (res.success) setPushState('on')
              else setPushError(res.reason || 'Could not enable notifications.')
            }
            setPushBusy(false)
          }}>
            <Text style={styles.btnGhostText}>
              {pushBusy ? 'Working…' : (pushState === 'on' ? 'Turn off notifications' : 'Turn on notifications')}
            </Text>
          </TouchableOpacity>
          {!!pushError && <Text style={{ color: colors.red, fontSize: 12, marginTop: 8 }}>{pushError}</Text>}
        </View>
      )}

      <TouchableOpacity style={styles.btnDanger} onPress={onDisconnect}>
        <Text style={styles.btnDangerText}>{isCloud ? 'Sign out' : 'Disconnect'}</Text>
      </TouchableOpacity>

      {isCloud && (
        <>
          <TouchableOpacity style={styles.btnDeleteAccount} onPress={confirmDeleteAccount} disabled={deleting}>
            <Text style={styles.btnDeleteAccountText}>{deleting ? 'Deleting…' : 'Delete account'}</Text>
          </TouchableOpacity>
          {!!deleteError && <Text style={styles.deleteError}>{deleteError}</Text>}
          <Text style={styles.deleteHint}>
            Permanently deletes your cloud account and all synced applications.
            Data on your desktop is not affected.
          </Text>
        </>
      )}

      <View style={styles.legalLinks}>
        <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
          <Text style={styles.legalLinkText}>Privacy Policy</Text>
        </TouchableOpacity>
        <Text style={styles.legalDivider}>·</Text>
        <TouchableOpacity onPress={() => Linking.openURL(SUPPORT_URL)}>
          <Text style={styles.legalLinkText}>Support</Text>
        </TouchableOpacity>
      </View>

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
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 10 },
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
  btnDeleteAccount: {
    borderWidth: 1, borderColor: colors.red, borderRadius: radius,
    paddingVertical: 11, alignItems: 'center', marginTop: 12,
  },
  btnDeleteAccountText: { color: colors.red, fontSize: 13, fontWeight: '600' },
  deleteError: { color: colors.red, fontSize: 12, marginTop: 8, textAlign: 'center' },
  deleteHint: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 16 },
  legalLinks: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 10, marginTop: 'auto', paddingVertical: 8,
  },
  legalLinkText: { color: colors.accent, fontSize: 13, fontWeight: '500' },
  legalDivider: { color: colors.textMuted, fontSize: 13 },
  footer: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18, paddingBottom: 8 },
})
