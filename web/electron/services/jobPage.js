// A job ad, read from a link the user pasted into Ask Hiro.
//
// Most job pages carry a schema.org JobPosting block — the same standard the
// iCIMS scraper and the job-alert company lookup rely on, put there so search
// engines can list the job. When it is there, the title, employer, location,
// pay, closing date and description come from it and nothing is guessed. When
// it is not, the page's main text is used instead, and said so.
//
// The link is fetched by the desktop, so it is a way to make the desktop send a
// request somewhere. Two rules follow, the same ones generic webhooks keep:
//   - nothing on this computer or the private network (router pages, printers,
//     services that trust localhost) — checked on what the name RESOLVES to,
//     at connect time, and again for every redirect;
//   - a bounded read: a link to a video or an endless stream is cut off rather
//     than pulled into the main process.
//
// Sites that refuse anything but a signed-in browser (LinkedIn, Indeed) are
// reported as exactly that, with what to do instead: paste the ad's text.

const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')

const MAX_BYTES = 3 * 1024 * 1024
const TIMEOUT_MS = 15000
const MAX_REDIRECTS = 4
const MAX_DESCRIPTION = 30000
const MIN_DESCRIPTION = 200

function isPrivateTarget(address) {
  return require('./webhooks').isPrivateTarget(address)
}

function privateError(host) {
  return Object.assign(new Error(`${host} is on this computer or your private network, so Hiro will not read it. Paste the job ad's text instead.`), { code: 'PRIVATE_TARGET' })
}

// The socket's own DNS lookup, refusing private answers. Checking the name
// first and connecting later would leave room for a name that answers
// differently the second time (DNS rebinding).
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : (options || {})
  const cb = typeof options === 'function' ? options : callback
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err)
    const list = Array.isArray(address) ? address.map(a => a.address) : [address]
    if (list.some(isPrivateTarget)) return cb(privateError(hostname))
    cb(null, address, family)
  })
}

function refusalMessage(status, host) {
  if ([401, 403, 429, 999].includes(status)) {
    return `${host} refuses automatic reading (HTTP ${status}); it only shows the ad to a signed-in browser. Open the posting, copy the ad and paste it into the job ad box.`
  }
  if (status === 404 || status === 410) return 'That job page no longer exists — the ad may have closed.'
  return `${host} answered HTTP ${status}. Open the posting, copy the ad and paste it into the job ad box.`
}

// Resolves { url, html } for a public web page. `allowPrivate` exists for tests
// that serve a page from localhost; nothing in the app sets it.
function fetchPage(rawUrl, { allowPrivate = false, redirects = 0, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(String(rawUrl || '').trim()) } catch { return reject(new Error('That is not a web address. Paste the full link, starting with https://')) }
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new Error('Only http and https links can be read.'))
    if (url.username || url.password) return reject(new Error('Links with a user name or password in them are not read.'))
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!allowPrivate) {
      if (/^localhost$|\.localhost$/i.test(host)) return reject(privateError(host))
      // A literal IP is connected to without any lookup, so it is checked here.
      if (net.isIP(host) && isPrivateTarget(host)) return reject(privateError(host))
    }

    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(url, {
      headers: {
        // A plain browser string: several boards serve an empty shell, or
        // nothing, to an unknown client.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en',
      },
      ...(allowPrivate ? {} : { lookup: guardedLookup }),
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) return reject(new Error('That link redirects too many times.'))
        let next
        try { next = new URL(res.headers.location, url).toString() } catch { return reject(new Error('That link redirects somewhere unreadable.')) }
        return fetchPage(next, { allowPrivate, redirects: redirects + 1, timeoutMs }).then(resolve, reject)
      }
      if (status < 200 || status >= 300) {
        res.resume()
        return reject(Object.assign(new Error(refusalMessage(status, host)), { status }))
      }
      const type = String(res.headers['content-type'] || '').toLowerCase()
      if (type && !/html|xml|text\/plain/.test(type)) {
        res.resume()
        return reject(new Error('That link is not a web page. If it is a PDF or Word file, download it and use "From file…" instead.'))
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BYTES) { res.destroy(); return }
        chunks.push(chunk)
      })
      res.on('close', () => resolve({ url: url.toString(), html: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('That page took too long to answer.')))
    req.on('error', (err) => reject(err.code === 'PRIVATE_TARGET' ? err : new Error(err.message === 'That page took too long to answer.' ? err.message : `Could not reach that page (${err.code || err.message}).`)))
  })
}

