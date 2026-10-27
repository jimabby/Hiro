const http = require('http')
const os = require('os')
const crypto = require('crypto')
const configService = require('./config')
const pairing = require('./pairing')
const database = require('./database')
const phoneReview = require('./phoneReview')
const scheduler = require('./scheduler')
const logger = require('./logger')
const featureHub = require('./featureHub')
const pairChannel = require('./pairChannel')
const mobileActivity = require('./mobileActivity')

// LAN HTTP API for the Hiro mobile companion app (app/ in this repo).
// All data stays on this machine — the phone connects directly over the
// local network using a bearer token shown in Settings → Mobile App.

let server = null

// Which statuses a phone may set lives in remoteStatus.js, shared with the
// cloud path (database.applyCloudEdit) so the two can never drift apart.
const { remoteStatusRefusal } = require('./remoteStatus')

// The token is read on every single request. Reading it from disk each time
// also meant an OS-keychain decrypt per request, so cache it in memory and
// invalidate explicitly whenever it changes.
let cachedToken = null

// Starts a batch approval on the desktop: (ids, device) → { ok, reason }. Set
// by main.js, which owns the applicator — the same arrangement cloudSync uses
// for onRemoteReview — so this module never requires the submission code.
let approveDrafts = null
function setApproveHandler(fn) { approveDrafts = typeof fn === 'function' ? fn : null }

// The two network-policy switches, cached for the same reason as the token:
// they are consulted on every request, including ones refused before any
// verification, and a config load is a file parse plus keychain unwraps.
// Refreshed on start() and whenever Settings are saved (refreshPolicy).
let policy = null

// Whether the pre-pairing shared token is accepted at all.
//
// It used to default to on, and start() minted one on first launch — so every
// install, including ones that had only ever paired, carried a never-expiring
// credential that travels in cleartext. Now: an explicit setting wins; with no
// setting (a config written before the switch existed) it stays on only for an
// install that already HAS a shared token, so an old phone is not locked out on
// upgrade. A new install has no token and so nothing to accept.
function legacyTokenAllowed(cfg) {
  if (!cfg.mobileApiToken) return false
  if (cfg.mobileApiAllowLegacyToken === true) return true
  if (cfg.mobileApiAllowLegacyToken === false) return false
  return true
}

function refreshPolicy() {
  const cfg = configService.load()
  policy = {
    allowTailscale: !!cfg.mobileApiAllowTailscale,
    allowLegacyToken: legacyTokenAllowed(cfg),
  }
  return policy
}

function currentPolicy() {
  return policy || refreshPolicy()
}

// The shared token, if this install has one. Never minted implicitly any more —
// only regenerateToken() (the user pressing the button) creates one.
function getToken() {
  if (cachedToken) return cachedToken
  const cfg = configService.load()
  cachedToken = cfg.mobileApiToken || null
  return cachedToken || ''
}

function regenerateToken() {
  const token = crypto.randomBytes(16).toString('hex')
  configService.update({ mobileApiToken: token })
  cachedToken = token
  // The phone has probably been failing against the stale token and may be
  // locked out at the exact moment the user re-pairs it — clear the slate.
  failures.clear()
  refreshPolicy()
  return token
}

// Throw the shared token away entirely, for an install whose phones have all
// paired. Unlike switching it off, nothing is left on disk to switch back on.
function clearLegacyToken() {
  configService.update({ mobileApiToken: '' })
  cachedToken = null
  refreshPolicy()
  return { success: true }
}

// ─── Auth throttling ──────────────────────────────────────────────
// The token is 128 bits, so brute force isn't a realistic threat — but an
// unthrottled endpoint on a shared LAN (café, co-working, hotel Wi-Fi) will
// happily service unlimited guesses and fill the log doing it. Lock a peer out
// for a spell after repeated failures.
const MAX_FAILURES = 10
const LOCKOUT_MS = 5 * 60 * 1000
const failures = new Map() // ip -> { count, until }
const seenNonces = new Map()

function signInput(req, timestamp, nonce, rawBody = '') {
  return [req.method, req.url, timestamp, nonce, rawBody].join('\n')
}

// How far a request's timestamp may be from ours before it is refused.
const SIGNATURE_WINDOW_MS = 300000

