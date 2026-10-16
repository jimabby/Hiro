import { useState, useEffect, useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, Linking, ScrollView } from 'react-native'
import { radius, useTheme } from '../theme'
import { deleteAccount } from '../supabase'
import { enablePush, disablePush, getPushState } from '../push'
import { TIMEOUT_CHOICES, describeTimeout } from '../appLock'

const LEGAL_BASE = 'https://jimabby.github.io/card-assets/legal/hiro'
export const PRIVACY_POLICY_URL = `${LEGAL_BASE}/privacy-policy.html`
export const SUPPORT_URL = `${LEGAL_BASE}/support.html`

export default function SettingsScreen({ client, connection, onDisconnect, appLock }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [pingResult, setPingResult] = useState(null)
  const [pinging, setPinging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  // 'checking' until the OS and this phone's device row have both answered; the
  // toggle must not claim "off" while a token is actually registered.
  const [pushState, setPushState] = useState('checking')
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState('')
  const [lockBusy, setLockBusy] = useState(false)
  const [lockError, setLockError] = useState('')
  const isCloud = connection.mode === 'cloud'

  // The real state: a token registered on this phone's row AND the OS
  // permission. Either alone used to read as "Enabled".
  useEffect(() => {
    if (!isCloud) return
    let live = true
    getPushState(connection.userId).then(state => { if (live) setPushState(state) })
    return () => { live = false }
  }, [isCloud, connection.userId])

  async function toggleLock() {
    setLockBusy(true)
    setLockError('')
    const res = await appLock.setEnabled(!appLock.settings?.enabled)
    if (!res.ok && res.reason) setLockError(res.reason)
    setLockBusy(false)
  }

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

  // One tap on a big red button used to act immediately. For a LAN pairing that
  // throws away this phone's token, and getting back means a new code from the
  // desktop — too much to lose to a stray thumb.
  function confirmDisconnect() {
    Alert.alert(
      isCloud ? 'Sign out?' : 'Disconnect from the desktop?',
      isCloud
        ? 'You will need your email and password to sign in again.'
        : 'This phone forgets its pairing. To reconnect you will need a new pairing code from the desktop.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: isCloud ? 'Sign out' : 'Disconnect', style: 'destructive', onPress: onDisconnect },
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
    // Scrollable: in cloud mode the account, notifications, sign-out and
    // deletion blocks are taller than a small phone, and a plain View clipped
    // the legal links and the footer with no way to reach them.
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title} accessibilityRole="header">Settings</Text>

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

          <TouchableOpacity style={styles.btnGhost} onPress={testConnection} disabled={pinging}
            accessibilityRole="button" accessibilityLabel="Test the connection to the desktop"
            accessibilityState={{ disabled: pinging, busy: pinging }}>
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
                : pushState === 'blocked' ? 'Blocked in phone settings'
                  : pushState === 'unknown' ? 'Unknown — offline?'
                    : 'Checking…'
          } />
          {pushState === 'blocked' && (
            <Text style={styles.hint}>
              The desktop is sending to this phone, but notifications for Hiro are turned off in
              your phone’s settings, so none are shown.
            </Text>
          )}

          <TouchableOpacity style={styles.btnGhost} disabled={pushBusy}
            accessibilityRole="switch"
            accessibilityLabel="Notifications on this phone"
            accessibilityState={{ checked: pushState === 'on', disabled: pushBusy, busy: pushBusy }}
            onPress={async () => {
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

      {!!appLock && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>App Lock</Text>
          <Text style={styles.hint}>
            Ask for Face ID, a fingerprint or your phone’s passcode when Hiro opens, so someone
            holding your unlocked phone cannot read your applications.
          </Text>
          <Row label="Lock" value={appLock.settings?.enabled ? 'On' : 'Off'} />
          <TouchableOpacity style={styles.btnGhost} disabled={lockBusy || !appLock.settings}
            onPress={toggleLock}
            accessibilityRole="switch" accessibilityLabel="App Lock"
            accessibilityState={{ checked: !!appLock.settings?.enabled, disabled: lockBusy, busy: lockBusy }}>
            <Text style={styles.btnGhostText}>
              {lockBusy ? 'Working…' : (appLock.settings?.enabled ? 'Turn off App Lock' : 'Turn on App Lock')}
            </Text>
          </TouchableOpacity>
          {!!lockError && <Text style={{ color: colors.red, fontSize: 12, marginTop: 8 }}>{lockError}</Text>}
          {appLock.settings?.enabled && (
            <>
              <Text style={[styles.hint, { marginTop: 12, marginBottom: 6 }]}>Lock again after Hiro has been in the background:</Text>
              <View style={styles.chips}>
                {TIMEOUT_CHOICES.map(m => {
                  const selected = appLock.settings.timeoutMinutes === m
                  return (
                    <TouchableOpacity key={m} onPress={() => appLock.setTimeoutMinutes(m)}
                      style={[styles.chip, selected && styles.chipActive]}
                      accessibilityRole="radio" accessibilityState={{ selected }}
                      accessibilityLabel={`Lock ${describeTimeout(m).toLowerCase()}`}>
                      <Text style={[styles.chipText, selected && styles.chipTextActive]}>{describeTimeout(m)}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </>
          )}
        </View>
      )}

      <TouchableOpacity style={styles.btnDanger} onPress={confirmDisconnect}
        accessibilityRole="button" accessibilityLabel="Disconnect this phone from Hiro">
        <Text style={styles.btnDangerText}>{isCloud ? 'Sign out' : 'Disconnect'}</Text>
      </TouchableOpacity>

      {isCloud && (
        <>
          <TouchableOpacity style={styles.btnDeleteAccount} onPress={confirmDeleteAccount} disabled={deleting}
            accessibilityRole="button" accessibilityLabel="Permanently delete your Hiro cloud account"
            accessibilityHint="This cannot be undone"
            accessibilityState={{ disabled: deleting, busy: deleting }}>
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
        <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
          accessibilityRole="link" accessibilityLabel="Privacy policy"
          accessibilityHint="Opens in your browser">
          <Text style={styles.legalLinkText}>Privacy Policy</Text>
        </TouchableOpacity>
        <Text style={styles.legalDivider}>·</Text>
        <TouchableOpacity onPress={() => Linking.openURL(SUPPORT_URL)}
          accessibilityRole="link" accessibilityLabel="Support"
          accessibilityHint="Opens in your browser">
          <Text style={styles.legalLinkText}>Support</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        Hiro Mobile · companion to the Hiro desktop app{'\n'}
        {isCloud ? 'Synced privately to your Supabase project.' : 'All data stays on your computer.'}
      </Text>
    </ScrollView>
  )
}

function Row({ label, value }) {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  // flexGrow so the legal links' marginTop: 'auto' still pins them to the
  // bottom when everything fits.
  content: { flexGrow: 1, padding: 16 },
  title: { fontSize: 22, fontWeight: '700', color: c.text, marginBottom: 16 },
  card: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: radius, padding: 16, marginBottom: 16,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, gap: 12 },
  rowLabel: { color: c.textMuted, fontSize: 13 },
  // flexShrink so a long email address wraps inside the card instead of
  // pushing past its edge.
  rowValue: { color: c.text, fontSize: 13, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  hint: { color: c.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  btnGhost: {
    borderWidth: 1, borderColor: c.border, borderRadius: radius,
    paddingVertical: 10, minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 10,
  },
  btnGhostText: { color: c.textMuted, fontSize: 13, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1, borderColor: c.border, borderRadius: radius,
    paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center',
  },
  chipActive: { borderColor: c.accent },
  chipText: { color: c.textMuted, fontSize: 12 },
  chipTextActive: { color: c.accent, fontWeight: '600' },
  btnDanger: {
    backgroundColor: c.red, borderRadius: radius,
    paddingVertical: 12, minHeight: 46, justifyContent: 'center', alignItems: 'center',
  },
  btnDangerText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btnDeleteAccount: {
    borderWidth: 1, borderColor: c.red, borderRadius: radius,
    paddingVertical: 11, minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 12,
  },
  btnDeleteAccountText: { color: c.red, fontSize: 13, fontWeight: '600' },
  deleteError: { color: c.red, fontSize: 12, marginTop: 8, textAlign: 'center' },
  deleteHint: { color: c.textMuted, fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 16 },
  legalLinks: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 10, marginTop: 'auto', paddingTop: 24, paddingBottom: 8,
  },
  legalLinkText: { color: c.accent, fontSize: 13, fontWeight: '500' },
  legalDivider: { color: c.textMuted, fontSize: 13 },
  footer: { color: c.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18, paddingBottom: 8 },
})
