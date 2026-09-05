// Camera view for scanning the desktop's pairing QR.
//
// The QR carries the address, port and one-time code together, because any one
// of them alone is useless — an address with no code cannot pair, and a code
// with no address has nowhere to send it.
//
// Deliberately narrow: it reads QR codes, hands the payload up, and closes. It
// never stores anything and never talks to the network; the caller does the
// pairing so a failure lands in the same error line as a typed code.

import { useState, useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { radius, useTheme } from '../theme'

// Pairing QR payload versions this build understands. v1 desktops pair in the
// clear; v2 desktops offer the encrypted exchange in src/pairProtocol.js.
const SUPPORTED_QR_VERSIONS = [1, 2]

export default function QrPairScanner({ onScanned, onCancel }) {
  // Palette and stylesheet follow the phone's appearance setting. Named
  // `colors` so every inline reference below reads unchanged.
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [permission, requestPermission] = useCameraPermissions()
  // The camera fires repeatedly while the code stays in frame; without this the
  // pair request is sent a dozen times and every attempt after the first fails
  // against a code that has already been spent.
  const [handled, setHandled] = useState(false)

  if (!permission) {
    return (
      <Overlay>
        <Text style={styles.text}>Checking camera permission…</Text>
        <Cancel onCancel={onCancel} />
      </Overlay>
    )
  }

  if (!permission.granted) {
    return (
      <Overlay>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.text}>
          Scanning the pairing code needs the camera. You can also type the 8-character
          code instead — nothing is lost by declining.
        </Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}
          accessibilityRole="button" accessibilityLabel="Allow camera access"
          accessibilityHint="Needed to scan the pairing code on your desktop">
          <Text style={styles.buttonText}>Allow camera</Text>
        </TouchableOpacity>
        <Cancel onCancel={onCancel} />
      </Overlay>
    )
  }

  return (
    <Overlay>
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled) return
            let payload
            try {
              payload = JSON.parse(data)
            } catch {
              return // some other QR code happened to be in frame
            }
            // Only accept a payload that is actually a Hiro pairing QR.
            //
            // Any version this app knows how to pair with: v1 desktops encode
            // the same three fields, and the key exchange is fetched from the
            // desktop rather than carried in the QR, so the version here says
            // which desktop is on the other end and not which fields to read.
            if (!payload || !SUPPORTED_QR_VERSIONS.includes(payload.v) || !payload.code || !payload.host) return
            setHandled(true)
            onScanned(payload)
          }}
        />
      </View>
      <Text style={styles.text}>Point the camera at the QR code on your computer.</Text>
      <Cancel onCancel={onCancel} />
    </Overlay>
  )
}

// Both are components, so both take the palette from the hook the same way the
// screen above does.
const Overlay = ({ children }) => {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return <View style={styles.overlay}>{children}</View>
}

const Cancel = ({ onCancel }) => {
  const colors = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <TouchableOpacity style={styles.cancel} onPress={onCancel}
      accessibilityRole="button" accessibilityLabel="Cancel scanning">
      <Text style={styles.cancelText}>Cancel</Text>
    </TouchableOpacity>
  )
}

// Rebuilt per palette — see useTheme() in ../theme.
const makeStyles = (c) => StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  cameraWrap: {
    width: 260, height: 260, borderRadius: radius,
    overflow: 'hidden', backgroundColor: '#000', marginBottom: 20,
  },
  title: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 10 },
  text: { color: c.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  button: {
    backgroundColor: c.accent, borderRadius: radius,
    paddingVertical: 12, paddingHorizontal: 24, marginTop: 18,
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cancel: { marginTop: 22 },
  cancelText: { color: c.textMuted, fontSize: 14 },
})
