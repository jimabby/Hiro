const http = require('http')
const os = require('os')
const crypto = require('crypto')
const configService = require('./config')
const pairing = require('./pairing')
const database = require('./database')
const scheduler = require('./scheduler')
const logger = require('./logger')
const featureHub = require('./featureHub')

// LAN HTTP API for the Hiro mobile companion app (app/ in this repo).
// All data stays on this machine — the phone connects directly over the
// local network using a bearer token shown in Settings → Mobile App.

let server = null

// Must cover every status the desktop can write, or the phone can see a status
// it isn't allowed to set back. 'pending' comes from the inbox classifier and
// 'no_response' from the stale sweep; both were missing here.
const VALID_STATUSES = ['applied', 'interview', 'rejected', 'offer', 'pending', 'no_response', 'skipped', 'held']

// The token is read on every single request. Reading it from disk each time
// also meant an OS-keychain decrypt per request, so cache it in memory and
// invalidate explicitly whenever it changes.
let cachedToken = null

function getToken() {
  if (cachedToken) return cachedToken
  const cfg = configService.load()
  if (cfg.mobileApiToken) {
    cachedToken = cfg.mobileApiToken
    return cachedToken
  }
  const token = crypto.randomBytes(16).toString('hex')
  configService.update({ mobileApiToken: token })
  cachedToken = token
  return token
}

function regenerateToken() {
  const token = crypto.randomBytes(16).toString('hex')
  configService.update({ mobileApiToken: token })
  cachedToken = token
  // The phone has probably been failing against the stale token and may be
  // locked out at the exact moment the user re-pairs it — clear the slate.
  failures.clear()
  return token
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

function verifySignedRequest(req, rawBody = '') {
  const timestamp = String(req.headers['x-hiro-timestamp'] || '')
  const nonce = String(req.headers['x-hiro-nonce'] || '')
  const signature = String(req.headers['x-hiro-signature'] || '')
  const time = Number(timestamp)
  if (!nonce || !signature || !Number.isFinite(time) || Math.abs(Date.now() - time) > 300000 || seenNonces.has(nonce)) return null
  for (const candidate of pairing.deviceSecrets(configService)) {
    const expected = crypto.createHmac('sha256', candidate.token).update(signInput(req, timestamp, nonce, rawBody)).digest('hex')
    if (timingSafeEqualStr(signature, expected)) {
      seenNonces.set(nonce, Date.now())
      pairing.touchDevice(configService, candidate.device.id)
      return candidate
    }
  }
  return null
}

function encryptPayload(token, body) {
  const key = crypto.createHash('sha256').update(token).digest(), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()])
  return { secure: 2, data: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64') }
}

