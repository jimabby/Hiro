import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, AppState, BackHandler } from 'react-native'
// React Native's own SafeAreaView is iOS-only and deprecated as of 0.80, and
// SDK 54 draws Android edge-to-edge by default — so the old hardcoded 32px
// Android padding would sit the header under some status bars and the tab bar
// under the gesture nav. This one measures the real insets on both platforms.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
// The stored connection carries the LAN bearer token, so it goes to the
// Keychain/Keystore rather than an unencrypted AsyncStorage file.
import secureStore from './src/secureStore'
import { HiroClient } from './src/api'
import { supabase, CloudClient } from './src/supabase'
import { useTheme, useStatusBarStyle } from './src/theme'
import { registerDevice, checkRevoked, clearPushToken } from './src/deviceRegistry'
import { subscribeToTaps, syncPushToken, subscribeToTokenRotation } from './src/push'
import { loadCloudKey, clearCloudKey } from './src/cloudCrypto'
import { clearCaches } from './src/offlineCache'
import { useAppLock } from './src/useAppLock'
import { useIncomingImports } from './src/useIncomingImports'
import { importJobLink } from './src/importJob'
import LockScreen from './src/screens/LockScreen'
import ConnectScreen from './src/screens/ConnectScreen'
import DashboardScreen from './src/screens/DashboardScreen'
import ApplicationsScreen from './src/screens/ApplicationsScreen'
import OffersScreen from './src/screens/OffersScreen'
import SettingsScreen from './src/screens/SettingsScreen'
import { useBadges } from './src/useBadges'
import { badgeText } from './src/listing'

const STORAGE_KEY = 'hiro.connection'

// The icons are plain Unicode glyphs, and two of them (★ and ⚙) have emoji
// forms: without U+FE0E iOS draws ⚙ as a colour emoji that ignores the tint,
// so the selected tab could not be told apart by colour at all.
const TEXT_STYLE = '\uFE0E'

// What each tab's badge counts, for the spoken label — a bare number read after
// "Offers" says nothing about what it is a number of.
const BADGE_MEANING = {
  dashboard: (n) => `${n} follow-up${n === 1 ? '' : 's'} due`,
  applications: (n) => `${n} draft${n === 1 ? '' : 's'} waiting for review`,
  offers: (n) => `${n} offer${n === 1 ? '' : 's'} due within three days`,
}

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'applications', label: 'Applications', icon: '☰' },
  // Sits before Settings because it is the tab with a deadline on it — the same
  // reasoning that puts Offers third in the desktop's rail. Always present
  // rather than hidden when there are none: both clients resolve a missing
  // table or an older desktop to an empty board, and the empty state says what
  // would fill it, which a tab that appears and disappears never could.
  { id: 'offers', label: 'Offers', icon: `★${TEXT_STYLE}` },
  { id: 'settings', label: 'Settings', icon: `⚙${TEXT_STYLE}` },
]

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  )
}

