const https = require('https')
const http = require('http')
const dns = require('dns')
const net = require('net')
const crypto = require('crypto')
const { URL } = require('url')
const configService = require('./config')

// A webhook reply is only ever read for its status code and, when a test fails,
// for a line or two of explanation. It used to be accumulated without any limit
// at all, so a misconfigured URL pointing at something that streams — or an
// endpoint that simply answers with a large page — pulled unbounded bytes into
// the main process, which is the one process whose death takes the scan, the
// tray icon and the scheduler with it. Keep enough to explain a failure and
// discard the rest.
const MAX_RESPONSE_BYTES = 8192

// ─── Generic webhook targets ─────────────────────────────────────
//
// Discord and Slack URLs point at Discord and Slack. A generic webhook points
// wherever the user typed — which makes it a way to have the desktop send
// requests into its own network: the router's admin page, a printer, a service
// on localhost that trusts anything from 127.0.0.1. So loopback, link-local and
// private targets are refused for generic webhooks unless the user ticked the
// box saying that is what they meant (a home-lab receiver is a legitimate use).
//
// The check runs against what the hostname RESOLVES to, every time, not only on
// the literal text: a public name can be pointed at 127.0.0.1.
function isPrivateTarget(address) {
  let ip = String(address || '').toLowerCase()
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7)
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT / Tailscale
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip)
  }
  return false
}

async function assertPublicTarget(url, { lookup = dns.promises.lookup } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw privateTargetError(host)
  }
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address)
  if (addresses.some(isPrivateTarget)) throw privateTargetError(host)
}

// The same check again at connect time, as the socket's DNS lookup. The
// pre-check above gives a clear error; this one closes the gap between the two
// lookups, where a name with a short TTL could answer differently the second
// time (DNS rebinding).
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : (options || {})
  const cb = typeof options === 'function' ? options : callback
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err)
    const list = Array.isArray(address) ? address.map(a => a.address) : [address]
    if (list.some(isPrivateTarget)) return cb(privateTargetError(hostname))
    cb(null, address, family)
  })
}

function privateTargetError(host) {
  const err = new Error(`${host} is on this computer or a private network. Tick "Allow private network address" on this webhook if that is intended.`)
  err.code = 'PRIVATE_TARGET'
  return err
}

// ─── Signing ──────────────────────────────────────────────────────
//
// A generic webhook receiver has no way to tell Hiro's request from anyone
// else's unless it is signed. Each webhook gets its own secret when it is
// created; the signature is HMAC-SHA256 over `${timestamp}.${rawBody}`, so a
// captured request cannot be replayed later with a fresh timestamp.
//
//   X-Hiro-Timestamp: <unix seconds>
//   X-Hiro-Signature: sha256=<hex>
function newSecret() {
  return crypto.randomBytes(32).toString('hex')
}

