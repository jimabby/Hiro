// The pairing exchange, across all three implementations of it.
//
// What is at stake: this is the message that hands a phone a 90-day device
// token, over plain HTTP, on whatever network the user happens to be on. It used
// to send that token in the clear — everything AFTER pairing was signed and
// encrypted, but the exchange that bootstrapped it was readable by anyone
// sharing the cafe Wi-Fi for the two seconds it took.
//
// Three independent implementations have to agree byte-for-byte or pairing
// simply fails: the desktop (node crypto), the browser extension (WebCrypto),
// and the phone (@noble/curves). Two of them can be executed here directly. The
// phone's is ESM and needs expo-crypto for the AES step, so its DERIVATION —
// the part that has to interoperate — is reproduced against noble below, with
// the same library and the same calls src/pairProtocol.js makes.

const path = require('path')
const crypto = require('crypto')
const { service, createChecker } = require('./helpers')

const desktop = service('pairChannel.js')
// The real extension file, run in Node. Its WebCrypto calls are the same ones
// the browser makes.
const browser = require(path.join(__dirname, '..', '..', 'extension', 'pairChannel.js'))
// The exact library and entrypoint app/src/pairProtocol.js imports, resolved
// from the mobile app's own node_modules so this tests the build that actually
// ships. A desktop-only checkout does not have it; that is handled below rather
// than crashing the whole suite, which is what used to happen on CI — the
// desktop job installs `web` only, so this file failed there every single run
// and took the two thirds of it that need no phone dependency down with it.
let p256 = null
try {
  ({ p256 } = require(path.join(__dirname, '..', '..', 'app', 'node_modules', '@noble', 'curves', 'nist.js')))
} catch {
  p256 = null
}

const { check, done } = createChecker()

const CODE = 'K7M2QW9X'

