// Pairing a phone, and the per-device tokens it produces.
//
// This replaces one shared token that never expired and could not be withdrawn
// from a single lost phone. Everything below is about the properties that make
// the replacement worth having: codes that cannot be reused, tokens that cannot
// be recovered from the config file, and revocation that actually revokes.

const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-pairing-' + Date.now())

let store = { mobileDevices: [], mobileTokenTtlDays: 90 }
const configDouble = {
  load: () => JSON.parse(JSON.stringify(store)),
  update: (patch) => { store = { ...store, ...JSON.parse(JSON.stringify(patch)) } },
  CONFIG_DIR,
}
stub({ './config': configDouble })

const pairing = service('pairing.js')
const { check, done } = createChecker()

const reset = () => { store = { mobileDevices: [], mobileTokenTtlDays: 90 }; pairing.clearPairingCode() }

// ── Pairing codes ──────────────────────────────────────────────
{
  reset()
  const issued = pairing.createPairingCode()
  check('a code is issued', typeof issued.code === 'string' && issued.code.length === 8, true)
  check('the code expires', issued.expiresAt > Date.now(), true)
  check('the code is short-lived', issued.ttlMs <= 10 * 60 * 1000, true)

  // No character a person can misread between two screens.
  check('the alphabet excludes confusable letters', /^[0-9A-HJKMNP-TV-Z]+$/.test(issued.code), true)

  // Single use. A code that can be redeemed twice is one an observer can reuse.
  check('the right code is accepted', pairing.consumePairingCode(issued.code).ok, true)
  check('the same code cannot be used twice', pairing.consumePairingCode(issued.code).ok, false)
  check('a spent code stops being listed', pairing.getActiveCode(), null)
}

{
  reset()
  const issued = pairing.createPairingCode()
  check('a wrong code is rejected', pairing.consumePairingCode('AAAAAAAA').ok, false)
  // A rejected attempt must not burn the real code — otherwise anyone on the
  // LAN can deny pairing by guessing once.
  check('a wrong guess does not consume the code', pairing.consumePairingCode(issued.code).ok, true)
}

{
  reset()
  // Case and whitespace are typing artefacts, not authentication.
  const issued = pairing.createPairingCode()
  check('a lowercased code is accepted', pairing.consumePairingCode(`  ${issued.code.toLowerCase()} `).ok, true)
}

{
  reset()
  const past = Date.now() - 1
  pairing.createPairingCode(past - pairing.CODE_TTL_MS)
  check('an expired code is refused', pairing.consumePairingCode('WHATEVER', past).ok, false)
  check('an expired code is not listed', pairing.getActiveCode(past), null)
}

{
  reset()
  check('no code means nothing to redeem', pairing.consumePairingCode('AAAAAAAA').ok, false)

  // Only one code outstanding at a time — a second issue must invalidate the
  // first, or the user has a live credential they have forgotten about.
  const first = pairing.createPairingCode()
  const second = pairing.createPairingCode()
  check('issuing again replaces the previous code', pairing.consumePairingCode(first.code).ok, false)
  check('the newest code works', pairing.consumePairingCode(second.code).ok, true)
}

// ── Device tokens ──────────────────────────────────────────────
{
  reset()
  const { token, device } = pairing.issueDeviceToken(configDouble, { name: 'Jim’s iPhone', platform: 'ios' })
  check('a token is issued', typeof token === 'string' && token.length >= 64, true)
  check('the device is named', device.name, 'Jim’s iPhone')
  check('the platform is recorded', device.platform, 'ios')
  check('the device has an expiry', !!device.expiresAt, true)

  // The plaintext token is returned once and never stored. A config file that
  // leaks must not hand over working credentials.
  const stored = store.mobileDevices[0]
  check('the plaintext token is not stored', JSON.stringify(store).includes(token), false)
  check('a hash is stored instead', stored.tokenHash, crypto.createHash('sha256').update(token).digest('hex'))
  check('the public view hides the hash', device.tokenHash, undefined)

  check('the token verifies', pairing.verifyDeviceToken(configDouble, token)?.name, 'Jim’s iPhone')
  check('a wrong token does not', pairing.verifyDeviceToken(configDouble, 'deadbeef'), null)
  check('an empty token does not', pairing.verifyDeviceToken(configDouble, ''), null)
  check('a null token does not', pairing.verifyDeviceToken(configDouble, null), null)

  // The hash is not itself a credential.
  check('presenting the hash does not authenticate',
    pairing.verifyDeviceToken(configDouble, stored.tokenHash), null)
}

// ── Expiry ─────────────────────────────────────────────────────
{
  reset()
  const now = Date.now()
  const { token } = pairing.issueDeviceToken(configDouble, { name: 'Old phone' }, now)
  check('valid before expiry', !!pairing.verifyDeviceToken(configDouble, token, now + 89 * 86400000), true)
  check('refused after expiry', pairing.verifyDeviceToken(configDouble, token, now + 91 * 86400000), null)
  check('expiry is visible in the list',
    pairing.listDevices(configDouble, now + 91 * 86400000)[0].expired, true)
}