// Verify a signed request, and say WHY when it fails.
//
// This used to return a bare null for every rejection, and the caller then fell
// through to the bearer-token path — which, for a phone or extension paired with
// the encrypted protocol, means falling through with no bearer token at all. So
// every rejection, whatever its cause, was counted as a failed authentication.
//
// That is right for a bad signature and catastrophic for a wrong clock. A phone
// whose time had drifted past five minutes failed, counted, failed, counted, and
// after ten polls locked ITSELF out for five minutes — then did it again, and
// again, indefinitely, while being told "too many failed attempts". Nothing said
// the clock was the problem, and the one action that fixes it is not one that
// "too many failed attempts" would ever suggest.
//
// So the reasons are distinguished now. A wrong clock and a replayed nonce are
// refused with an explanation and do NOT feed the lockout: neither is evidence
// of anyone guessing a credential, and treating them as such locks out the only
// person who could put it right. A bad or absent signature still counts.
function verifySignedRequest(req, rawBody = '') {
  const timestamp = String(req.headers['x-hiro-timestamp'] || '')
  const nonce = String(req.headers['x-hiro-nonce'] || '')
  const signature = String(req.headers['x-hiro-signature'] || '')

  // No signature headers at all — an unsigned (legacy bearer) request. Not a
  // rejection: there is nothing here to verify.
  if (!timestamp && !nonce && !signature) return { signed: false }

  if (!nonce || !signature || !timestamp) return { signed: true, ok: false, reason: 'malformed' }
  const time = Number(timestamp)
  if (!Number.isFinite(time)) return { signed: true, ok: false, reason: 'malformed' }

  const skewMs = Date.now() - time
  if (Math.abs(skewMs) > SIGNATURE_WINDOW_MS) return { signed: true, ok: false, reason: 'clock', skewMs }

  if (seenNonces.has(nonce)) return { signed: true, ok: false, reason: 'replay' }

  for (const candidate of pairing.deviceSecrets(configService)) {
    const expected = crypto.createHmac('sha256', candidate.token).update(signInput(req, timestamp, nonce, rawBody)).digest('hex')
    if (timingSafeEqualStr(signature, expected)) {
      seenNonces.set(nonce, Date.now())
      pairing.touchDevice(configService, candidate.device.id)
      return { signed: true, ok: true, candidate }
    }
  }
  return { signed: true, ok: false, reason: 'signature' }
}

// Actionable, which is the whole point of separating the reasons: the person
// holding the phone can do something about this one.
function describeSignatureFailure(result) {
  if (result.reason === 'clock') {
    const minutes = Math.round(Math.abs(result.skewMs) / 60000)
    const direction = result.skewMs > 0 ? 'behind' : 'ahead of'
    return `This device's clock is about ${minutes} minute${minutes === 1 ? '' : 's'} ${direction} the desktop's. `
      + 'Signed requests are only accepted inside a five-minute window, so turn on automatic date & time '
      + 'on both machines and try again.'
  }
  if (result.reason === 'replay') {
    return 'That request was already used once and cannot be replayed. '
      + 'This is normal after a retry — the next request will go through.'
  }
  return 'Unauthorized'
}

// Response binding. A client that sends `X-Hiro-Response-Binding: 1` gets its
// reply sealed with the request's method, path and nonce as GCM associated data,
// under a label requests never carry — so a reply cannot be replayed against a
// different request, nor the client's own encrypted request reflected back as
// a reply. Marked `bound: 1`; a client that has seen one refuses unbound replies
// from then on. Clients that do not ask get the unbound envelope as before.
// The format is pinned to the phone's by app/src/responseBinding.js, which
// web/test/secure-mobile-api.test.js requires.
function responseAad(req) {
  if (!req || String(req.headers?.['x-hiro-response-binding'] || '') !== '1') return null
  const nonce = String(req.headers['x-hiro-nonce'] || '')
  if (!nonce) return null
  return ['hiro-response-v1', String(req.method).toUpperCase(), String(req.url), nonce].join('\n')
}

function encryptPayload(token, body, aad = null) {
  const key = crypto.createHash('sha256').update(token).digest(), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()])
  const data = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
  return aad ? { secure: 2, bound: 1, data } : { secure: 2, data }
}

function decryptPayload(token, envelope) {
  if (envelope?.secure !== 2) throw new Error('Encrypted request required.')
  const key = crypto.createHash('sha256').update(token).digest()
  const combined = Buffer.from(envelope.data, 'base64'), iv = combined.subarray(0, 12), tag = combined.subarray(-16), ciphertext = combined.subarray(12, -16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
}

// The identity a lockout is held against.
//
// For IPv4 that is the address. For IPv6 it is the /64: a single host is handed
// a whole /64 by SLAAC and can mint a fresh address from it for every request
// (privacy extensions do exactly that on their own), so keying on the exact
// address meant ten failures bought a lockout that the very next address walked
// straight past.
function lockoutKey(addr) {
  let ip = String(addr || 'unknown')
  if (ip.endsWith('/64')) return ip
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) return ip.slice(7)
  if (!ip.includes(':')) return ip
  const groups = expandIpv6(ip)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip.toLowerCase()
}