function sign(secret, timestamp, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${rawBody}`).digest('hex')
}

function post(webhookUrl, payload, { headers: extraHeaders = {}, rawBody, lookup } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(new Error(`Webhook URL must be http or https, not "${url.protocol}"`))
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const data = rawBody ?? JSON.stringify(payload)
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extraHeaders },
      ...(lookup ? { lookup } : {}),
    }, res => {
      let body = ''
      let truncated = false
      res.on('data', c => {
        if (body.length >= MAX_RESPONSE_BYTES) {
          // Stop reading rather than merely stop storing: a sender that is
          // never given backpressure keeps sending.
          if (!truncated) { truncated = true; res.destroy() }
          return
        }
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, MAX_RESPONSE_BYTES), truncated }))
      // destroy() above ends the response with an error rather than an 'end'.
      // The status line has already arrived, which is the part that matters.
      res.on('close', () => resolve({ status: res.statusCode, body: body.slice(0, MAX_RESPONSE_BYTES), truncated }))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Webhook timeout')) })
    req.write(data)
    req.end()
  })
}

// ─── Escaping scraped text ───────────────────────────────────────
//
// Job titles, company names and rejection reasons are scraped from pages
// written by strangers. In Slack mrkdwn `<!channel>` pings the whole channel
// and `<https://evil|Click>` is a disguised link; in Discord, @everyone and
// @here ping everyone. A listing titled accordingly would do exactly that.

// Slack's own rule: escape &, < and >, and nothing else.
function slackEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDiscord(type, data) {
  const color = type === 'attention' ? 0xF59E0B : type === 'scan-complete' ? 0x10B981 : type === 'inbox-reply' ? 0x3B82F6 : 0x6366F1
  const embed = { color, timestamp: new Date().toISOString() }

  if (type === 'attention') {
    embed.title = `Needs Attention: ${data.job_title}`
    embed.description = `**${data.company}** — ${data.platform}\nMatch: ${data.match_score || '?'}%`
    if (data.reason) embed.fields = [{ name: 'Reason', value: data.reason }]
  } else if (type === 'scan-complete') {
    embed.title = 'Scan Complete'
    embed.description = data.message || 'Job scan finished'
  } else if (type === 'inbox-reply') {
    embed.title = `Reply from ${data.company || 'Unknown'}`
    embed.description = `Status updated to **${data.newStatus || 'unknown'}**`
  } else if (type === 'weekly-report') {
    embed.title = 'Weekly Application Report'
    embed.description = `**${data.totalApps || 0}** applications this week\nResponse rate: ${data.responseRate || 0}%`
  }

  // No mention in a Hiro message is ever meant to notify anyone, so none is
  // allowed to: this disables @everyone, @here, user and role pings at once,
  // whatever text the scraped fields carry.
  return { embeds: [embed], allowed_mentions: { parse: [] } }
}

function formatSlack(type, data) {
  const blocks = []
  const e = slackEscape

  if (type === 'attention') {
    // plain_text is never parsed for mentions or links, so it is left as is —
    // escaping it would show a literal "&lt;" in the header.
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `Needs Attention: ${data.job_title}` } })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${e(data.company)}* — ${e(data.platform)} | Match: ${e(data.match_score || '?')}%${data.reason ? `\n${e(data.reason)}` : ''}` } })
  } else if (type === 'scan-complete') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *Scan Complete* — ${e(data.message || 'Job scan finished')}` } })
  } else if (type === 'inbox-reply') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:email: *Reply from ${e(data.company || 'Unknown')}* — Status: ${e(data.newStatus || 'unknown')}` } })
  } else if (type === 'weekly-report') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:bar_chart: *Weekly Report* — ${e(data.totalApps || 0)} applications | Response rate: ${e(data.responseRate || 0)}%` } })
  }

  return { blocks }
}

// A generic webhook gets the event as data, not as chat formatting.
function formatGeneric(type, data) {
  return { event: type, sentAt: new Date().toISOString(), data: data || {} }
}

// Send one event to one webhook. Generic webhooks are signed and their target
// checked; Discord and Slack go to their own services.
async function deliver(wh, type, data, { lookup } = {}) {
  const provider = wh.provider || 'discord'
  if (provider !== 'generic') {
    const payload = provider === 'slack' ? formatSlack(type, data) : formatDiscord(type, data)
    return post(wh.url, payload)
  }
  const url = new URL(wh.url)
  if (!wh.allowPrivateNetwork) await assertPublicTarget(url, { lookup })
  if (!wh.secret) throw new Error('This webhook has no signing secret yet — save Settings to create one.')
  const rawBody = JSON.stringify(formatGeneric(type, data))
  const timestamp = String(Math.floor(Date.now() / 1000))
  return post(wh.url, null, {
    rawBody,
    lookup: wh.allowPrivateNetwork ? undefined : guardedLookup,
    headers: {
      'X-Hiro-Event': type,
      'X-Hiro-Timestamp': timestamp,
      'X-Hiro-Signature': sign(wh.secret, timestamp, rawBody),
    },
  })
}

async function send(type, data) {
  const cfg = configService.load()
  const webhooks = cfg.webhooks || []

  for (const wh of webhooks) {
    if (!wh.enabled || !wh.url) continue
    if (wh.events && !wh.events.includes(type)) continue

    try {
      await deliver(wh, type, data)
    } catch { /* non-critical */ }
  }
}

// `wh` is the webhook as stored (with its secret), or { provider, url } for one
// being tried before it was saved.
async function test(provider, url, wh = null) {
  const target = { ...(wh || {}), provider: provider || wh?.provider || 'discord', url }
  if (target.provider === 'generic' && !target.secret) {
    throw new Error('Save Settings first so this webhook has a signing secret to test with.')
  }
  const result = await deliver(target, 'scan-complete', { message: 'Test notification from Hiro' })
  return result.status >= 200 && result.status < 300
}

module.exports = {
  send, test, newSecret, sign,
  // exported for tests
  formatSlack, formatDiscord, formatGeneric, slackEscape, isPrivateTarget, assertPublicTarget, deliver,
}