{
  reset()
  // 0 is a deliberate choice — "this token never expires" — not a missing value.
  store.mobileTokenTtlDays = 0
  const now = Date.now()
  const { token, device } = pairing.issueDeviceToken(configDouble, { name: 'Permanent' }, now)
  check('zero ttl means no expiry date', device.expiresAt, null)
  check('a never-expiring token still works in ten years',
    !!pairing.verifyDeviceToken(configDouble, token, now + 3650 * 86400000), true)

  // A hand-edited nonsense ttl must not silently become "never expires".
  check('a negative ttl falls back to the default', pairing.normaliseTtlDays(-5), pairing.DEFAULT_TOKEN_TTL_DAYS)
  check('a non-numeric ttl falls back to the default', pairing.normaliseTtlDays('soon'), pairing.DEFAULT_TOKEN_TTL_DAYS)
  check('zero is preserved', pairing.normaliseTtlDays(0), 0)
}

// ── Multiple devices and revocation ────────────────────────────
{
  reset()
  const a = pairing.issueDeviceToken(configDouble, { name: 'Phone A', platform: 'ios' })
  const b = pairing.issueDeviceToken(configDouble, { name: 'Phone B', platform: 'android' })
  check('both devices are listed', pairing.listDevices(configDouble).length, 2)
  check('device A works', !!pairing.verifyDeviceToken(configDouble, a.token), true)
  check('device B works', !!pairing.verifyDeviceToken(configDouble, b.token), true)

  // The point of per-device tokens: losing one phone does not disturb the other.
  const revoked = pairing.revokeDevice(configDouble, a.device.id)
  check('revoking succeeds', revoked.success, true)
  check('the revoked device is refused immediately', pairing.verifyDeviceToken(configDouble, a.token), null)
  check('the other device is untouched', !!pairing.verifyDeviceToken(configDouble, b.token), true)
  check('the revoked device is gone from the list', pairing.listDevices(configDouble).length, 1)

  check('revoking an unknown device fails cleanly', pairing.revokeDevice(configDouble, 'nope').success, false)

  pairing.revokeAll(configDouble)
  check('revoke-all clears everything', pairing.listDevices(configDouble).length, 0)
  check('no token survives revoke-all', pairing.verifyDeviceToken(configDouble, b.token), null)
}

// ── Last-seen tracking ─────────────────────────────────────────
{
  reset()
  const now = Date.now()
  const { device } = pairing.issueDeviceToken(configDouble, { name: 'Phone' }, now)

  // Throttled: this runs on every authenticated request, and each write
  // re-serialises the whole config file.
  pairing.touchDevice(configDouble, device.id, now + 1000)
  check('a touch within the interval is skipped', store.mobileDevices[0].lastSeenAt, device.lastSeenAt)

  pairing.touchDevice(configDouble, device.id, now + 120000)
  check('a later touch is recorded', store.mobileDevices[0].lastSeenAt !== device.lastSeenAt, true)
  check('touching an unknown device is harmless',
    (() => { pairing.touchDevice(configDouble, 'nope', now + 999999); return true })(), true)
}

// ── Field limits ───────────────────────────────────────────────
{
  reset()
  // The name is attacker-supplied and ends up in a log line and the UI.
  const { device } = pairing.issueDeviceToken(configDouble, { name: 'x'.repeat(500), platform: 'y'.repeat(500) })
  check('the device name is bounded', device.name.length <= 60, true)
  check('the platform is bounded', device.platform.length <= 20, true)
  const unnamed = pairing.issueDeviceToken(configDouble, {})
  check('a missing name gets a default', unnamed.device.name, 'Phone')
}

// ── Pruning long-dead devices ──────────────────────────────────
//
// An expired entry is already inert — verifyDeviceToken refuses it and
// deviceSecrets skips it — but nothing ever removed one, so the list grew for
// the life of the profile. deviceSecrets runs on EVERY signed request and
// unwraps each surviving tokenEnc through the OS keychain, so a long-lived
// profile paid a keychain decrypt per dead phone per request.
{
  reset()
  const now = Date.now()
  const day = 86400000

  store.mobileTokenTtlDays = 1
  pairing.issueDeviceToken(configDouble, { name: 'Old phone' }, now - 400 * day)
  pairing.issueDeviceToken(configDouble, { name: 'Recently expired' }, now - 3 * day)
  store.mobileTokenTtlDays = 0 // never expires
  pairing.issueDeviceToken(configDouble, { name: 'Permanent' }, now)
  store.mobileTokenTtlDays = 90
  pairing.issueDeviceToken(configDouble, { name: 'Live phone' }, now)

  check('all four are registered', store.mobileDevices.length, 4)

  const { removed } = pairing.pruneExpiredDevices(configDouble, now)
  check('only the long-dead one is removed', removed, 1)

  const names = store.mobileDevices.map(d => d.name)
  check('the long-dead device is gone', names.includes('Old phone'), false)
  // Deliberate: a device that expired yesterday should still be visible and
  // named, so "why did my phone stop working" has an answer on screen rather
  // than a silent disappearance.
  check('a recently expired device is kept during the grace period',
    names.includes('Recently expired'), true)
  check('a never-expiring device is kept', names.includes('Permanent'), true)
  check('a live device is kept', names.includes('Live phone'), true)

  check('pruning again removes nothing', pairing.pruneExpiredDevices(configDouble, now).removed, 0)
}

done()
