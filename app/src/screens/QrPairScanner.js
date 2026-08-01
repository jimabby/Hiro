// Camera view for scanning the desktop's pairing QR.
//
// The QR carries the address, port and one-time code together, because any one
// of them alone is useless — an address with no code cannot pair, and a code
// with no address has nowhere to send it.
//
// Deliberately narrow: it reads QR codes, hands the payload up, and closes. It
// never stores anything and never talks to the network; the caller does the
// pairing so a failure lands in the same error line as a typed code.

import { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { colors, radius } from '../theme'

export default function QrPairScanner({ onScanned, onCancel }) {
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
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
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
            if (!payload || payload.v !== 1 || !payload.code || !payload.host) return
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

const Overlay = ({ children }) => <View style={styles.overlay}>{children}</View>

const Cancel = ({ onCancel }) => (
  <TouchableOpacity style={styles.cancel} onPress={onCancel}>
    <Text style={styles.cancelText}>Cancel</Text>
  </TouchableOpacity>
)

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  cameraWrap: {
    width: 260, height: 260, borderRadius: radius,
    overflow: 'hidden', backgroundColor: '#000', marginBottom: 20,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 10 },
  text: { color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  button: {
    backgroundColor: colors.accent, borderRadius: radius,
    paddingVertical: 12, paddingHorizontal: 24, marginTop: 18,
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cancel: { marginTop: 22 },
  cancelText: { color: colors.textMuted, fontSize: 14 },
})