// Eight 16-bit groups, lower-case and without leading zeros, or null if the text
// is not an IPv6 address.
function expandIpv6(ip) {
  let text = ip.toLowerCase()
  // A trailing dotted quad (::1.2.3.4 and friends) is two more groups.
  const v4 = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    text = text.slice(0, -v4[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map(g => parseInt(g, 16).toString(16))
}

// Is this peer currently locked out? Read-only: asking must not itself count as
// an attempt, because this is consulted BEFORE any verification work is done.
function lockoutFor(ip, now = Date.now()) {
  const entry = failures.get(lockoutKey(ip))
  if (entry?.until > now) return { locked: true, retryAfter: Math.ceil((entry.until - now) / 1000) }
  return { locked: false }
}

// Count one failed attempt, and start a lockout once there have been enough.
function recordFailure(addr, now = Date.now()) {
  const ip = lockoutKey(addr)
  const entry = failures.get(ip)
  // `until: 0` means "counting failures, not locked out" — only a lockout that
  // has actually expired resets the tally, otherwise the count never grows.
  let count = entry?.count || 0
  if (entry?.until && entry.until <= now) count = 0
  count += 1
  if (count >= MAX_FAILURES) {
    failures.set(ip, { count: 0, until: now + LOCKOUT_MS })
    logger.append(`Mobile API: ${ip} locked out for ${LOCKOUT_MS / 60000} min after ${MAX_FAILURES} failed auth attempts`)
    return { ok: false, retryAfter: Math.ceil(LOCKOUT_MS / 1000) }
  }
  failures.set(ip, { count, until: 0 })
  return { ok: false }
}

function clearFailures(addr) {
  failures.delete(lockoutKey(addr))
}

function authCheck(ip, token) {
  const lockout = lockoutFor(ip)
  if (lockout.locked) return { ok: false, retryAfter: lockout.retryAfter }

  // A paired device presents its own token. Checked first because it is the
  // path every phone should be on; the shared token stays valid so an install
  // that paired before per-device tokens existed keeps working until it is
  // re-paired, rather than silently losing access on upgrade.
  const device = pairing.verifyDeviceToken(configService, token)
  if (device) {
    clearFailures(ip)
    pairing.touchDevice(configService, device.id)
    return { ok: true, device }
  }

  // The shared token predates pairing and is sent in the clear on every
  // request. Once every device has paired it is pure exposure, so it can be
  // switched off — a request presenting it is then just a failed attempt.
  const shared = getToken()
  if (currentPolicy().allowLegacyToken && token && shared && timingSafeEqualStr(token, shared)) {
    clearFailures(ip)
    return { ok: true, legacy: true }
  }

  return recordFailure(ip)
}

// Keep the failure map from growing unboundedly on a hostile network.
setInterval(() => {
  const now = Date.now()
  for (const [ip, e] of failures) {
    if (e.until <= now && e.count === 0) failures.delete(ip)
  }
  for (const [nonce, at] of seenNonces) if (now - at > 600000) seenNonces.delete(nonce)
}, 10 * 60 * 1000).unref?.()

// True only for loopback and the RFC1918 / RFC4193 private ranges the phone
// can legitimately be on. Node reports IPv4 peers over a dual-stack socket as
// "::ffff:192.168.1.5", so unwrap that form before testing.
function isPrivateAddress(addr, { allowTailscale = false } = {}) {
  if (!addr || addr === 'unknown') return false
  let ip = addr
  const zone = ip.indexOf('%') // strip IPv6 scope id, e.g. fe80::1%en0
  if (zone !== -1) ip = ip.slice(0, zone)
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)

  if (ip === '::1' || ip === '127.0.0.1') return true

  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // link-local
    // 100.64.0.0/10 — Tailscale's address space, and also carrier-grade NAT.
    // Only when the user has said they use a tailnet: on a mobile carrier the
    // same range holds strangers.
    if (allowTailscale && a === 100 && b >= 64 && b <= 127) return true
    return false
  }

  const lower = ip.toLowerCase()
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd]/.test(lower) || lower.startsWith('fe80:')) return true
  // Tailscale's IPv6 range, under the same opt-in as its IPv4 one.
  return allowTailscale && lower.startsWith('fd7a:115c:a1e0:')
}

function getLanAddresses() {
  const addresses = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address)
    }
  }
  return addresses
}

// No CORS headers on purpose: the only client is the native mobile app, which
// isn't subject to CORS. Omitting them means a malicious web page on the same
// LAN can't read responses or send JSON POSTs from a browser — defense in
// depth on top of the bearer token.
function json(res, status, body) {
  const data = JSON.stringify(res.secureToken ? encryptPayload(res.secureToken, body, responseAad(res.req)) : body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(data)
}

// Idempotency-Key replay for the writes a phone retries from its offline queue
// (POST /api/scan, /api/import-job). A request can reach the desktop, run, and
// lose its reply on the way back; the phone sees a timeout and sends it again.
// Without this, that retry started a second scan. The same key from the same
// device within a day gets the first answer back instead of running twice.
// Held in memory: a desktop restart forgets the keys, which costs at worst the
// duplicate this exists to prevent, never a lost request.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const IDEMPOTENCY_MAX = 500
const idempotent = new Map() // `${owner}:${key}` → { at, result: Promise<{status, body}> }

function idempotencySlot(req, device) {
  const key = String(req.headers['idempotency-key'] || '')
  if (!/^[a-z0-9-]{1,64}$/i.test(key)) return null
  return `${device?.id || 'shared'}:${key.toLowerCase()}`
}

async function respondOnce(res, slot, run) {
  if (!slot) {
    const { status, body } = await run()
    return json(res, status, body)
  }
  const now = Date.now()
  for (const [k, entry] of idempotent) {
    if (now - entry.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k)
  }
  let entry = idempotent.get(slot)
  if (!entry) {
    // The promise is stored before it settles, so two copies of one request
    // racing each other still run once.
    entry = { at: now, result: run() }
    idempotent.set(slot, entry)
    while (idempotent.size > IDEMPOTENCY_MAX) idempotent.delete(idempotent.keys().next().value)
    // A failure is not an answer worth replaying — let the retry run for real.
    entry.result.catch(() => idempotent.delete(slot))
  }
  const { status, body } = await entry.result
  return json(res, status, body)
}

const MAX_BODY_BYTES = 1e6

// Buffered as bytes, not concatenated as strings.
//
// `raw += chunk` decodes each TCP chunk on its own, so a multi-byte UTF-8
// character split across a chunk boundary becomes two replacement characters.
// That corrupts the body, and because this exact string is the HMAC signing
// input, it shows up as a signature mismatch on a request that was signed
// perfectly well — a failure that would be near-impossible to diagnose from
// either end. The old size guard counted characters too, so the 1 MB cap was
// not the byte limit it claimed to be.
function readRawBody(req) {
  if (req.rawBody !== undefined) return Promise.resolve(req.rawBody)
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) { req.destroy(); reject(new Error('Body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks).toString('utf8')
      resolve(req.rawBody)
    })
    req.on('error', reject)
  })
}

