// Do the desktop and the phone still derive the same keys?
//
// The two halves of the cloud encryption scheme are written twice, in different
// languages of crypto library: web/electron/services/cloudCrypto.js uses Node's
// built-in `crypto`, and app/src/cloudCrypto.js uses @noble/hashes because React
// Native has no Node crypto. The file on the phone says it "must stay
// bit-for-bit identical" — and until now nothing checked that it was.
//
// The failure mode is severe and completely silent on the desktop. If a
// parameter drifts on one side — a changed round count, a different HKDF salt,
// hex where base64 was expected — the desktop keeps working perfectly, keeps
// uploading, and every paired phone simply cannot decrypt anything, or cannot
// sign in at all because the auth secret no longer matches what Supabase holds.
// Nobody running `npm test` on the desktop would ever see it.
//
// So this reimplements the phone's derivation here, with the same @noble/hashes
// primitives the phone actually uses, and asserts the two agree exactly.

const { service, createChecker } = require('./helpers')
const desktop = service('cloudCrypto')
const { check, done } = createChecker()

// The phone's dependency, resolved from the mobile app's own node_modules so
// this tests the version that actually ships rather than a copy.
const path = require('path')
const APP_MODULES = path.join(__dirname, '..', '..', 'app', 'node_modules')

let noble = null
try {
  noble = {
    sha256: require(path.join(APP_MODULES, '@noble/hashes/sha2.js')).sha256,
    pbkdf2: require(path.join(APP_MODULES, '@noble/hashes/pbkdf2.js')).pbkdf2,
    hkdf: require(path.join(APP_MODULES, '@noble/hashes/hkdf.js')).hkdf,
    utils: require(path.join(APP_MODULES, '@noble/hashes/utils.js')),
  }
} catch {
  noble = null
}

if (!noble) {
  // Skipping is a local convenience for a desktop-only checkout. It is NOT a way
  // for this check to quietly disappear: CI runs this file as its own step in
  // the mobile job, where app/node_modules is always installed.
  console.log('SKIP  app/node_modules is not installed — run `npm ci --prefix app` to run this suite')
  done()
} else {
  const { sha256, pbkdf2, hkdf, utils } = noble
  const { utf8ToBytes, bytesToHex } = utils

  // ─── The phone's implementation, transcribed ───────────────────
  // Kept deliberately verbatim from app/src/cloudCrypto.js. If that file is
  // edited, this must be edited to match and the checks below will disagree if
  // the edit changed anything that matters.
  const PBKDF2_ROUNDS = 200000
  const INFO_AUTH = 'hiro-auth-v3'
  const INFO_DATA = 'hiro-data-v3'

  const bytesToBase64 = bytes => Buffer.from(bytes).toString('base64')
  const saltFor = email => `hiro-cloud:${String(email).trim().toLowerCase()}`

  function phoneMasterKey(email, password) {
    return pbkdf2(sha256, utf8ToBytes(password), utf8ToBytes(saltFor(email)), { c: PBKDF2_ROUNDS, dkLen: 32 })
  }

  function phoneDeriveAccountKeys(email, password) {
    const master = phoneMasterKey(email, password)
    const salt = utf8ToBytes(saltFor(email))
    return {
      dataKey: bytesToBase64(hkdf(sha256, master, salt, utf8ToBytes(INFO_DATA), 32)),
      authSecret: bytesToHex(hkdf(sha256, master, salt, utf8ToBytes(INFO_AUTH), 32)),
    }
  }

  // ─── They must agree ───────────────────────────────────────────
  const cases = [
    ['user@example.com', 'correct horse battery staple'],
    // Case and whitespace in the address are folded into the salt on both sides.
    ['  USER@Example.COM  ', 'correct horse battery staple'],
    // Non-ASCII in the password: a UTF-8 encoding difference between the two
    // libraries would show up here and nowhere else.
    ['jose@example.com', 'contraseña—díficil 🔐'],
    ['a@b.co', ''],
  ]

  for (const [email, password] of cases) {
    const label = `${email.trim() || '(blank)'} / ${password ? 'pw' : '(blank pw)'}`
    const mine = desktop.deriveAccountKeys(email, password)
    const theirs = phoneDeriveAccountKeys(email, password)
    check(`data key matches the phone — ${label}`, mine.dataKey, theirs.dataKey)
    check(`auth secret matches the phone — ${label}`, mine.authSecret, theirs.authSecret)
  }

  // ─── And what the desktop encrypts, the phone's key opens ──────
  // expo-crypto's AES cannot run under Node, so the cipher itself is not
  // exercised here — but the key is what actually drifts, and this proves the
  // phone would be holding the right one.
  const email = 'user@example.com', password = 'correct horse battery staple'
  const phoneKey = phoneDeriveAccountKeys(email, password).dataKey
  const payload = desktop.encrypt(desktop.deriveKey(email, password), { resume: 'private text' })
  check('a payload the desktop wrote opens with the phone-derived key',
    desktop.decrypt(phoneKey, payload), { resume: 'private text' })

  // The envelope version is the other cross-platform constant: the phone rejects
  // anything that is not exactly this, so a bump on one side strands the other.
  check('the envelope version both sides hard-code is 3', desktop.ENVELOPE_VERSION, 3)
  check('written payloads carry it', JSON.parse(payload).v, 3)

  done()
}
