import { useState, useEffect, useMemo, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Platform } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { HiroClient } from './src/api'
import { supabase, CloudClient } from './src/supabase'
import { colors } from './src/theme'
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
  const [connection, setConnection] = useState(undefined) // undefined = loading
  const [tab, setTab] = useState('dashboard')

  useEffect(() => {
    (async () => {
      // A live Supabase session (cloud mode) takes priority and works anywhere.
      if (supabase) {
        const { data } = await supabase.auth.getSession()
        if (data?.session?.user) {
          setConnection({ mode: 'cloud', userId: data.session.user.id, email: data.session.user.email })
          return
        }
      }
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY)
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
      await AsyncStorage.removeItem(STORAGE_KEY)
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(conn))
    }
    setConnection(conn)
    setTab('dashboard')
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (connection?.mode === 'cloud' && supabase) {
      await supabase.auth.signOut()
    }
    await AsyncStorage.removeItem(STORAGE_KEY)
    setConnection(null)
  }, [connection])

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
        {tab === 'applications' && <ApplicationsScreen client={client} />}
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
    paddingTop: Platform.OS === 'android' ? 32 : 0,
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