async function readBody(req) {
  const raw = await readRawBody(req)
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    return req.secureToken ? decryptPayload(req.secureToken, parsed) : parsed
  } catch { throw new Error('Invalid JSON or encrypted payload') }
}

// Open a confidential channel for a pairing.
//
// Returns this pairing window's ephemeral public key, a salt, and an HMAC over
// both keyed by the pairing code. The client checks that tag against the code
// the person read off the desktop, which is what stops an active attacker on the
// LAN substituting their own key. Nothing here is secret — see pairChannel.js.
function handlePairHello(res) {
  const hello = pairing.getHello()
  if (!hello) return json(res, 409, { error: 'No pairing code is active. Generate one on the desktop.' })
  return json(res, 200, hello)
}

// Exchange a pairing code for a token belonging to this phone alone.
//
// The token is a 90-day credential and this is the message that carries it, so
// it does not travel in the clear: the request and the reply are both AES-GCM
// encrypted under a key agreed by ECDH (pairChannel.js). Anything on the network
// sees two public keys and ciphertext.
//
// A wrong code counts against the same lockout as a wrong bearer token, so this
// endpoint cannot be used to grind through the code space any faster than the
// authenticated ones can be ground through the token space.
async function handlePair(req, res, ip) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return json(res, 400, { error: err.message })
  }

  // A pre-v2 client pairs in the clear. Still accepted — an installed phone that
  // has not been updated must not be locked out of setting itself up — but said
  // out loud, because the token it is about to receive is readable by anything
  // sharing the network for as long as that exchange takes.
  const secure = body?.v === pairChannel.PROTOCOL_VERSION
  let key = null
  let request = body
  if (secure) {
    try {
      key = pairing.channelKey(body.epk)
      if (!key) throw new Error('No pairing code is active. Generate one on the desktop.')
      request = pairChannel.decrypt(key, body.data)
    } catch (err) {
      // Undecryptable means the wrong code, a stale pairing window, or something
      // in the middle — all of which are failed attempts.
      const check = recordFailure(ip)
      if (check.retryAfter) {
        res.setHeader('Retry-After', String(check.retryAfter))
        return json(res, 429, { error: 'Too many failed attempts — try again later.' })
      }
      return json(res, 400, { error: err.message || 'Could not read the pairing request.' })
    }
  } else {
    logger.append('Mobile API: pairing request used the old cleartext protocol — '
      + 'update the phone app so the device token is not sent unencrypted over the network.')
  }

  const attempt = pairing.consumePairingCode(request.code)
  if (!attempt.ok) {
    const check = recordFailure(ip)
    if (check.retryAfter) {
      res.setHeader('Retry-After', String(check.retryAfter))
      return json(res, 429, { error: 'Too many failed attempts — try again later.' })
    }
    return json(res, 401, { error: attempt.reason })
  }

  const { token, device } = pairing.issueDeviceToken(configService, {
    name: request.deviceName,
    platform: request.platform,
    // From the pairing code, i.e. chosen on the desktop. Anything the device
    // says about its own scopes is ignored.
    scopes: attempt.scopes,
  })
  clearFailures(ip)
  logger.append(`Mobile API: paired "${device.name}" (${device.platform})${secure ? '' : ' over the old cleartext protocol'}`)
  // The token is returned exactly once. Only its hash is kept here.
  const payload = { token, device, host: os.hostname() }
  if (!secure) return json(res, 200, payload)
  return json(res, 200, { v: pairChannel.PROTOCOL_VERSION, data: pairChannel.encrypt(key, payload) })
}

