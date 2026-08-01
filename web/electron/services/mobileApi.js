const http = require('http')
const os = require('os')
const crypto = require('crypto')
const configService = require('./config')
const database = require('./database')
const scheduler = require('./scheduler')
const logger = require('./logger')

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

function authCheck(ip, token) {
  const now = Date.now()
  const entry = failures.get(ip)
  if (entry?.until > now) return { ok: false, retryAfter: Math.ceil((entry.until - now) / 1000) }

  if (timingSafeEqualStr(token, getToken())) {
    failures.delete(ip)
    return { ok: true }
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
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) { req.destroy(); reject(new Error('Body too large')) }
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
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

  const check = authCheck(ip, token)
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
      database.updateApplicationComment(Number(commentMatch[1]), String(body.comment || ''))
      return json(res, 200, { success: true })
    }

    // Queue a scan to run on the desktop. Runs immediately if idle, otherwise
    // as soon as the desktop is free (or on next launch if it's restarted).
    if (req.method === 'POST' && path === '/api/scan') {
      const body = await readBody(req)
      const queued = scheduler.requestScan({
        keywords: typeof body.keywords === 'string' ? body.keywords : '',
        location: typeof body.location === 'string' ? body.location : '',
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
  }
}

module.exports = { start, stop, getInfo, regenerateToken, isPrivateAddress }
