const https = require('https')
const http = require('http')
const { URL } = require('url')
const configService = require('./config')

function post(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl)
    const mod = url.protocol === 'https:' ? https : http
    const data = JSON.stringify(payload)
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
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