// Strip heavy text fields from list responses — the phone fetches detail separately
function slimApplication(a) {
  const { tailored_resume, cover_letter, screening_qa, job_description, ...rest } = a
  return rest
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// Which scope a request needs. Decided from the method and path alone, before
// any route runs, so a new endpoint is covered by default: a GET needs `read`,
// anything else needs `write`, and the two scan controls need `scan`. The few
// endpoints that concern only the caller's own credential need nothing beyond
// being authenticated.
const SELF_ENDPOINTS = new Set(['/api/ping', '/api/rotate', '/api/devices/self/revoke'])
const SCAN_ENDPOINTS = new Set(['/api/scan', '/api/scan/cancel'])

function requiredScope(method, path) {
  if (SELF_ENDPOINTS.has(path)) return null
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (SCAN_ENDPOINTS.has(path)) return 'scan'
  return 'write'
}

// The server's request handler. Never rejects: anything that escapes the
// routes is logged and answered with a 500, so a malformed request cannot leave
// a socket hanging or surface as an unhandled rejection in the main process.
async function handle(req, res) {
  try {
    await route(req, res)
  } catch (err) {
    logger.append(`Mobile API: ${req.method} request failed — ${err?.stack || err?.message || String(err)}`)
    if (!res.headersSent) {
      try { return json(res, 500, { error: 'The desktop hit an error handling that request. See the activity log for details.' }) } catch { /* fall through */ }
    }
    try { res.destroy() } catch { /* already gone */ }
  }
}

async function route(req, res) {
  // 204 means "no content", so it must not carry a body — json() would send one
  // and set a Content-Length that contradicts the status.
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  // `new URL` throws on a request target such as "http://[" — which used to
  // escape as an unhandled rejection and leave the socket open with no reply.
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { return json(res, 400, { error: 'Bad request' }) }
  const path = url.pathname

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const ip = req.socket.remoteAddress || 'unknown'

  // The server binds to every interface so the phone can find it, which means
  // on a machine with a public address — or behind a forwarded port, or on a
  // hotel/airport network that doesn't isolate clients — it would otherwise
  // answer the open internet. The token travels in cleartext over HTTP, so a
  // reachable endpoint is a harvestable one. Refuse anything that isn't a
  // private-range peer, before the token is even compared.
  if (!isPrivateAddress(ip, { allowTailscale: currentPolicy().allowTailscale })) {
    logger.append(`Mobile API: refused non-local client ${ip}`)
    return json(res, 403, { error: 'Forbidden' })
  }

  // The lockout is checked HERE, before a single byte is verified, and before
  // the pairing endpoint below.
  //
  // It used to sit inside authCheck, which runs after verifySignedRequest — so a
  // locked-out peer still got its signature checked first, and that check reads
  // the config (a file parse plus seven OS-keychain unwraps) and then HMACs the
  // request once per registered device. The lockout therefore gated the REPLY
  // and not the work: an attacker on the LAN could keep a desktop busy doing
  // keychain round trips indefinitely, for the cost of sending garbage. Refusing
  // first makes a locked-out request nearly free to serve.
  const lockout = lockoutFor(ip)
  if (lockout.locked) {
    res.setHeader('Retry-After', String(lockout.retryAfter))
    return json(res, 429, { error: 'Too many failed attempts — try again later.' })
  }

  // Pairing is the one endpoint that cannot require a token, because it is how
  // a token is obtained. It is not unprotected: the private-address and lockout
  // checks above have already run, the pairing code is single-use and expires in
  // minutes, and failed attempts feed the same counter as a bad bearer token.
  if (req.method === 'GET' && path === '/api/pair/hello') {
    return handlePairHello(res)
  }
  if (req.method === 'POST' && path === '/api/pair') {
    return handlePair(req, res, ip)
  }

  try {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) req.rawBody = ''
    else await readRawBody(req)
  } catch (err) { return json(res, 400, { error: err.message }) }

  const signed = verifySignedRequest(req, req.rawBody || '')

  // A wrong clock or a replayed nonce is refused HERE, with the reason, and
  // without touching the lockout counter. Falling through to authCheck would
  // count it as a bad credential — and for a secure client, which sends no
  // bearer token at all, that meant a drifted clock locked the phone out of its
  // own desktop every five minutes forever. See verifySignedRequest.
  if (signed.signed && !signed.ok && (signed.reason === 'clock' || signed.reason === 'replay')) {
    logger.append(`Mobile API: refused a signed request from ${ip} — ${signed.reason === 'clock'
      ? `this device's clock is ${Math.round(signed.skewMs / 1000)}s away from the desktop's`
      : 'the request nonce had already been used'}`)
    return json(res, 401, { error: describeSignatureFailure(signed), reason: signed.reason })
  }

  if (signed.ok) {
    req.secureToken = signed.candidate.token
    res.secureToken = signed.candidate.token
    // A device that just authenticated is not a device that has been guessing.
    // This used to live only inside authCheck, which the signed path skips — so
    // a phone could carry nine stale failures across any number of successful
    // requests and then be locked out by one unrelated blip.
    clearFailures(ip)
  }

  const check = signed.ok ? { ok: true, device: signed.candidate.device } : authCheck(ip, token)
  if (!check.ok) {
    if (check.retryAfter) {
      res.setHeader('Retry-After', String(check.retryAfter))
      return json(res, 429, { error: 'Too many failed attempts — try again later.' })
    }
    return json(res, 401, { error: 'Unauthorized' })
  }

  // Per-device activity, written once the reply has gone out so the status
  // recorded is the one the device actually received.
  if (check.device?.id) {
    const deviceId = check.device.id
    res.once('finish', () => mobileActivity.record(deviceId, { method: req.method, path, ip, status: res.statusCode }))
  }

  // The shared token predates scopes and keeps every one of them; a paired
  // device has what it was granted when it was paired (all three if it paired
  // before scopes existed).
  const scope = requiredScope(req.method, path)
  if (scope && check.device && !pairing.hasScope(check.device, scope)) {
    return json(res, 403, {
      error: `This device is not allowed to ${scope === 'read' ? 'read data' : scope === 'scan' ? 'start or stop scans' : 'make changes'} on the desktop. `
        + 'Change its permissions in Settings → Mobile App.',
      scope,
    })
  }

  try {
    if (req.method === 'GET' && path === '/api/ping') {
      return json(res, 200, { ok: true, app: 'hiro', host: os.hostname(), scopes: check.device ? pairing.deviceScopes(check.device) : pairing.SCOPES })
    }

    // Exchange this device's token for a fresh one with a new expiry, without
    // re-pairing. Signed requests only: the reply carries the new token, so it
    // has to travel encrypted, and only the signed protocol has a key for that.
    // The old token stops working once the reply has been handed to the socket;
    // if the connection drops before then, nothing changes and the old token
    // stays valid for another attempt.
    if (req.method === 'POST' && path === '/api/rotate') {
      if (!signed.ok || !check.device) {
        return json(res, 400, { error: 'Token rotation needs a signed request from a paired device.' })
      }
      const rotation = pairing.prepareRotation(configService, check.device.id)
      if (!rotation) return json(res, 404, { error: 'This device is no longer paired.' })
      let flushed = false
      res.once('finish', () => {
        flushed = true
        if (rotation.commit()) logger.append(`Mobile API: "${check.device.name}" rotated its token`)
      })
      res.once('close', () => {
        if (!flushed) logger.append(`Mobile API: token rotation for "${check.device.name}" was not delivered — the old token stays valid`)
      })
      return json(res, 200, { token: rotation.token, device: rotation.device, expiresAt: rotation.device.expiresAt })
    }

    // A device withdrawing its own access — the extension's "Forget pairing",
    // or a phone being signed out. Without this, forgetting only deleted the
    // local copy and left a valid 90-day token behind on the desktop.
    if (req.method === 'POST' && path === '/api/devices/self/revoke') {
      if (!check.device) return json(res, 400, { error: 'The shared token cannot be revoked from a device. Turn it off in Settings.' })
      const result = pairing.revokeDevice(configService, check.device.id)
      // After the reply, so the activity entry for this very request (recorded
      // on 'finish' too, by a listener registered earlier) goes with the rest.
      const revokedId = check.device.id
      res.once('finish', () => mobileActivity.forget(revokedId))
      logger.append(`Mobile API: "${check.device.name}" revoked its own pairing`)
      return json(res, 200, { success: !!result.success })
    }

    if (req.method === 'GET' && path === '/api/stats') {
      return json(res, 200, database.getStats())
    }

    // Used by the optional browser extension. It pairs as its own revocable
    // device and uses the same signed/encrypted protocol as a newly paired
    // phone; no shared bearer token is embedded in the extension.
    if (req.method === 'POST' && path === '/api/import-job') {
      const body = await readBody(req)
      return respondOnce(res, idempotencySlot(req, check.device), async () => {
        const result = featureHub.importJob(body)
        return { status: result?.success === false ? 400 : 200, body: result }
      })
    }

    if (req.method === 'GET' && path === '/api/applications') {
      const filters = {}
      if (url.searchParams.get('status')) filters.status = url.searchParams.get('status')
      if (url.searchParams.get('platform')) filters.platform = url.searchParams.get('platform')
      // The slim query already omits the document columns, so slimApplication
      // below is now belt-and-braces rather than the thing doing the work.
      let apps = database.getApplicationsList(filters)
      const search = (url.searchParams.get('search') || '').toLowerCase()
      if (search) {
        apps = apps.filter(a =>
          (a.job_title || '').toLowerCase().includes(search) ||
          (a.company || '').toLowerCase().includes(search))
      }
      return json(res, 200, apps.map(slimApplication))
    }

    const detailMatch = path.match(/^\/api\/applications\/(\d+)$/)
    if (req.method === 'GET' && detailMatch) {
      const app = database.getApplication(Number(detailMatch[1]))
      if (!app) return json(res, 404, { error: 'Not found' })
      return json(res, 200, app)
    }

    const statusMatch = path.match(/^\/api\/applications\/(\d+)\/status$/)
    if (req.method === 'POST' && statusMatch) {
      const body = await readBody(req)
      const refusal = remoteStatusRefusal(body.status)
      if (refusal) return json(res, 400, { error: refusal })
      database.updateApplicationStatus(Number(statusMatch[1]), body.status)
      return json(res, 200, { success: true })
    }

    const commentMatch = path.match(/^\/api\/applications\/(\d+)\/comment$/)
    if (req.method === 'POST' && commentMatch) {
      const body = await readBody(req)
      database.updateApplicationComment(Number(commentMatch[1]), String(body.comment || '').slice(0, 5000))
      return json(res, 200, { success: true })
    }

    // The follow-up date and note behind the desktop's Pipeline board. Writable
    // from the phone: deciding "chase them Thursday" is exactly the sort of thing
    // done away from the desk, and it needs no browser session.
    const checklistMatch = path.match(/^\/api\/applications\/(\d+)\/checklist$/)
    if (checklistMatch && req.method === 'GET') {
      return json(res, 200, database.getChecklist(Number(checklistMatch[1])))
    }
    if (checklistMatch && req.method === 'POST') {
      try { return json(res, 200, database.updateChecklist(Number(checklistMatch[1]), await readBody(req))) }
      catch (err) { return json(res, 400, { error: err.message }) }
    }

    const nextActionMatch = path.match(/^\/api\/applications\/(\d+)\/next-action$/)
    if (req.method === 'POST' && nextActionMatch) {
      const body = await readBody(req)
      const result = database.setNextAction(Number(nextActionMatch[1]), {
        date: body.date ?? null,
        note: typeof body.note === 'string' ? body.note.slice(0, 1000) : '',
      })
      // setNextAction rejects a malformed date rather than storing it; report
      // that as a 400 instead of a silent success.
      return json(res, result.success ? 200 : 400, result)
    }

    const nextActionDoneMatch = path.match(/^\/api\/applications\/(\d+)\/next-action\/done$/)
    if (req.method === 'POST' && nextActionDoneMatch) {
      return json(res, 200, database.completeNextAction(Number(nextActionDoneMatch[1])))
    }

    if (req.method === 'GET' && path === '/api/next-actions') {
      return json(res, 200, database.getDueNextActions())
    }

    // The desktop's task inbox, for the phone's Today screen — one read instead
    // of a checklist request per application. Read scope (a GET; see
    // requiredScope). A phone talking to an older desktop gets a 404 and builds
    // the list itself (app/src/todayLoader.js).
    if (req.method === 'GET' && path === '/api/tasks') {
      return json(res, 200, featureHub.taskInbox())
    }

    // Queue a scan to run on the desktop. Runs immediately if idle, otherwise
    // as soon as the desktop is free (or on next launch if it's restarted).
    if (req.method === 'POST' && path === '/api/scan') {
      const body = await readBody(req)
      return respondOnce(res, idempotencySlot(req, check.device), async () => {
        const queued = scheduler.requestScan({
          keywords: typeof body.keywords === 'string' ? body.keywords.slice(0, 500) : '',
          location: typeof body.location === 'string' ? body.location.slice(0, 160) : '',
          source: 'mobile',
        })
        return { status: 200, body: { queued: true, id: queued.id, ...scheduler.getScanInfo() } }
      })
    }

    if (req.method === 'GET' && path === '/api/scan/status') {
      return json(res, 200, scheduler.getScanInfo())
    }

    if (req.method === 'POST' && path === '/api/scan/cancel') {
      scheduler.cancelScan()
      return json(res, 200, { cancelled: true, ...scheduler.getScanInfo() })
    }

    // Recent activity-log lines (oldest → newest), so the phone can show a
    // live feed of what the desktop is doing while a scan runs.
    if (req.method === 'GET' && path === '/api/logs') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40))
      return json(res, 200, { lines: logger.tail(limit) })
    }

    if (req.method === 'GET' && path === '/api/attention') {
      return json(res, 200, database.getAttentionJobs())
    }

    // Applications review mode is holding back. The phone can see what is
    // waiting and reject a bad draft, but approving means submitting — which
    // needs the desktop's browser session, so that stays a desktop action.
    if (req.method === 'GET' && path === '/api/held') {
      return json(res, 200, database.getHeldApplications())
    }

    // Approve several drafts from the phone. The desktop submits them, spaced
    // the way it spaces any bulk approval, and replies as soon as the run has
    // started — submissions take minutes and the phone polls /api/held. See
    // phoneReview.js for which drafts qualify and which devices may ask.
    if (req.method === 'POST' && path === '/api/held/approve') {
      if (!phoneReview.deviceMayApprove(check.device)) {
        return json(res, 403, { error: 'Only a paired phone can approve drafts. Re-pair this phone if it was set up before pairing existed.' })
      }
      if (!approveDrafts) return json(res, 503, { error: 'Approving from the phone is not available in this build.' })
      const body = await readBody(req)
      const { accepted, refused } = phoneReview.partition(body?.ids)
      if (!accepted.length) return json(res, 200, { started: false, accepted, refused })
      const started = approveDrafts(accepted, check.device)
      if (!started.ok) return json(res, 409, { error: started.reason, accepted: [], refused })
      logger.append(`Mobile API: "${check.device.name}" approved ${accepted.length} draft(s)`)
      return json(res, 202, { started: true, accepted, refused })
    }

    const rejectMatch = path.match(/^\/api\/held\/(\d+)\/reject$/)
    if (req.method === 'POST' && rejectMatch) {
      return json(res, 200, database.rejectHeldApplication(Number(rejectMatch[1])))
    }

    // Model spend, so a runaway scan is visible from the phone too.
    if (req.method === 'GET' && path === '/api/ai-usage') {
      return json(res, 200, database.getAiUsageSummary())
    }

    // The interview brief, from what the desktop has already prepared. Never
    // generates: a tap on the phone must not spend money on the desktop's key.
    const briefMatch = path.match(/^\/api\/applications\/(\d+)\/brief$/)
    if (req.method === 'GET' && briefMatch) {
      const brief = await require('./interviewBrief').buildBrief(Number(briefMatch[1]), { generate: false })
      return json(res, 200, brief)
    }

    if (req.method === 'GET' && path === '/api/interviews') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25))
      return json(res, 200, database.getUpcomingInterviews(limit))
    }

    if (req.method === 'GET' && path === '/api/salary') {
      return json(res, 200, database.getSalaryStats())
    }

    // Read-only on purpose. The phone shows what the offers are and when they
    // expire — the deadline is the reason this exists — but accepting or
    // declining, and the negotiation draft, stay on the desktop. Those are not
    // decisions to take one-handed on a train.
    if (req.method === 'GET' && path === '/api/offers') {
      return json(res, 200, database.getOffers())
    }

    if (req.method === 'GET' && path === '/api/perday') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7))
      return json(res, 200, database.getApplicationsPerDay(days))
    }

    return json(res, 404, { error: 'Not found' })
  } catch (err) {
    // The detail goes to the log, not down the wire. A raw err.message here is
    // a SQLite error string, a file path inside the user's home directory, or a
    // stack-shaped fragment naming internals — none of which the phone can act
    // on, and all of which are free reconnaissance for anything on the LAN that
    // reached this far. The log is where the user (and only the user) can see it.
    logger.append(`Mobile API: ${req.method} ${path} failed — ${err?.stack || err?.message || String(err)}`)
    return json(res, 500, { error: 'The desktop hit an error handling that request. See the activity log for details.' })
  }
}

