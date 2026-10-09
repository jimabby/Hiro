// Jobs found in the alert emails LinkedIn, Seek and Indeed already send you.
//
// Every listing Hiro scores comes from scraping a search page, and scraping is
// the part of the app that gets throttled, CAPTCHA'd and broken by markup
// changes — automationHealth.js exists almost entirely to cope with it. Yet the
// same boards email the user a curated list of new matches every day, from
// their own saved searches, with no bot defences in the way. The inbox check
// already logs in to that mailbox; it was skipping those emails as noise.
//
// This reads them. Each alert is parsed for links to job postings, and those
// join the scan exactly as if a scraper had found them — same de-duplication,
// same scoring, same review rules. With "alerts instead of searching" on, the
// boards' search pages are not loaded at all.
//
// Only mail FROM the boards' own domains is read, and only links that match a
// board's job-posting URL shape are taken, so an arbitrary email cannot slip a
// URL into the pipeline.

const { ImapFlow } = require('imapflow')
const mailProvider = require('./mailProvider')
const configService = require('./config')

const OVERLAP_MS = 6 * 60 * 60 * 1000
const FIRST_RUN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000

// Sender domains per board. A subdomain counts (e.g. e.linkedin.com).
const SENDERS = {
  LinkedIn: ['linkedin.com'],
  Seek: ['seek.com.au', 'seek.co.nz', 'seek.com'],
  Indeed: ['indeed.com', 'indeedemail.com'],
}

// A job posting's URL, per board, reduced to its canonical form. Alert links
// are wrapped in tracking redirects, so these are matched anywhere inside the
// (repeatedly URL-decoded) href.
const PATTERNS = [
  {
    platform: 'LinkedIn',
    re: /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/i,
    canonical: m => `https://www.linkedin.com/jobs/view/${m[1]}/`,
  },
  {
    platform: 'Seek',
    re: /seek\.(com\.au|co\.nz)\/job\/(\d{6,})/i,
    canonical: m => `https://www.seek.${m[1].toLowerCase()}/job/${m[2]}`,
  },
  {
    platform: 'Indeed',
    re: /((?:[a-z]{2}\.)?indeed\.(?:com|co\.uk|ca|com\.au|co\.nz|ie|com\.sg|co\.in|de|nl))\/[^\s"'<>]*?[?&](?:jk|vjk)=([0-9a-f]{12,20})/i,
    canonical: m => `https://${m[1].toLowerCase()}/viewjob?jk=${m[2].toLowerCase()}`,
  },
]

function platformForSender(address) {
  const domain = String(address || '').toLowerCase().split('@')[1] || ''
  for (const [platform, domains] of Object.entries(SENDERS)) {
    if (domains.some(d => domain === d || domain.endsWith(`.${d}`))) return platform
  }
  return null
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}

function textOf(html) {
  return decodeEntities(String(html || '')
    .replace(/<(br|\/p|\/div|\/tr|\/td|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

// Find the canonical posting URL hidden in an href, through up to three layers
// of URL-encoding (tracking redirects nest the destination as a parameter).
function jobLinkIn(href) {
  let candidate = decodeEntities(href)
  for (let i = 0; i < 4; i++) {
    for (const p of PATTERNS) {
      const m = candidate.match(p.re)
      if (m) return { platform: p.platform, url: p.canonical(m) }
    }
    try {
      const next = decodeURIComponent(candidate)
      if (next === candidate) break
      candidate = next
    } catch { break }
  }
  return null
}

// Anchor text that is a call to action rather than a job title.
const GENERIC_LINK_RE = /^(view( job| details)?|apply( now)?|easy apply|see (more|job|all)|more|details|save|learn more|quick apply|\d+ new jobs?|new)$/i
// Lines under a title that are not the company.
const NOT_COMPANY_RE = /^(easy apply|quick apply|actively recruiting|promoted|new|be an early applicant|\d+ (applicants?|connections?|alumni)|.*\bago\b|apply|view job|save|urgently hiring|responsive employer|\$|salary|remote|hybrid|on-?site|full[- ]time|part[- ]time|contract)/i

// What one alert email contains. Pure, so it can be tested against fixtures.
function parseAlertEmail({ from = '', html = '' } = {}) {
  const sender = platformForSender(from)
  if (!sender || !html) return []

  const anchors = []
  const re = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    anchors.push({ href: m[2], inner: m[3], end: re.lastIndex })
  }

  const byUrl = new Map()
  for (const a of anchors) {
    const link = jobLinkIn(a.href)
    // A board's alert only ever lists its own postings; a Seek email linking to
    // LinkedIn is not something to act on.
    if (!link || link.platform !== sender) continue
    const title = textOf(a.inner).join(' ').trim()
    const entry = byUrl.get(link.url) || { ...link, titles: [], end: a.end }
    if (title && !GENERIC_LINK_RE.test(title) && title.length <= 150) entry.titles.push({ title, end: a.end })
    byUrl.set(link.url, entry)
  }

  const jobs = []
  for (const entry of byUrl.values()) {
    const best = entry.titles.sort((x, y) => y.title.length - x.title.length)[0]
    if (!best) continue
    // The company is the first plausible line after the title. Boards write it
    // as "Company · Location" or "Company - Location" as often as on its own
    // line, so the first segment is taken.
    const after = textOf(html.slice(best.end, best.end + 1500))
    let company = ''
    for (const line of after.slice(0, 5)) {
      if (line === best.title || NOT_COMPANY_RE.test(line)) continue
      const first = line.split(/\s+[·•|–-]\s+/)[0].trim()
      if (first && first.length <= 100 && !/^\d/.test(first)) { company = first; break }
    }
    jobs.push({ job_title: best.title, company, job_url: entry.url, platform: entry.platform, salary: '', source: 'alert' })
  }
  return jobs
}

// ─── Mailbox ─────────────────────────────────────────────────────

// The text/html part of a message, found from its structure.
function findHtmlPart(node, path = '') {
  if (!node) return null
  if (node.childNodes?.length) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const hit = findHtmlPart(node.childNodes[i], node.childNodes[i].part || `${path ? `${path}.` : ''}${i + 1}`)
      if (hit) return hit
    }
    return null
  }
  return String(node.type || '').toLowerCase() === 'text/html' ? (node.part || path || '1') : null
}

async function streamToString(stream, limit = 2e6) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) break
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// The company is sometimes not in the email at all. Every board's posting page
// carries a schema.org JobPosting block naming the employer, and reading it is
// one plain request. Best-effort; a job with no company is dropped rather than
// scored, because company-level rules (blacklist, cooldown, duplicate checks)
// cannot be applied to it.
async function companyFromPosting(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return ''
    const html = await res.text()
    const m = html.match(/"hiringOrganization"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{1,120})"/)
    return m ? decodeEntities(m[1]).trim() : ''
  } catch {
    return ''
  }
}