function AppContent() {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  // The status bar draws OVER the app, so it needs the inverse: dark glyphs on
  // a light ground. Hardcoding "light" left black-on-black in light mode.
  const statusBarStyle = useStatusBarStyle()

  const [connection, setConnection] = useState(undefined) // undefined = loading
  const [tab, setTab] = useState('dashboard')
  // Set when a notification tap names a specific application to open.
  const [deepLinkedApplication, setDeepLinkedApplication] = useState(null)
  // Bumped when the Applications tab is tapped while already selected, which
  // on both platforms means "take me back to the top of this tab".
  const [applicationsReset, setApplicationsReset] = useState(0)
  // Tabs are mounted the first time they are opened and then kept, hidden, so
  // switching away and back keeps the search, filter, sort, scroll position and
  // any open application — they used to be rebuilt from scratch on every tap.
  const [visited, setVisited] = useState(() => new Set(['dashboard']))
  useEffect(() => {
    setVisited(v => (v.has(tab) ? v : new Set(v).add(tab)))
  }, [tab])

  const openApplication = useCallback((id) => {
    setTab('applications')
    setDeepLinkedApplication(id)
  }, [])

  const selectTab = useCallback((id) => {
    if (id === tab && id === 'applications') setApplicationsReset(n => n + 1)
    setTab(id)
  }, [tab])

  // Android's back button. Without a handler it finishes the activity from any
  // screen, so backing out of an application quit the app. Back returns to the
  // Dashboard, and only exits from there.
  //
  // Registered once and read through a ref: React Native runs the NEWEST handler
  // first, so this one has to stay the oldest for an open application (which
  // registers its own, to check for an unsaved note) to get the press before it.
  const tabRef = useRef(tab)
  tabRef.current = tab
  const signedIn = !!connection
  useEffect(() => {
    if (!signedIn) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tabRef.current !== 'dashboard') {
        setTab('dashboard')
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [signedIn])

  useEffect(() => {
    (async () => {
      await loadCloudKey()
      // A live Supabase session (cloud mode) takes priority and works anywhere.
      if (supabase) {
        const { data } = await supabase.auth.getSession()
        if (data?.session?.user) {
          setConnection({ mode: 'cloud', userId: data.session.user.id, email: data.session.user.email })
          return
        }
      }
      try {
        const raw = await secureStore.getItem(STORAGE_KEY)
        setConnection(raw ? JSON.parse(raw) : null)
      } catch {
        setConnection(null)
      }
    })()
  }, [])

  const client = useMemo(() => {
    if (!connection) return null
    if (connection.mode === 'cloud') return new CloudClient(connection.userId)
    // Two things the client learns while running are saved back to the stored
    // connection without a re-render — the client already knows them, and
    // rebuilding it would reset every screen holding it:
    //   - the first reply bound to its request proves this desktop can bind
    //     them; from then on an unbound reply is refused (src/responseBinding.js)
    //   - a rotated device token and its new expiry (POST /api/rotate)
    // Both merge into one running copy, so neither save overwrites the other.
    const saved = { ...connection }
    const persist = () => secureStore.setItem(STORAGE_KEY, JSON.stringify(saved)).catch(() => {})
    const onTokenRotated = ({ token, expiresAt, device } = {}) => {
      if (!token) return
      saved.token = token
      saved.expiresAt = expiresAt ?? device?.expiresAt ?? saved.expiresAt ?? null
      if (Array.isArray(device?.scopes)) saved.scopes = device.scopes
      persist()
    }
    const onResponseBinding = () => {
      saved.responseBinding = true
      persist()
    }
    return new HiroClient(
      { ...connection, expiresAt: connection.expiresAt ?? null, onTokenRotated },
      { onResponseBinding, onTokenRotated },
    )
  }, [connection])

  // A paired phone's token expires (90 days by default). Rotate it ahead of
  // that on launch and on each return to the foreground — the client only acts
  // inside the last 14 days, and saves the new token through onTokenRotated.
  useEffect(() => {
    if (!client?.rotateIfExpiringSoon) return
    const run = () => { Promise.resolve().then(() => client.rotateIfExpiringSoon()).catch(() => {}) }
    run()
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') run() })
    return () => sub.remove()
  }, [client])

  const handleConnected = useCallback(async (conn) => {
    // Cloud sessions persist via Supabase; only LAN connections need storing.
    if (conn.mode === 'cloud') {
      await secureStore.removeItem(STORAGE_KEY)
    } else {
      await secureStore.setItem(STORAGE_KEY, JSON.stringify(conn))
    }
    setConnection(conn)
    setTab('dashboard')
    setVisited(new Set(['dashboard']))
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (connection?.mode === 'cloud' && supabase) {
      // Drop the push token before the session goes: afterwards this client has
      // no authority to write to its own device row, and a stale token means
      // notifications keep arriving on a phone that has signed out.
      await clearPushToken(connection.userId)
      // 'local': only this phone's session. The default ('global') revokes
      // every refresh token on the account — it signed the DESKTOP out too.
      await supabase.auth.signOut({ scope: 'local' })
      await clearCloudKey()
    }
    await secureStore.removeItem(STORAGE_KEY)
    await clearCaches()
    setConnection(null)
  }, [connection])

  // The desktop (or the cloud) no longer accepts this phone. Asked once per
  // connection: every screen that notices would otherwise stack its own alert.
  const pairingPrompted = useRef(false)
  useEffect(() => { pairingPrompted.current = false }, [connection])
  const handleNeedsPairing = useCallback(() => {
    if (pairingPrompted.current) return
    pairingPrompted.current = true
    const cloud = connection?.mode === 'cloud'
    Alert.alert(
      cloud ? 'Sign in again' : 'Re-pair this phone',
      cloud
        ? 'Your session is no longer accepted. Sign in again to carry on.'
        : 'The desktop no longer accepts this phone — it was revoked or its pairing expired. Pair it again with a new code from the desktop. Requests waiting to send stay listed so you can cancel them.',
      [
        { text: 'Later', style: 'cancel' },
        { text: cloud ? 'Sign in' : 'Re-pair', onPress: () => { handleDisconnect() } },
      ]
    )
  }, [connection, handleDisconnect])

  // ── This phone's standing on the account ─────────────────────────
  // Only the desktop used to register itself, so a phone holding a refresh token
  // with full access to every application was invisible in the desktop's device
  // list and there was nothing to revoke. Register on sign-in, and re-check on
  // every foreground: revocation is cooperative (Supabase gives a client no way
  // to invalidate another client's token), so honouring it promptly is this
  // side's whole responsibility.
  const userId = connection?.mode === 'cloud' ? connection.userId : null

  const verifyStanding = useCallback(async () => {
    if (!userId) return
    if (await checkRevoked(userId)) {
      await clearCloudKey()
      await clearCaches()
      setConnection(null)
      Alert.alert(
        'Signed out',
        'This phone was signed out of your Hiro account from another device. Sign in again to resume.'
      )
      return
    }
    await registerDevice(userId)
    // Re-register the push token if one is on file: it may have rotated since
    // the last launch, and nothing else would notice.
    await syncPushToken(userId)
  }, [userId])

  useEffect(() => { verifyStanding() }, [verifyStanding])

  useEffect(() => {
    if (!userId) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') verifyStanding()
    })
    return () => sub.remove()
  }, [userId, verifyStanding])

  useEffect(() => subscribeToTokenRotation(userId), [userId])

  // Tapping a notification should land on what it was about, not just open the
  // app on whatever tab was last used.
  useEffect(() => {
    if (!userId) return
    return subscribeToTaps((route) => {
      if (route.tab) setTab(route.tab)
      if (route.applicationId != null) setDeepLinkedApplication(route.applicationId)
    })
  }, [userId])

  const [badges, refreshBadges] = useBadges(client, tab)

  const appLock = useAppLock()

  // ── Job links shared into Hiro ──────────────────────────────────
  // Held until there is a connection and the app is unlocked: a link can be
  // what launched the app, before either is known.
  const [incomingJob, setIncomingJob] = useState(null)
  const [queueSignal, setQueueSignal] = useState(0)
  useIncomingImports(useCallback((job) => {
    if (!job) {
      Alert.alert('No job link', 'What was shared has no web link in it, so there is nothing to import.')
      return
    }
    setIncomingJob(job)
  }, []))
  useEffect(() => {
    if (!incomingJob || connection === undefined || appLock.locked || appLock.settings === undefined) return
    const job = incomingJob
    setIncomingJob(null)
    if (!client) {
      Alert.alert('Connect first', 'Pair this phone with the Hiro desktop, then share the job again.')
      return
    }
    Alert.alert('Import this job?', `${job.title ? `${job.title}\n` : ''}${job.url}\n\nIt goes to Needs Attention on the desktop.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Import',
        onPress: async () => {
          const res = await importJobLink(client, job)
          if (res.status === 'auth') { handleNeedsPairing(); return }
          if (res.status === 'queued') setQueueSignal(n => n + 1)
          Alert.alert(res.status === 'imported' ? 'Imported' : res.status === 'queued' ? 'Saved for later' : 'Not imported', res.message)
        },
      },
    ])
  }, [incomingJob, connection, client, appLock.locked, appLock.settings, handleNeedsPairing])

  // Nothing is drawn until the lock setting has loaded: the content must not
  // flash before the lock covers it.
  if (connection === undefined || appLock.settings === undefined) {
    return <View style={styles.root} />
  }

  // Drawn OVER the app rather than instead of it, so unlocking returns to the
  // same tab, scroll position and open application. The content underneath is
  // hidden from screen readers while it is covered.
  const lockOverlay = appLock.locked && (
    <View style={StyleSheet.absoluteFill}>
      <LockScreen onUnlock={appLock.unlock} />
    </View>
  )
  const coveredProps = appLock.locked
    ? { importantForAccessibility: 'no-hide-descendants', accessibilityElementsHidden: true }
    : {}

  if (!connection) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style={statusBarStyle} />
        <View style={styles.content} {...coveredProps}>
          <ConnectScreen onConnected={handleConnected} />
        </View>
        {lockOverlay}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style={statusBarStyle} />
      <View style={styles.content} {...coveredProps}>
        <View style={styles.content}>
          {visited.has('dashboard') && (
            <View style={[styles.content, tab !== 'dashboard' && styles.hidden]}>
              <DashboardScreen client={client} active={tab === 'dashboard'} onOpenApplication={openApplication}
                onNeedsPairing={handleNeedsPairing} queueSignal={queueSignal} />
            </View>
          )}
          {(visited.has('applications') || deepLinkedApplication != null) && (
            <View style={[styles.content, tab !== 'applications' && styles.hidden]}>
              <ApplicationsScreen
                client={client}
                active={tab === 'applications'}
                openApplicationId={deepLinkedApplication}
                onOpened={() => setDeepLinkedApplication(null)}
                resetSignal={applicationsReset}
                onChanged={refreshBadges}
              />
            </View>
          )}
          {visited.has('offers') && (
            <View style={[styles.content, tab !== 'offers' && styles.hidden]}>
              <OffersScreen client={client} active={tab === 'offers'} />
            </View>
          )}
          {visited.has('settings') && (
            <View style={[styles.content, tab !== 'settings' && styles.hidden]}>
              <SettingsScreen client={client} connection={connection} onDisconnect={handleDisconnect} appLock={appLock} />
            </View>
          )}
        </View>
        {/* The app's only global navigation, so it is the one control that has to
            be reachable by every means. The icons are decorative glyphs — without
            importantForAccessibility="no" a screen reader announces the character
            name ("black square", "trigram for heaven") ahead of the real label. */}
        <View style={styles.tabBar} accessibilityRole="tablist">
          {TABS.map(t => {
            const count = badges[t.id] || 0
            return (
            <TouchableOpacity
              key={t.id}
              style={styles.tabItem}
              onPress={() => selectTab(t.id)}
              accessibilityRole="tab"
              accessibilityLabel={count ? `${t.label}, ${BADGE_MEANING[t.id](count)}` : t.label}
              accessibilityState={{ selected: tab === t.id }}
            >
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={[styles.tabIcon, tab === t.id && styles.tabActive]}>{t.icon}</Text>
                {/* Offers is urgent rather than countable, so it gets red; the
                    other two are work waiting, in the accent. */}
                {count > 0 && (
                  <View style={[styles.badge, t.id === 'offers' && styles.badgeUrgent]}>
                    <Text style={styles.badgeText}>{badgeText(count)}</Text>
                  </View>
                )}
              </View>
              <Text
                style={[styles.tabLabel, tab === t.id && styles.tabActive]}
                importantForAccessibility="no"
                accessibilityElementsHidden
              >{t.label}</Text>
              {/* Colour is the only visual cue for the selected tab. That fails
                  anyone who cannot distinguish it, so the active tab also carries
                  a rule under it. */}
              {tab === t.id && <View style={styles.tabUnderline} />}
            </TouchableOpacity>
            )
          })}
        </View>
      </View>
      {lockOverlay}
    </SafeAreaView>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: c.bg,
  },
  content: { flex: 1 },
  hidden: { display: 'none' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surface,
  },
  // 44pt is the smallest reliably tappable target on both platforms; the icon
  // and label together came to roughly 51, but the padding is stated rather
  // than inherited from the type so a font-size change cannot shrink it.
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, minHeight: 48 },
  tabIcon: { fontSize: 18, color: c.textMuted },
  tabLabel: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  tabActive: { color: c.accent },
  badge: {
    position: 'absolute', top: -4, left: 12, minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.accent, borderWidth: 2, borderColor: c.surface,
  },
  badgeUrgent: { backgroundColor: c.red },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700', lineHeight: 12 },
  tabUnderline: {
    position: 'absolute', bottom: 0, height: 2, width: 28,
    borderRadius: 1, backgroundColor: c.accent,
  },
})