// ─── Reading the page ────────────────────────────────────────────

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&ndash;/gi, '–').replace(/&mdash;/gi, '—')
    .replace(/&bull;/gi, '•').replace(/&rsquo;/gi, '’').replace(/&lsquo;/gi, '‘').replace(/&hellip;/gi, '…')
    // Ampersand last, or "&amp;lt;" would decode to "<" in one pass.
    .replace(/&amp;/gi, '&')
}

function safeChar(code) {
  try { return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '' } catch { return '' }
}

// HTML to readable lines: block ends become line breaks, list items bullets.
function htmlToText(html) {
  const text = String(html || '')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .split('\n').map(l => l.replace(/[^\S\n]+/g, ' ').trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function jsonLdBlocks(html) {
  const out = []
  for (const m of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1].trim())) } catch { /* a broken block is skipped, not fatal */ }
  }
  return out
}

function isJobPosting(node) {
  const type = node?.['@type']
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
}

function findJobPosting(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  if (Array.isArray(value)) {
    for (const v of value) { const hit = findJobPosting(v, depth + 1); if (hit) return hit }
    return null
  }
  if (isJobPosting(value)) return value
  if (value['@graph']) return findJobPosting(value['@graph'], depth + 1)
  return null
}

const str = (v) => (typeof v === 'string' ? decodeEntities(v).replace(/\s+/g, ' ').trim() : '')

function locationOf(posting) {
  const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : []
  const names = places.map(p => {
    const a = p?.address || {}
    if (typeof a === 'string') return str(a)
    return [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry].map(str).filter(Boolean).join(', ')
  }).filter(Boolean)
  const remote = /TELECOMMUTE/i.test(String(posting.jobLocationType || '')) ? 'Remote' : ''
  return [...new Set([...names, remote].filter(Boolean))].join(' / ')
}

function salaryOf(posting) {
  const s = posting.baseSalary
  if (!s || typeof s !== 'object') return str(s)
  const v = s.value || {}
  const currency = str(s.currency || v.currency)
  const unit = str(v.unitText || s.unitText).toLowerCase()
  const min = v.minValue ?? v.value
  const max = v.maxValue
  if (min == null && max == null) return ''
  const range = max != null && max !== min ? `${min}–${max}` : `${min ?? max}`
  return [currency, range, unit ? `per ${unit}` : ''].filter(Boolean).join(' ')
}

function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i')
  return str((re.exec(html) || alt.exec(html) || [])[1] || '')
}

// { title, company, location, salary, closingDate, description, structured }
function parseJobPage(html) {
  const posting = findJobPosting(jsonLdBlocks(html))
  if (posting) {
    // Descriptions are often HTML that was itself entity-escaped.
    const description = htmlToText(decodeEntities(String(posting.description || '')))
    if (description.length >= MIN_DESCRIPTION / 2) {
      return {
        title: str(posting.title),
        company: str(posting.hiringOrganization?.name || posting.hiringOrganization),
        location: locationOf(posting),
        salary: salaryOf(posting),
        closingDate: str(posting.validThrough).slice(0, 10),
        description: description.slice(0, MAX_DESCRIPTION),
        structured: true,
      }
    }
  }
  // No usable structured data: the main content of the page.
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] || /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0]
  const body = main || String(html || '').replace(/<(header|footer|nav|aside)[\s\S]*?<\/\1>/gi, ' ')
  const title = metaContent(html, 'og:title') || str(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')
  return {
    title, company: metaContent(html, 'og:site_name'), location: '', salary: '', closingDate: '',
    description: htmlToText(body).slice(0, MAX_DESCRIPTION),
    structured: false,
  }
}

// The job ad as one block of text for the conversation, with the facts
// that came from structured data stated first.
function formatJobText(job, url) {
  const head = [
    job.title && `Job title: ${job.title}`,
    job.company && `Company: ${job.company}`,
    job.location && `Location: ${job.location}`,
    job.salary && `Pay: ${job.salary}`,
    job.closingDate && `Applications close: ${job.closingDate}`,
    url && `Link: ${url}`,
  ].filter(Boolean)
  return `${head.join('\n')}\n\n${job.description}`.trim()
}

async function readJobLink(rawUrl, opts = {}) {
  const { url, html } = await fetchPage(rawUrl, opts)
  const job = parseJobPage(html)
  if (job.description.length < MIN_DESCRIPTION) {
    throw new Error('Hiro could not find the job ad on that page. Some sites only show it after you sign in — open the posting, copy the ad and paste it into the job ad box.')
  }
  return { ...job, url, text: formatJobText(job, url) }
}

module.exports = { readJobLink, fetchPage, parseJobPage, htmlToText, formatJobText, MAX_BYTES }