// Read the alert emails received since the last check. Returns the jobs found,
// grouped nowhere — the caller sorts them by platform.
async function collect(cfg = configService.load(), { log = () => {}, fetchImpl } = {}) {
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) {
    throw new Error('Job alerts need the email account in Settings → Email.')
  }
  const { imap } = mailProvider.resolve(cfg)
  const client = new ImapFlow({
    host: imap.host, port: imap.port, secure: imap.secure,
    auth: { user: cfg.imapUser || cfg.smtpUser || cfg.gmailAddress, pass: cfg.gmailAppPassword },
    logger: false,
  })

  const last = cfg.lastJobAlertCheck ? new Date(cfg.lastJobAlertCheck) : null
  const since = last && !isNaN(last.getTime())
    ? new Date(last.getTime() - OVERLAP_MS)
    : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS)

  const found = new Map()
  let emails = 0
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const candidates = []
      for await (const msg of client.fetch({ since }, { envelope: true, bodyStructure: true })) {
        const from = msg.envelope?.from?.[0]?.address || ''
        if (!platformForSender(from)) continue
        candidates.push({ uid: msg.uid, from, part: findHtmlPart(msg.bodyStructure) })
      }
      for (const c of candidates) {
        if (!c.part) continue
        try {
          const { content } = await client.download(c.uid, c.part, { uid: true })
          const html = await streamToString(content)
          emails++
          for (const job of parseAlertEmail({ from: c.from, html })) {
            if (!found.has(job.job_url)) found.set(job.job_url, job)
          }
        } catch (err) {
          log(`Job alerts: could not read one email (${err.message}).`)
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
  } catch (err) {
    await client.logout().catch(() => {})
    throw new Error(`Job alerts: ${err.message}`)
  }

  const jobs = []
  let dropped = 0
  for (const job of found.values()) {
    if (!job.company) job.company = await companyFromPosting(job.job_url, fetchImpl)
    if (job.company) jobs.push(job)
    else dropped++
  }
  configService.update({ lastJobAlertCheck: new Date().toISOString() })
  log(`Job alerts: ${jobs.length} listing${jobs.length === 1 ? '' : 's'} from ${emails} alert email${emails === 1 ? '' : 's'}`
    + `${dropped ? ` (${dropped} skipped — no company could be read)` : ''}.`)
  return jobs
}

module.exports = { collect, parseAlertEmail, jobLinkIn, platformForSender, companyFromPosting, findHtmlPart }