;(async () => {
  // ── Desktop <-> browser extension, end to end ───────────────────
  {
    const channel = desktop.createChannel(CODE)
    const client = await browser.openChannel(channel.hello, CODE)
    const sealed = await browser.sealRequest(client, { code: CODE, deviceName: 'Browser extension', platform: 'extension' })

    check('the client announces the protocol version', sealed.v, desktop.PROTOCOL_VERSION)
    // The wire carries no code and no token — that is the entire point.
    check('the pairing code never appears on the wire', JSON.stringify(sealed).includes(CODE), false)

    const key = desktop.sessionKey(channel, sealed.epk)
    const request = desktop.decrypt(key, sealed.data)
    check('the desktop reads the code the client sent', request.code, CODE)
    check('and the device name', request.deviceName, 'Browser extension')

    const token = 'f'.repeat(64)
    const reply = { v: desktop.PROTOCOL_VERSION, data: desktop.encrypt(key, { token, device: { id: 'd1' }, host: 'desk' }) }
    check('the token never appears on the wire', JSON.stringify(reply).includes(token), false)
    const opened = await browser.openResponse(client, reply)
    check('the client recovers the token', opened.token, token)
    check('and the device record', opened.device.id, 'd1')
  }

  // ── Desktop <-> phone derivation ────────────────────────────────
  // Reproduces src/pairProtocol.js openChannel() with the same library, to pin
  // that noble's shared secret is the one node computes. A mismatch here is a
  // phone that cannot pair at all.
  // Skipping is a local convenience for a desktop-only checkout. It is NOT a way
  // for this check to quietly disappear: CI runs this file as its own step in
  // the mobile job, where app/node_modules is always installed.
  if (!p256) {
    console.log('SKIP  app/node_modules is not installed — run `npm ci --prefix app` to check the phone derivation')
  } else {
    const channel = desktop.createChannel(CODE)
    const secretKey = p256.utils.randomSecretKey()
    const publicKey = p256.getPublicKey(secretKey, false)
    check('noble produces an uncompressed point', publicKey.length, 65)
    // getSharedSecret returns a compressed point; the shared value is its
    // x-coordinate, which is what the other two hand to HKDF.
    const shared = p256.getSharedSecret(secretKey, new Uint8Array(channel.publicKey)).slice(1)
    const phoneKey = Buffer.from(crypto.hkdfSync('sha256', shared, channel.salt, Buffer.from(desktop.INFO), desktop.KEY_BYTES))
    const desktopKey = desktop.sessionKey(channel, Buffer.from(publicKey).toString('base64'))
    check('phone and desktop agree on the session key', phoneKey.equals(desktopKey), true)
  }

  // ── The code authenticates the desktop ──────────────────────────
  // This is what stops an ACTIVE attacker on the LAN. They can answer the hello
  // with their own public key, but they cannot tag it, because the code was read
  // off the desktop screen and never crossed the network.
  {
    const channel = desktop.createChannel(CODE)
    let rejected = false
    try { await browser.openChannel(channel.hello, 'WRONGCODE') } catch { rejected = true }
    check('a wrong code is refused rather than pairing anyway', rejected, true)
  }
  {
    const real = desktop.createChannel(CODE)
    const attacker = desktop.createChannel('SOMEOTHER')
    // The attacker substitutes their own key but cannot recompute the tag.
    const forged = { ...real.hello, pk: attacker.hello.pk }
    let rejected = false
    try { await browser.openChannel(forged, CODE) } catch { rejected = true }
    check('a substituted public key is refused', rejected, true)
  }
  {
    const real = desktop.createChannel(CODE)
    // …and neither can they keep the real key while re-salting it.
    const forged = { ...real.hello, salt: Buffer.alloc(16, 7).toString('base64') }
    let rejected = false
    try { await browser.openChannel(forged, CODE) } catch { rejected = true }
    check('a substituted salt is refused', rejected, true)
  }

  // ── Two windows never share key material ────────────────────────
  {
    const first = desktop.createChannel(CODE)
    const second = desktop.createChannel(CODE)
    check('each pairing window gets its own key', first.hello.pk === second.hello.pk, false)
    check('and its own salt', first.hello.salt === second.hello.salt, false)
    // So a captured exchange cannot be decrypted against a later window.
    const client = await browser.openChannel(first.hello, CODE)
    const sealed = await browser.sealRequest(client, { code: CODE })
    let failed = false
    try { desktop.decrypt(desktop.sessionKey(second, sealed.epk), sealed.data) } catch { failed = true }
    check('a replayed exchange does not open against a new window', failed, true)
  }

  // ── Malformed input is refused, not crashed on ──────────────────
  {
    const channel = desktop.createChannel(CODE)
    const bad = (epk) => { try { desktop.sessionKey(channel, epk); return false } catch { return true } }
    check('a truncated public key is refused', bad(Buffer.alloc(31).toString('base64')), true)
    check('a compressed point is refused', bad(Buffer.concat([Buffer.from([2]), Buffer.alloc(32)]).toString('base64')), true)
    check('an empty key is refused', bad(''), true)

    const key = crypto.randomBytes(32)
    const tampered = () => {
      const data = Buffer.from(desktop.encrypt(key, { a: 1 }), 'base64')
      data[data.length - 1] ^= 0xff // break the GCM tag
      try { desktop.decrypt(key, data.toString('base64')); return false } catch { return true }
    }
    check('a tampered payload fails its integrity check', tampered(), true)
    check('a short payload is refused', (() => {
      try { desktop.decrypt(key, Buffer.alloc(4).toString('base64')); return false } catch { return true }
    })(), true)
  }

  // ── Codes are normalised identically everywhere ─────────────────
  // The user reads the code off a screen; case and stray spaces must not be a
  // mismatch, and both ends must agree on that or the tag never verifies.
  {
    check('the desktop normalises a typed code', desktop.normaliseCode(' k7m2 qw9x '), CODE)
    check('the browser normalises it the same way', browser.normaliseCode(' k7m2 qw9x '), CODE)
    const channel = desktop.createChannel(CODE)
    let opened = true
    try { await browser.openChannel(channel.hello, ' k7m2 qw9x ') } catch { opened = false }
    check('so a sloppily typed code still pairs', opened, true)
  }

  done()
})()
