// Pairing a phone to this desktop, and the per-device tokens that come out of
// it.
//
// What this replaces: one shared bearer token, printed in Settings, valid
// forever, identical on every phone that had ever been paired. That token could
// not be aged out, could not be attributed to a device, and could not be
// withdrawn from one phone without breaking every other. Losing a phone meant
// rotating the single secret and re-pairing everything.
//
// The model here is the usual one for this problem:
//
//   1. a short-lived, single-use pairing code proves the person holds the
//      desktop right now
//   2. that code is exchanged, once, for a long-lived token belonging to one
//      device
//   3. the token is stored as a hash, so a leaked config file does not hand
//      over working credentials
//   4. every token has an owner, an age, and an off switch
//
// Codes live in memory only. A pairing code that survives a restart is a
// credential nobody remembers issuing.

const crypto = require('crypto')
const pairChannel = require('./pairChannel')

const CODE_TTL_MS = 5 * 60 * 1000
// One character per byte. 32 divides 256 exactly, so the modulo below is
// unbiased — 8 characters of a 32-symbol alphabet is 40 bits, well past what a
// throttled, five-minute, single-use code needs.
const CODE_CHARS = 8
const TOKEN_BYTES = 32
const DEFAULT_TOKEN_TTL_DAYS = 90

// Crockford base32 without I, L, O, U: no character pair a person can confuse
// while reading a code off one screen and typing it into another.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// { code, expiresAt, used, channel }. The channel is the ephemeral P-256 key
// material for THIS pairing window — see pairChannel.js. It lives and dies with
// the code, so a captured exchange cannot be replayed against a later one.
let activeCode = null

