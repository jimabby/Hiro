#!/usr/bin/env node
// Assert the RESOLVED Expo config asks for nothing Hiro does not use.
//
// app.json is not the answer to "what permissions does the app request" — config
// plugins add their own. expo-camera, for example, adds RECORD_AUDIO to the
// Android manifest by default, which is how Hiro ended up requesting a
// microphone it never touches: nothing in app.json mentioned it, so nothing in
// review caught it. This runs `expo config --type public` and checks the merged
// result, so a dependency bump that reintroduces one fails CI instead of
// shipping.

const { execFileSync } = require('child_process')
const path = require('path')

const APP_DIR = path.join(__dirname, '..')

// Permissions Hiro legitimately needs, with the reason it needs them. Adding to
// this list is a deliberate act; anything not listed is a failure.
const ALLOWED_ANDROID = {
  'android.permission.CAMERA': 'scanning the desktop pairing QR code',
  'android.permission.INTERNET': 'reaching the desktop over LAN and Supabase over the internet',
  // Added by expo-notifications for push delivery on Android 13+.
  'android.permission.POST_NOTIFICATIONS': 'recruiter-reply and interview push notifications',
  'android.permission.RECEIVE_BOOT_COMPLETED': 'restoring scheduled notifications after a reboot',
  'android.permission.VIBRATE': 'notification feedback',
}

const ALLOWED_IOS_KEYS = {
  NSCameraUsageDescription: 'scanning the desktop pairing QR code',
  NSAppTransportSecurity: 'plain-HTTP access to the desktop on the local network',
  NSLocalNetworkUsageDescription: 'discovering the desktop on the local network',
  NSBonjourServices: 'discovering the desktop on the local network',
}

// Permissions that must never appear, whatever adds them. Listed explicitly so
// the failure message can say why rather than just "unexpected".
const FORBIDDEN = {
  'android.permission.RECORD_AUDIO': 'Hiro only scans QR codes — it never records audio.',
  'android.permission.MODIFY_AUDIO_SETTINGS': 'Hiro plays no audio.',
  'android.permission.ACCESS_FINE_LOCATION': 'Hiro does not use location.',
  'android.permission.ACCESS_COARSE_LOCATION': 'Hiro does not use location.',
  'android.permission.READ_CONTACTS': 'Hiro does not read contacts.',
  'android.permission.READ_EXTERNAL_STORAGE': 'Hiro reads no files from the device.',
  'android.permission.WRITE_EXTERNAL_STORAGE': 'Hiro writes no files to the device.',
  NSMicrophoneUsageDescription: 'Hiro only scans QR codes — it never records audio.',
  NSLocationWhenInUseUsageDescription: 'Hiro does not use location.',
  NSContactsUsageDescription: 'Hiro does not read contacts.',
  NSPhotoLibraryUsageDescription: 'Hiro does not read the photo library.',
}

let config
try {
  // Run the CLI's JS entry point with this Node rather than going through npx.
  // npx resolves to a .cmd on Windows, which Node refuses to spawn without
  // shell: true, and shell: true would concatenate the arguments instead of
  // escaping them.
  const cli = require.resolve('expo/bin/cli', { paths: [APP_DIR] })
  const out = execFileSync(process.execPath, [cli, 'config', '--type', 'public', '--json'], {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // `expo config` prints progress lines before the JSON on some versions.
  config = JSON.parse(out.slice(out.indexOf('{')))
} catch (err) {
  console.error(`Could not read the resolved Expo config: ${err.message}`)
  process.exit(1)
}

const problems = []

const androidPermissions = config.android?.permissions || []
const blocked = new Set(config.android?.blockedPermissions || [])

for (const perm of androidPermissions) {
  // A blocked permission is stripped from the merged manifest, so its presence
  // in `permissions` is harmless — but say so rather than silently ignoring it.
  if (blocked.has(perm)) {
    console.log(`–  ${perm} (requested by a plugin, stripped by blockedPermissions)`)
    continue
  }
  if (FORBIDDEN[perm]) {
    problems.push(`Android requests ${perm}. ${FORBIDDEN[perm]}`)
  } else if (!ALLOWED_ANDROID[perm]) {
    problems.push(`Android requests ${perm}, which is not on the allow-list in ${path.relative(APP_DIR, __filename)}.`)
  } else {
    console.log(`✓  ${perm} — ${ALLOWED_ANDROID[perm]}`)
  }
}

const infoPlist = config.ios?.infoPlist || {}
for (const key of Object.keys(infoPlist)) {
  if (FORBIDDEN[key]) {
    problems.push(`iOS declares ${key}. ${FORBIDDEN[key]}`)
  } else if (!ALLOWED_IOS_KEYS[key]) {
    // Not every Info.plist key is a permission; only usage-description keys
    // trigger a system prompt and a store-review question.
    if (/UsageDescription$/.test(key)) {
      problems.push(`iOS declares ${key}, which is not on the allow-list in ${path.relative(APP_DIR, __filename)}.`)
    }
  } else {
    console.log(`✓  ${key} — ${ALLOWED_IOS_KEYS[key]}`)
  }
}

if (problems.length > 0) {
  console.error('\nPermission check failed:')
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\nIf a permission is genuinely needed, add it to the allow-list with the reason.')
  console.error('If a plugin added it and Hiro does not need it, disable it in the plugin config')
  console.error('(expo-camera takes recordAudioAndroid: false) or list it under android.blockedPermissions.')
  process.exit(1)
}

console.log('\nNo unnecessary permissions requested.')