// Resolves once the server is actually listening (or failed), so callers and
// the Settings UI don't see running:true for a port that was already taken.
function start() {
  if (server) return getInfo()
  const cfg = configService.load()
  const port = cfg.mobileApiPort || 4823
  // No shared token is minted here any more: pairing is how a device gets
  // access, and an install that never had a shared token never needs one.
  cachedToken = null
  refreshPolicy()
  // Long-dead device entries cost a keychain unwrap on every signed request.
  try {
    const { removed } = pairing.pruneExpiredDevices(configService)
    if (removed) logger.append(`Mobile API: removed ${removed} long-expired device${removed === 1 ? '' : 's'} from the pairing list`)
  } catch { /* pruning is housekeeping — never block the server on it */ }

  const srv = http.createServer((req, res) => { handle(req, res).catch(() => {}) })
  server = srv
  return new Promise((resolve) => {
    let settled = false
    srv.on('error', (err) => {
      console.error('Mobile API server error:', err.message)
      try { srv.close() } catch { /* already closed */ }
      if (server === srv) server = null
      if (!settled) { settled = true; resolve({ ...getInfo(), error: err.message }) }
    })
    srv.listen(port, '0.0.0.0', () => {
      if (!settled) { settled = true; resolve(getInfo()) }
    })
  })
}