function decryptPayload(token, envelope) {
  if (envelope?.secure !== 2) throw new Error('Encrypted request required.')
  const key = crypto.createHash('sha256').update(token).digest()
  const combined = Buffer.from(envelope.data, 'base64'), iv = combined.subarray(0, 12), tag = combined.subarray(-16), ciphertext = combined.subarray(12, -16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
}

function authCheck(ip, token) {
  const now = Date.now()
  const entry = failures.get(ip)
  if (entry?.until > now) return { ok: false, retryAfter: Math.ceil((entry.until - now) / 1000) }

  // A paired device presents its own token. Checked first because it is the
  // path every phone should be on; the shared token stays valid so an install
  // that paired before per-device tokens existed keeps working until it is
  // re-paired, rather than silently losing access on upgrade.
  const device = pairing.verifyDeviceToken(configService, token)
  if (device) {
    failures.delete(ip)
    pairing.touchDevice(configService, device.id)
    return { ok: true, device }
  }

  if (timingSafeEqualStr(token, getToken())) {
    failures.delete(ip)
    return { ok: true, legacy: true }
  }

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
function isPrivateAddress(addr) {
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
    return false
  }

  const lower = ip.toLowerCase()
  // fc00::/7 unique-local and fe80::/10 link-local.
  return /^f[cd]/.test(lower) || lower.startsWith('fe80:')
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
  const data = JSON.stringify(res.secureToken ? encryptPayload(res.secureToken, body) : body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(data)
}

function readRawBody(req) {
  if (req.rawBody !== undefined) return Promise.resolve(req.rawBody)
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) { req.destroy(); reject(new Error('Body too large')) }
    })
    req.on('end', () => {
      req.rawBody = raw
      resolve(raw)
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

// Exchange a pairing code for a token belonging to this phone alone.
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

  const attempt = pairing.consumePairingCode(body.code)
  if (!attempt.ok) {
    const check = authCheck(ip, '') // deliberately fails: records the attempt
    if (check.retryAfter) {
      res.setHeader('Retry-After', String(check.retryAfter))
      return json(res, 429, { error: 'Too many failed attempts — try again later.' })
    }
    return json(res, 401, { error: attempt.reason })
  }

  const { token, device } = pairing.issueDeviceToken(configService, {
    name: body.deviceName,
    platform: body.platform,
  })
  failures.delete(ip)
  logger.append(`Mobile API: paired "${device.name}" (${device.platform})`)
  // The token is returned exactly once. Only its hash is kept here.
  return json(res, 200, { token, device, host: os.hostname() })
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

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {})

  const url = new URL(req.url, 'http://localhost')
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
  if (!isPrivateAddress(ip)) {
    logger.append(`Mobile API: refused non-local client ${ip}`)
    return json(res, 403, { error: 'Forbidden' })
  }

  // Pairing is the one endpoint that cannot require a token, because it is how
  // a token is obtained. It is not unprotected: the private-address check above
  // has already run, the pairing code is single-use and expires in minutes, and
  // failed attempts feed the same lockout counter as a bad bearer token.
  if (req.method === 'POST' && path === '/api/pair') {
    return handlePair(req, res, ip)
  }

  try {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) req.rawBody = ''
    else await readRawBody(req)
  } catch (err) { return json(res, 400, { error: err.message }) }

  const signed = verifySignedRequest(req, req.rawBody || '')
  if (signed) {
    req.secureToken = signed.token
    res.secureToken = signed.token
  }
  const check = signed ? { ok: true, device: signed.device } : authCheck(ip, token)
  if (!check.ok) {
    if (check.retryAfter) {
      res.setHeader('Retry-After', String(check.retryAfter))
      return json(res, 429, { error: 'Too many failed attempts — try again later.' })
    }
    return json(res, 401, { error: 'Unauthorized' })
  }

  try {
    if (req.method === 'GET' && path === '/api/ping') {
      return json(res, 200, { ok: true, app: 'hiro', host: os.hostname() })
    }

    if (req.method === 'GET' && path === '/api/stats') {
      return json(res, 200, database.getStats())
    }

    // Used by the optional browser extension. It pairs as its own revocable
    // device and uses the same signed/encrypted protocol as a newly paired
    // phone; no shared bearer token is embedded in the extension.
    if (req.method === 'POST' && path === '/api/import-job') {
      const body = await readBody(req)
      const result = featureHub.importJob(body)
      return json(res, result?.success === false ? 400 : 200, result)
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
      if (!VALID_STATUSES.includes(body.status)) {
        return json(res, 400, { error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
      }
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

    // Queue a scan to run on the desktop. Runs immediately if idle, otherwise
    // as soon as the desktop is free (or on next launch if it's restarted).
    if (req.method === 'POST' && path === '/api/scan') {
      const body = await readBody(req)
      const queued = scheduler.requestScan({
        keywords: typeof body.keywords === 'string' ? body.keywords.slice(0, 500) : '',
        location: typeof body.location === 'string' ? body.location.slice(0, 160) : '',
        source: 'mobile',
      })
      return json(res, 200, { queued: true, id: queued.id, ...scheduler.getScanInfo() })
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

    const rejectMatch = path.match(/^\/api\/held\/(\d+)\/reject$/)
    if (req.method === 'POST' && rejectMatch) {
      return json(res, 200, database.rejectHeldApplication(Number(rejectMatch[1])))
    }

    // Model spend, so a runaway scan is visible from the phone too.
    if (req.method === 'GET' && path === '/api/ai-usage') {
      return json(res, 200, database.getAiUsageSummary())
    }

    if (req.method === 'GET' && path === '/api/interviews') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25))
      return json(res, 200, database.getUpcomingInterviews(limit))
    }

    if (req.method === 'GET' && path === '/api/salary') {
      return json(res, 200, database.getSalaryStats())
    }

    if (req.method === 'GET' && path === '/api/perday') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7))
      return json(res, 200, database.getApplicationsPerDay(days))
    }

    return json(res, 404, { error: 'Not found' })
  } catch (err) {
    return json(res, 500, { error: err.message })
  }
}

// Resolves once the server is actually listening (or failed), so callers and
// the Settings UI don't see running:true for a port that was already taken.
function start() {
  if (server) return getInfo()
  const cfg = configService.load()
  const port = cfg.mobileApiPort || 4823
  getToken() // ensure a token exists before the first client connects

  const srv = http.createServer((req, res) => { handle(req, res) })
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
    addresses: getLanAddresses(),
    // Paired phones, each with its own token. The shared token above is kept
    // only so installs that paired before this existed keep working.
    devices: pairing.listDevices(configService),
    tokenTtlDays: pairing.normaliseTtlDays(cfg.mobileTokenTtlDays),
    pairingCode: pairing.getActiveCode(),
  }
}

// Start a pairing window. The code is short-lived and single-use, so this is
// safe to leave on screen for the minute it takes to point a phone at it.
function startPairing() {
  const issued = pairing.createPairingCode()
  const info = getInfo()
  // What the QR encodes. The phone needs all three or the code is useless — an
  // address it cannot reach is not a pairing.
  const payload = JSON.stringify({
    v: 1,
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
  revokeDevice: (id) => pairing.revokeDevice(configService, id),
  revokeAllDevices: () => pairing.revokeAll(configService),
  start, stop, getInfo, regenerateToken, isPrivateAddress,
}
