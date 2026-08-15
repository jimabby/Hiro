import { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native'
import { HiroClient, pairWithDesktop } from '../api'
import QrPairScanner from './QrPairScanner'
import { supabase, isConfigured } from '../supabase'
import { colors, radius } from '../theme'
import { deriveAccountKeys, setCloudKey } from '../cloudCrypto'

export default function ConnectScreen({ onConnected }) {
  const [mode, setMode] = useState(isConfigured ? 'cloud' : 'lan')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('4823')
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Pairing: a one-time code exchanged for a token belonging to this phone.
  const [pairCode, setPairCode] = useState('')
  const [scanning, setScanning] = useState(false)

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

  // Redeem a pairing code. The desktop returns a token minted for this device,
  // which is what gets stored — the shared token path below stays only for
  // desktops that have not been updated yet.
  async function pair(fromQr) {
    const conn = {
      host: (fromQr?.host || host).trim(),
      port: Number(fromQr?.port || port) || 4823,
      code: (fromQr?.code || pairCode).trim(),
    }
    if (!conn.host || !conn.code) {
      setError('Server address and pairing code are required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await pairWithDesktop({
        ...conn,
        // A human-recognisable default; the desktop truncates and the user
        // can tell two phones apart by platform and pairing date.
        deviceName: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
        platform: Platform.OS,
      })
      const client = new HiroClient({ host: conn.host, port: conn.port, token: res.token, secure: true })
      const ping = await client.ping()
      if (!ping.ok) throw new Error('Unexpected response from server')
      await onConnected({ mode: 'lan', host: conn.host, port: conn.port, token: res.token, secure: true })
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
      const address = email.trim()
      // The password is never sent as-is: Supabase gets a derived secret, and
      // the key that decrypts the documents is derived separately and stays on
      // this phone. See cloudCrypto for why the two must not be the same value.
      const { dataKey, authSecret } = deriveAccountKeys(address, password)
      let { data, error: err } = await supabase.auth.signInWithPassword({
        email: address,
        password: authSecret,
      })
      if (err) {
        // An account the desktop has not upgraded yet is still on the raw
        // password. Sign in with it so the phone works today; the desktop
        // performs the one-time rotation on its next sign-in.
        const legacy = await supabase.auth.signInWithPassword({ email: address, password })
        if (legacy.error) throw new Error(err.message)
        data = legacy.data
      }
      await setCloudKey(dataKey)
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
        On your computer open Settings → Mobile App and press “Pair a phone”.
      </Text>

      <TouchableOpacity
        style={[styles.button, busy && styles.buttonDisabled, { marginBottom: 14 }]}
        onPress={() => { setError(''); setScanning(true) }}
        disabled={busy}
      >
        <Text style={styles.buttonText}>Scan the QR code</Text>
      </TouchableOpacity>

      <Text style={styles.label}>…or enter the 8-character code</Text>
      <TextInput
        style={styles.input}
        value={pairCode}
        onChangeText={t => setPairCode(t.toUpperCase())}
        placeholder="ABCD1234"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={8}
      />

      <TouchableOpacity
        style={[styles.button, busy && styles.buttonDisabled, { marginBottom: 22 }]}
        onPress={() => pair()}
        disabled={busy}
      >
        <Text style={styles.buttonText}>{busy ? 'Pairing…' : 'Pair with code'}</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Typing the code needs the address below too. Scanning fills in everything.
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

        <Text style={styles.label}>Shared token (older desktops only)</Text>
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

        {scanning && (
          <QrPairScanner
            onCancel={() => setScanning(false)}
            onScanned={(payload) => {
              setScanning(false)
              // Fill the fields too, so a failed pair can be retried by hand
              // instead of sending the user back to the desktop for a new code.
              if (payload.host) setHost(String(payload.host))
              if (payload.port) setPort(String(payload.port))
              if (payload.code) setPairCode(String(payload.code))
              pair(payload)
            }}
          />
        )}
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