// Turning the mobile API off has to actually cut the phone off. server.close()
// alone only stops NEW connections — an already-connected phone keeps its
// keep-alive socket and carries on making authenticated requests. And clearing
// `server` synchronously made getInfo() report running:false while the port was
// still bound, so re-enabling immediately hit EADDRINUSE.
function stop() {
  const srv = server
  if (!srv) return getInfo()
  server = null
  return new Promise((resolve) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve(getInfo()) } }
    srv.close(finish)
    // Drop live keep-alive sockets, or close() waits for each client to
    // disconnect on its own and the callback may never fire.
    try { srv.closeAllConnections?.() } catch { /* older Node */ }
    // Never let a stuck socket hang the caller (the Settings toggle awaits it).
    setTimeout(finish, 3000).unref?.()
  })
}

function getInfo() {
  const cfg = configService.load()
  return {
    enabled: !!cfg.mobileApiEnabled,
    running: !!server,
    port: cfg.mobileApiPort || 4823,
    token: cfg.mobileApiToken || '',
    hasLegacyToken: !!cfg.mobileApiToken,
    addresses: getLanAddresses(),
    // Paired phones, each with its own token. The shared token above is kept
    // only so installs that paired before this existed keep working.
    devices: pairing.listDevices(configService),
    tokenTtlDays: pairing.normaliseTtlDays(cfg.mobileTokenTtlDays),
    allowLegacyToken: legacyTokenAllowed(cfg),
    scopes: pairing.SCOPES,
    allowTailscale: !!cfg.mobileApiAllowTailscale,
    pairingCode: pairing.getActiveCode(),
  }
}

