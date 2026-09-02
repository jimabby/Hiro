const https = require('https')
const http = require('http')
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

function post(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(new Error(`Webhook URL must be http or https, not "${url.protocol}"`))
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const data = JSON.stringify(payload)
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

  return { embeds: [embed] }
}

function formatSlack(type, data) {
  const blocks = []

  if (type === 'attention') {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `Needs Attention: ${data.job_title}` } })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${data.company}* — ${data.platform} | Match: ${data.match_score || '?'}%${data.reason ? `\n${data.reason}` : ''}` } })
  } else if (type === 'scan-complete') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *Scan Complete* — ${data.message || 'Job scan finished'}` } })
  } else if (type === 'inbox-reply') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:email: *Reply from ${data.company || 'Unknown'}* — Status: ${data.newStatus || 'unknown'}` } })
  } else if (type === 'weekly-report') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:bar_chart: *Weekly Report* — ${data.totalApps || 0} applications | Response rate: ${data.responseRate || 0}%` } })
  }

  return { blocks }
}

async function send(type, data) {
  const cfg = configService.load()
  const webhooks = cfg.webhooks || []

  for (const wh of webhooks) {
    if (!wh.enabled || !wh.url) continue
    if (wh.events && !wh.events.includes(type)) continue

    try {
      const payload = wh.provider === 'slack' ? formatSlack(type, data) : formatDiscord(type, data)
      await post(wh.url, payload)
    } catch { /* non-critical */ }
  }
}

async function test(provider, url) {
  const payload = provider === 'slack'
    ? formatSlack('scan-complete', { message: 'Test notification from Hiro' })
    : formatDiscord('scan-complete', { message: 'Test notification from Hiro' })
  const result = await post(url, payload)
  return result.status >= 200 && result.status < 300
}

module.exports = { send, test }