function generateCode() {
  const bytes = crypto.randomBytes(CODE_CHARS)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

// Issue a pairing code, replacing any code still outstanding. Only one can be
// live at a time — two valid codes means one the user has forgotten about.
function createPairingCode(now = Date.now()) {
  const code = generateCode()
  activeCode = { code, expiresAt: now + CODE_TTL_MS, used: false, channel: pairChannel.createChannel(code) }
  return { code, expiresAt: activeCode.expiresAt, ttlMs: CODE_TTL_MS }
}

// What the client needs to open a confidential channel: this window's public
// key, its salt, and an HMAC over both that only someone holding the pairing
// code can check. Unauthenticated by necessity — it is what bootstraps the
// authentication — and it discloses nothing: the public key is public, and the
// tag is unforgeable without the code.
function getHello(now = Date.now()) {
  if (!activeCode || activeCode.used || activeCode.expiresAt <= now) return null
  return activeCode.channel.hello
}

// The AES key for an in-flight pairing, from the client's ephemeral public key.
function channelKey(clientPublicKey, now = Date.now()) {
  if (!activeCode || activeCode.used || activeCode.expiresAt <= now) return null
  return pairChannel.sessionKey(activeCode.channel, clientPublicKey)
}

function getActiveCode(now = Date.now()) {
  if (!activeCode) return null
  if (activeCode.used || activeCode.expiresAt <= now) return null
  return { code: activeCode.code, expiresAt: activeCode.expiresAt }
}

function clearPairingCode() {
  activeCode = null
}

// Spend the code. Single-use and constant-time compared: a code that can be
// redeemed twice is a code an observer can reuse.
function consumePairingCode(submitted, now = Date.now()) {
  if (!activeCode) return { ok: false, reason: 'No pairing code is active. Generate one on the desktop.' }
  if (activeCode.used) return { ok: false, reason: 'That pairing code has already been used.' }
  if (activeCode.expiresAt <= now) return { ok: false, reason: 'That pairing code has expired. Generate a new one.' }
  if (!constantTimeEqual(pairChannel.normaliseCode(submitted), activeCode.code)) {
    return { ok: false, reason: 'Incorrect pairing code.' }
  }
  activeCode.used = true
  return { ok: true }
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare against a padded copy and fold the length into the result.
  const len = Math.max(ab.length, bb.length, 1)
  const pa = Buffer.alloc(len)
  const pb = Buffer.alloc(len)
  ab.copy(pa)
  bb.copy(pb)
  return crypto.timingSafeEqual(pa, pb) && ab.length === bb.length
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

// Mint a token for one device and record it.
//
// Two copies are kept, for two different jobs:
//
//   tokenHash — sha256, the authority for "is this token valid". A leaked
//               config file yields nothing usable from this.
//   tokenEnc  — the plaintext, wrapped by the OS keychain. Needed because the
//               signed-request protocol HMACs with the token as the key, and a
//               hash cannot do that. Recoverable on this machine by design, so
//               this file alone is not enough — an attacker needs the keychain
//               too — but it is NOT the same as not storing the token, and the
//               comment here used to claim it was.
//
// The plaintext is returned to the caller exactly once, here.
function issueDeviceToken(configService, { name, platform }, now = Date.now()) {
  const cfg = configService.load()
  const ttlDays = normaliseTtlDays(cfg.mobileTokenTtlDays)
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
  const device = {
    id: crypto.randomUUID(),
    name: String(name || 'Phone').slice(0, 60),
    platform: String(platform || 'unknown').slice(0, 20),
    tokenHash: hashToken(token),
    tokenEnc: configService.encryptSecret ? configService.encryptSecret(token) : undefined,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: ttlDays > 0 ? new Date(now + ttlDays * 86400000).toISOString() : null,
  }
  const devices = listRaw(cfg).concat(device)
  configService.update({ mobileDevices: devices })
  clearSecretsCache()
  return { token, device: publicView(device, now) }
}

function normaliseTtlDays(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TOKEN_TTL_DAYS
  return Math.floor(n) // 0 means "never expires", which is a deliberate choice
}

function listRaw(cfg) {
  return Array.isArray(cfg.mobileDevices) ? cfg.mobileDevices : []
}

function publicView(device, now = Date.now()) {
  const { tokenHash, tokenEnc, ...rest } = device
  return { ...rest, expired: isExpired(device, now) }
}

function isExpired(device, now = Date.now()) {
  if (!device.expiresAt) return false
  return new Date(device.expiresAt).getTime() <= now
}

function listDevices(configService, now = Date.now()) {
  return listRaw(configService.load()).map(d => publicView(d, now))
}

// Match a presented token against the registered devices.
//
// Every candidate is compared even after a match is found, so the time taken
// does not reveal how far down the list the right device sits.
function verifyDeviceToken(configService, token, now = Date.now()) {
  if (!token) return null
  const cfg = configService.load()
  const presented = hashToken(token)
  let matched = null
  for (const device of listRaw(cfg)) {
    if (constantTimeEqual(presented, device.tokenHash) && !isExpired(device, now)) {
      matched = matched || device
    }
  }
  return matched ? publicView(matched, now) : null
}

// The plaintext tokens, for HMAC verification of signed requests.
//
// Cached, because this runs on EVERY signed request and each entry costs an OS
// keychain unwrap — so a phone polling the scan log while a scan runs, or
// anything on the LAN sending forged signatures, drove one keychain round trip
// per registered device per request. The cache is keyed on the wrapped tokens
// themselves, so revoking, pairing or pruning a device changes the key and the
// old entry is never served; `expiresAt` is folded in too, so a token that
// lapses between calls is not kept alive by the cache.
let secretsCache = null // { key, value }

function secretsCacheKey(devices, now) {
  return devices.map(d => `${d.id}:${d.tokenEnc || ''}:${isExpired(d, now) ? 'x' : 'v'}`).join('|')
}

function deviceSecrets(configService, now = Date.now()) {
  const devices = listRaw(configService.load())
  const key = secretsCacheKey(devices, now)
  if (secretsCache && secretsCache.key === key) return secretsCache.value
  const value = devices.filter(d => !isExpired(d, now) && d.tokenEnc).map(d => ({
    device: publicView(d, now),
    token: configService.decryptSecret ? configService.decryptSecret(d.tokenEnc) : d.tokenEnc,
  })).filter(x => x.token)
  secretsCache = { key, value }
  return value
}

// Dropped whenever the device list is rewritten, so a revocation takes effect on
// the next request rather than whenever the key happens to change. The key check
// above would catch it anyway; this makes the intent explicit and means a
// revoked token is never sitting in memory a moment longer than it has to.
function clearSecretsCache() {
  secretsCache = null
}

// Drop devices whose tokens expired a good while ago.
//
// An expired entry is already dead — verifyDeviceToken refuses it and
// deviceSecrets skips it — but it was never removed, so the list grew for the
// life of the profile. That is not just untidy: deviceSecrets runs on every
// signed request and unwraps each surviving tokenEnc through the OS keychain, so
// a long-lived profile pays a keychain decrypt per dead phone per request, and
// the Settings device list fills with entries the user cannot act on.
//
// The grace period is deliberate. A device that expired yesterday should still
// be visible, and named, so "why did my phone stop working" has an answer on
// screen rather than a silent disappearance.
const EXPIRED_GRACE_MS = 30 * 86400000

function pruneExpiredDevices(configService, now = Date.now()) {
  const devices = listRaw(configService.load())
  const keep = devices.filter(d => {
    if (!d.expiresAt) return true
    const expiredAt = new Date(d.expiresAt).getTime()
    if (!Number.isFinite(expiredAt)) return true
    return now - expiredAt < EXPIRED_GRACE_MS
  })
  if (keep.length === devices.length) return { removed: 0 }
  configService.update({ mobileDevices: keep })
  clearSecretsCache()
  return { removed: devices.length - keep.length }
}

// Record that a device was seen, at most once a minute — this runs on every
// authenticated request and each write re-serialises the whole config file.
const TOUCH_INTERVAL_MS = 60 * 1000

function touchDevice(configService, deviceId, now = Date.now()) {
  const cfg = configService.load()
  const devices = listRaw(cfg)
  const device = devices.find(d => d.id === deviceId)
  if (!device) return
  if (device.lastSeenAt && now - new Date(device.lastSeenAt).getTime() < TOUCH_INTERVAL_MS) return
  device.lastSeenAt = new Date(now).toISOString()
  configService.update({ mobileDevices: devices })
}

// Withdraw one device's access. Immediate: the token hash is gone, so the next
// request from that phone fails like any other unknown token.
function revokeDevice(configService, deviceId) {
  const cfg = configService.load()
  const devices = listRaw(cfg)
  const remaining = devices.filter(d => d.id !== deviceId)
  if (remaining.length === devices.length) return { success: false, reason: 'Device not found' }
  configService.update({ mobileDevices: remaining })
  clearSecretsCache()
  return { success: true }
}

function revokeAll(configService) {
  configService.update({ mobileDevices: [] })
  clearSecretsCache()
  return { success: true }
}

module.exports = {
  createPairingCode, getActiveCode, clearPairingCode, consumePairingCode,
  getHello, channelKey,
  issueDeviceToken, verifyDeviceToken, deviceSecrets, listDevices, revokeDevice, revokeAll, touchDevice,
  clearSecretsCache,
  pruneExpiredDevices,
  hashToken, normaliseTtlDays,
  CODE_TTL_MS, DEFAULT_TOKEN_TTL_DAYS, EXPIRED_GRACE_MS,
}