// Start a pairing window. The code is short-lived and single-use, so this is
// safe to leave on screen for the minute it takes to point a phone at it.
function startPairing({ scopes } = {}) {
  const issued = pairing.createPairingCode(Date.now(), { scopes })
  const info = getInfo()
  // What the QR encodes. The phone needs all three or the code is useless — an
  // address it cannot reach is not a pairing.
  //
  // The version is bumped to 2 to say the desktop can pair over an encrypted
  // channel, but the FIELDS are unchanged on purpose: the key material is
  // fetched from /api/pair/hello rather than carried here, so the typed-code
  // path and the scanned path run exactly the same protocol, and an older phone
  // reading this QR still finds the host, port and code it expects.
  const payload = JSON.stringify({
    v: 2,
    host: info.addresses[0] || '127.0.0.1',
    port: info.port,
    code: issued.code,
  })
  return { ...issued, payload, addresses: info.addresses, port: info.port }
}

function cancelPairing() {
  pairing.clearPairingCode()
  return { success: true }
}

module.exports = {
  startPairing, cancelPairing,
  listDevices: () => pairing.listDevices(configService),
  revokeDevice: (id) => {
    const result = pairing.revokeDevice(configService, id)
    if (result.success) mobileActivity.forget(id)
    return result
  },
  revokeAllDevices: () => {
    mobileActivity.forgetAll()
    return pairing.revokeAll(configService)
  },
  setDeviceScopes: (id, scopes) => pairing.setDeviceScopes(configService, id, scopes),
  deviceActivity: (id) => mobileActivity.list(id),
  start, stop, getInfo, regenerateToken, clearLegacyToken, isPrivateAddress, refreshPolicy, setApproveHandler,
  // exported for tests
  lockoutFor, recordFailure, lockoutKey, requiredScope, verifySignedRequest, describeSignatureFailure, handle,
  _resetThrottle: () => { failures.clear(); seenNonces.clear() },
}
