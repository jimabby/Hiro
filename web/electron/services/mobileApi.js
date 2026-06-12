const http = require('http')
const os = require('os')
const crypto = require('crypto')
const configService = require('./config')
const database = require('./database')
const scheduler = require('./scheduler')

// LAN HTTP API for the Hiro mobile companion app (app/ in this repo).
// All data stays on this machine — the phone connects directly over the
// local network using a bearer token shown in Settings → Mobile App.

let server = null

const VALID_STATUSES = ['applied', 'interview', 'rejected', 'offer', 'skipped']

function getToken() {
  const cfg = configService.load()
  if (cfg.mobileApiToken) return cfg.mobileApiToken
  const token = crypto.randomBytes(16).toString('hex')
  configService.save({ ...cfg, mobileApiToken: token })
  return token
}

function regenerateToken() {
  const cfg = configService.load()
  const token = crypto.randomBytes(16).toString('hex')
  configService.save({ ...cfg, mobileApiToken: token })
  return token
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

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
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
  if (!timingSafeEqualStr(token, getToken())) {
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
      let apps = database.getApplications(filters)
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

    if (req.method === 'GET' && path === '/api/attention') {
      return json(res, 200, database.getAttentionJobs())
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

function start() {
  if (server) return getInfo()
  const cfg = configService.load()
  const port = cfg.mobileApiPort || 4823
  getToken() // ensure a token exists before the first client connects

  server = http.createServer((req, res) => { handle(req, res) })
  server.on('error', (err) => {
    console.error('Mobile API server error:', err.message)
    try { server?.close() } catch { /* already closed */ }
    server = null
  })
  server.listen(port, '0.0.0.0')
  return getInfo()
}

function stop() {
  if (server) {
    server.close()
    server = null
  }
  return getInfo()
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

module.exports = { start, stop, getInfo, regenerateToken }
