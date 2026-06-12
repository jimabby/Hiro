import { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native'
import { HiroClient } from '../api'
import { supabase, isConfigured } from '../supabase'
import { colors, radius } from '../theme'

export default function ConnectScreen({ onConnected }) {
  const [mode, setMode] = useState(isConfigured ? 'cloud' : 'lan')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('4823')
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function connect() {
    const conn = { host: host.trim(), port: Number(port) || 4823, token: token.trim() }
    if (!conn.host || !conn.token) {
      setError('Server address and pairing token are required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const client = new HiroClient(conn)
      const res = await client.ping()
      if (!res.ok) throw new Error('Unexpected response from server')
      await onConnected({ mode: 'lan', ...conn })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function signInCloud() {
    if (!email.trim() || !password) {
      setError('Email and password are required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (err) throw new Error(err.message)
      await onConnected({ mode: 'cloud', userId: data.user.id, email: data.user.email })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const renderCloud = () => (
    <>
      <Text style={styles.subtitle}>
        Sign in to your Hiro cloud account. Your applications sync from the desktop,
        so you can see them anywhere — no Wi-Fi pairing needed.
      </Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="password"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      {!!error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={[styles.button, busy && styles.buttonDisabled]} onPress={signInCloud} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>Use the same account you signed into on the desktop.</Text>
    </>
  )

  const renderLan = () => (
    <>
      <Text style={styles.subtitle}>
        Pair with the Hiro desktop app.{'\n'}
        Enable the mobile server in Settings → Notifications → Mobile App on your computer,
        then enter the address and token shown there.
      </Text>

      <Text style={styles.label}>Server address (IP)</Text>
        <TextInput
          style={styles.input}
          value={host}
          onChangeText={setHost}
          placeholder="192.168.1.10"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
        />

        <Text style={styles.label}>Port</Text>
        <TextInput
          style={styles.input}
          value={port}
          onChangeText={setPort}
          placeholder="4823"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
        />

        <Text style={styles.label}>Pairing token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="paste token from desktop"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity style={[styles.button, busy && styles.buttonDisabled]} onPress={connect} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? 'Connecting…' : 'Connect'}</Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          Your phone and computer must be on the same Wi-Fi network.
        </Text>
    </>
  )

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>Hiro</Text>

        {isConfigured && (
          <View style={styles.toggle}>
            <TouchableOpacity
              style={[styles.toggleBtn, mode === 'cloud' && styles.toggleActive]}
              onPress={() => { setMode('cloud'); setError('') }}
            >
              <Text style={[styles.toggleText, mode === 'cloud' && styles.toggleTextActive]}>Cloud account</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleBtn, mode === 'lan' && styles.toggleActive]}
              onPress={() => { setMode('lan'); setError('') }}
            >
              <Text style={[styles.toggleText, mode === 'lan' && styles.toggleTextActive]}>Desktop (Wi-Fi)</Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'cloud' ? renderCloud() : renderLan()}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 28 },
  logo: { fontSize: 34, fontWeight: '700', color: colors.accent, textAlign: 'center', marginBottom: 16 },
  toggle: {
    flexDirection: 'row', backgroundColor: colors.surface2, borderRadius: radius,
    padding: 4, marginBottom: 22,
  },
  toggleBtn: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: radius - 2 },
  toggleActive: { backgroundColor: colors.accent },
  toggleText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  toggleTextActive: { color: '#fff' },
  subtitle: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginBottom: 28, lineHeight: 19 },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: '500', marginBottom: 4 },
  input: {
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius, paddingHorizontal: 12, paddingVertical: 10,
    color: colors.text, fontSize: 14, marginBottom: 16,
  },
  error: { color: colors.red, fontSize: 13, marginBottom: 12 },
  button: {
    backgroundColor: colors.accent, borderRadius: radius,
    paddingVertical: 13, alignItems: 'center', marginTop: 4,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 18 },
})
