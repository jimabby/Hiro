import { useState, useEffect, useMemo, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, AppState } from 'react-native'
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
import { colors } from './src/theme'
import { registerDevice, checkRevoked, clearPushToken } from './src/deviceRegistry'
import { subscribeToTaps } from './src/push'
import { loadCloudKey, clearCloudKey } from './src/cloudCrypto'
import ConnectScreen from './src/screens/ConnectScreen'
import DashboardScreen from './src/screens/DashboardScreen'
import ApplicationsScreen from './src/screens/ApplicationsScreen'
import SettingsScreen from './src/screens/SettingsScreen'

const STORAGE_KEY = 'hiro.connection'

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'applications', label: 'Applications', icon: '☰' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
]

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  )
}

function AppContent() {
  const [connection, setConnection] = useState(undefined) // undefined = loading
  const [tab, setTab] = useState('dashboard')
  // Set when a notification tap names a specific application to open.
  const [deepLinkedApplication, setDeepLinkedApplication] = useState(null)

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
    return new HiroClient(connection)
  }, [connection])

  const handleConnected = useCallback(async (conn) => {
    // Cloud sessions persist via Supabase; only LAN connections need storing.
    if (conn.mode === 'cloud') {
      await secureStore.removeItem(STORAGE_KEY)
    } else {
      await secureStore.setItem(STORAGE_KEY, JSON.stringify(conn))
    }
    setConnection(conn)
    setTab('dashboard')
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (connection?.mode === 'cloud' && supabase) {
      // Drop the push token before the session goes: afterwards this client has
      // no authority to write to its own device row, and a stale token means
      // notifications keep arriving on a phone that has signed out.
      await clearPushToken(connection.userId)
      await supabase.auth.signOut()
      await clearCloudKey()
    }
    await secureStore.removeItem(STORAGE_KEY)
    setConnection(null)
  }, [connection])

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
      setConnection(null)
      Alert.alert(
        'Signed out',
        'This phone was signed out of your Hiro account from another device. Sign in again to resume.'
      )
      return
    }
    await registerDevice(userId)
  }, [userId])

  useEffect(() => { verifyStanding() }, [verifyStanding])

  useEffect(() => {
    if (!userId) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') verifyStanding()
    })
    return () => sub.remove()
  }, [userId, verifyStanding])

  // Tapping a notification should land on what it was about, not just open the
  // app on whatever tab was last used.
  useEffect(() => {
    if (!userId) return
    return subscribeToTaps((route) => {
      if (route.tab) setTab(route.tab)
      if (route.applicationId != null) setDeepLinkedApplication(route.applicationId)
    })
  }, [userId])

  if (connection === undefined) {
    return <View style={styles.root} />
  }

  if (!connection) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />
        <ConnectScreen onConnected={handleConnected} />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.content}>
        {tab === 'dashboard' && <DashboardScreen client={client} />}
        {tab === 'applications' && (
          <ApplicationsScreen
            client={client}
            openApplicationId={deepLinkedApplication}
            onOpened={() => setDeepLinkedApplication(null)}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen client={client} connection={connection} onDisconnect={handleDisconnect} />
        )}
      </View>
      <View style={styles.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity key={t.id} style={styles.tabItem} onPress={() => setTab(t.id)}>
            <Text style={[styles.tabIcon, tab === t.id && styles.tabActive]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.id && styles.tabActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabIcon: { fontSize: 18, color: colors.textMuted },
  tabLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  tabActive: { color: colors.accent },
})
