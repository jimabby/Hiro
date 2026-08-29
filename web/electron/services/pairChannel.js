// The confidential channel a pairing runs over.
//
// The problem this solves. Everything AFTER pairing is signed and AES-GCM
// encrypted with the device's own token — but the exchange that hands over that
// token spoke plain HTTP, and returned it in the clear. So the one message on
// the wire that contains a 90-day credential was the one message anybody sharing
// the café Wi-Fi could read, and the whole per-device token scheme rested on
// nobody having been listening for the two seconds it took to set up.
//
// TLS is not available here: the desktop has no certificate a phone would
// accept, and shipping one, or asking the user to trust a self-signed cert, is
// worse than what follows.
//
// The shape, and why each piece is there:
//
//   1. GET /api/pair/hello
//        The desktop answers with an ephemeral P-256 public key, a random salt,
//        and an HMAC over both, keyed by PBKDF2(pairing code, salt). The client
//        recomputes that tag from the code the person read off the screen. An
//        ACTIVE attacker who substitutes their own public key cannot produce the
//        tag, because they do not have the code — it never touched the network.
//
//   2. POST /api/pair
//        The client sends its own ephemeral public key and, encrypted under the
//        ECDH shared secret, the pairing code and device name. A PASSIVE
//        observer sees two public keys and ciphertext; recovering the session key
//        means breaking P-256, and brute-forcing the 40-bit code buys nothing
//        because the code authenticates the exchange rather than keying it.
//
//   3. The response — the token itself — comes back under the same key.
//
// Both ends are ephemeral and per-pairing: nothing here is stored, and a
// captured session cannot be replayed against a later one.
//
// The client halves are app/src/pairProtocol.js (phone, @noble/curves) and
// extension/pairChannel.js (browser, WebCrypto). All three must agree
// byte-for-byte; the shared vectors in test/pair-channel.test.js pin that.

const crypto = require('crypto')

const CURVE = 'prime256v1' // P-256, the one curve Node, WebCrypto and noble all have
const PBKDF2_ROUNDS = 200000
const SALT_BYTES = 16
const KEY_BYTES = 32
const INFO = 'hiro-pair-v2'
const PROTOCOL_VERSION = 2

// The code is short — 40 bits, by design, because a person types it — so it is
// stretched hard before it is used for anything. It only ever authenticates;
// it never keys the payload.
function codeKey(code, salt) {
  return crypto.pbkdf2Sync(normaliseCode(code), salt, PBKDF2_ROUNDS, KEY_BYTES, 'sha256')
}

// Whatever the user typed, reduced to what the desktop generated: pairing codes
// are shown uppercase and read aloud, so case and stray spaces are not a
// mismatch. Applied identically on both ends or the tag will never agree.
function normaliseCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '')
}

function helloTag(code, publicKey, salt) {
  return crypto.createHmac('sha256', codeKey(code, salt))
    .update(Buffer.concat([Buffer.from(String(PROTOCOL_VERSION)), publicKey, salt]))
    .digest()
}

// One pairing window's ephemeral key material. Held in memory beside the code
// and discarded with it.
function createChannel(code) {
  const ecdh = crypto.createECDH(CURVE)
  // Uncompressed point (0x04 ‖ X ‖ Y). This is what WebCrypto's raw export and
  // noble's getPublicKey(_, false) both produce, so the three clients agree.
  const publicKey = ecdh.generateKeys()
  const salt = crypto.randomBytes(SALT_BYTES)
  return {
    ecdh,
    publicKey,
    salt,
    hello: {
      v: PROTOCOL_VERSION,
      pk: publicKey.toString('base64'),
      salt: salt.toString('base64'),
      tag: helloTag(code, publicKey, salt).toString('base64'),
    },
  }
}

// The AES key for one exchange: ECDH, then HKDF so the raw shared coordinate is
// never used as a key directly.
function sessionKey(channel, clientPublicKeyB64) {
  const clientKey = Buffer.from(String(clientPublicKeyB64 || ''), 'base64')
  // 0x04 ‖ 32-byte X ‖ 32-byte Y. Checked before computeSecret, which throws an
  // opaque OpenSSL error on anything malformed.
  if (clientKey.length !== 65 || clientKey[0] !== 0x04) {
    throw new Error('Malformed pairing key.')
  }
  const shared = channel.ecdh.computeSecret(clientKey)
  return Buffer.from(crypto.hkdfSync('sha256', shared, channel.salt, Buffer.from(INFO), KEY_BYTES))
}

function encrypt(key, value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64')
}

function decrypt(key, dataB64) {
  const combined = Buffer.from(String(dataB64 || ''), 'base64')
  if (combined.length < 12 + 16) throw new Error('Malformed pairing payload.')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(-16)
  const body = combined.subarray(12, -16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
}

module.exports = {
  createChannel, sessionKey, encrypt, decrypt,
  codeKey, helloTag, normaliseCode,
  CURVE, PBKDF2_ROUNDS, SALT_BYTES, KEY_BYTES, INFO, PROTOCOL_VERSION,
}
