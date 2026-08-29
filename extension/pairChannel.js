// Browser half of the pairing channel. Must stay byte-for-byte compatible with
// web/electron/services/pairChannel.js — see that file for the threat model.
//
// P-256 rather than X25519 because WebCrypto has had P-256 ECDH since forever
// and X25519 only lands in recent Chrome; this extension declares a minimum of
// Chrome 102. Everything here is standard WebCrypto, so nothing is bundled.
(function expose(root) {
  const encoder = new TextEncoder()
  const PBKDF2_ROUNDS = 200000
  const KEY_BITS = 256
  const INFO = 'hiro-pair-v2'
  const PROTOCOL_VERSION = 2

  function bytesToBase64(bytes) {
    let out = ''
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(out)
  }
  function base64ToBytes(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)) }

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }

  // Identical normalisation to the other two ends, or the tag never agrees.
  function normaliseCode(code) {
    return String(code || '').trim().toUpperCase().replace(/\s+/g, '')
  }

  async function codeKey(code, salt) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(normaliseCode(code)), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' }, base, KEY_BITS)
    return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  }

  // Verify the desktop's hello, then agree a session key with it.
  //
  // Throws when the tag does not verify: either the code is wrong, or something
  // on the network answered in the desktop's place. Both are worth stopping for.
  async function openChannel(hello, code) {
    if (hello?.v !== PROTOCOL_VERSION) {
      throw new Error('This desktop is running an older version of Hiro. Update it to pair securely.')
    }
    const desktopKeyBytes = base64ToBytes(hello.pk)
    const salt = base64ToBytes(hello.salt)
    const signed = concat(encoder.encode(String(PROTOCOL_VERSION)), desktopKeyBytes, salt)
    const valid = await crypto.subtle.verify('HMAC', await codeKey(code, salt), base64ToBytes(hello.tag), signed)
    if (!valid) {
      throw new Error('That pairing code does not match this desktop. Check the code, and if it is right, '
        + 'something on this network may be impersonating the desktop.')
    }

    const desktopKey = await crypto.subtle.importKey(
      'raw', desktopKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    // deriveBits on ECDH yields the shared x-coordinate, which is exactly what
    // Node's computeSecret returns and what noble's getSharedSecret carries.
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: desktopKey }, mine.privateKey, KEY_BITS)
    const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
    const keyBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(INFO) }, hkdfKey, KEY_BITS)
    const key = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    // 'raw' export of a P-256 public key is the uncompressed point the desktop
    // expects.
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey))
    return { key, publicKey: bytesToBase64(publicKey) }
  }

  async function sealRequest(channel, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const body = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, channel.key, encoder.encode(JSON.stringify(value))))
    return { v: PROTOCOL_VERSION, epk: channel.publicKey, data: bytesToBase64(concat(iv, body)) }
  }

  async function openResponse(channel, envelope) {
    if (envelope?.v !== PROTOCOL_VERSION || !envelope.data) {
      throw new Error('The desktop answered the pairing request in the clear. Update Hiro on the desktop.')
    }
    const combined = base64ToBytes(envelope.data)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: combined.slice(0, 12) }, channel.key, combined.slice(12))
    return JSON.parse(new TextDecoder().decode(plain))
  }

  const pairChannel = { openChannel, sealRequest, openResponse, normaliseCode, PROTOCOL_VERSION }
  root.HiroPairChannel = pairChannel
  if (typeof module !== 'undefined') module.exports = pairChannel
})(globalThis)
