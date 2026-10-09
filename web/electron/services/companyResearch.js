// What has been in the news about an employer, for interview prep.
//
// "What do you know about us?" is asked in nearly every interview, and the
// honest preparation for it — reading what the company has been doing lately —
// was the one piece of prep Hiro did not help with. Every other input to a
// brief is something the app already holds; this one has to be looked up.
//
// Source: the Google News RSS search feed. It needs no key and no account, and
// returns dated headlines with their publisher, which is the part a candidate
// can check. A model then summarises the headlines — and ONLY the headlines:
// they are fenced as untrusted text (a headline is written by whoever wrote it),
// the prompt forbids adding facts, and the headlines themselves are always shown
// beside the summary so it can be checked against them.
//
// Cached per company for a week. Research is optional everywhere it is used: a
// brief without it is still a brief.

const database = require('./database')
const configService = require('./config')
const aiAdapter = require('./ai/index')
const { isAiConfigured } = require('./ai/configured')
const { fence, FENCE_RULES } = require('./ai/untrusted')

const MAX_AGE_DAYS = 7
const MAX_HEADLINES = 8
const NEWS_WINDOW_DAYS = 365

// Google News edition per Indeed region, so results lean local.
const EDITIONS = {
  au: ['en-AU', 'AU'], nz: ['en-NZ', 'NZ'], us: ['en-US', 'US'], ca: ['en-CA', 'CA'],
  uk: ['en-GB', 'GB'], ie: ['en-IE', 'IE'], sg: ['en-SG', 'SG'], in: ['en-IN', 'IN'],
  de: ['de', 'DE'], nl: ['nl', 'NL'],
}

// Legal suffixes say nothing about which company is meant and cost matches.
function companyKey(company) {
  return String(company || '').toLowerCase()
    .replace(/\b(pty|ltd|limited|inc|llc|plc|gmbh|corp|corporation|co|company|group|holdings)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '').trim()
}

// Headlines from an RSS document. Pure, for tests.
function parseNewsRss(xml, { now = Date.now() } = {}) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(String(xml || ''))) !== null) {
    const pick = tag => decode((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1])
    const source = pick('source')
    let title = pick('title')
    // Google appends " - Publisher" to every title; the publisher has its own field.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
    const date = new Date(pick('pubDate'))
    if (!title || isNaN(date.getTime())) continue
    if (now - date.getTime() > NEWS_WINDOW_DAYS * 86400000) continue
    items.push({ title, source, url: pick('link'), date: date.toISOString().slice(0, 10) })
  }
  items.sort((a, b) => b.date.localeCompare(a.date))
  return items.slice(0, MAX_HEADLINES)
}

async function fetchNews(company, { region = 'au', fetchImpl = globalThis.fetch } = {}) {
  const [hl, gl] = EDITIONS[region] || EDITIONS.us
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${company}"`)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`news search returned ${res.status}`)
  return parseNewsRss(await res.text())
}

const SYSTEM = `You help a job candidate prepare for an interview by summarising recent news about the employer.
Use ONLY the headlines provided. Do not add facts, figures, products or events that are not in them.
If the headlines seem to be about a different organisation with a similar name, say so plainly.
Write 3–5 short bullet points: what the company appears to be doing lately, and one or two
thoughtful questions the candidate could ask about it. Plain text, "- " bullets, no markdown.`

async function summarise(company, headlines, cfg) {
  if (!headlines.length || !isAiConfigured(cfg)) return ''
  const list = headlines.map(h => `${h.date} — ${h.title}${h.source ? ` (${h.source})` : ''}`).join('\n')
  try {
    const text = await aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
      operation: 'companyResearch', tier: 'fast', maxTokens: 500, system: SYSTEM,
      messages: [{ role: 'user', content: `Company: ${company}\n\n${FENCE_RULES}\n\n${fence('HEADLINES', list, 4000)}` }],
    }, cfg.geminiModel)
    return String(text || '').replace(/\*\*/g, '').trim()
  } catch {
    return ''
  }
}

// Research for one company: cached when fresh, looked up when not. Never
// throws — a brief is not worth failing over the news being unreachable.
async function research(company, { refresh = false, fetchImpl, cfg = configService.load() } = {}) {
  const key = companyKey(company)
  if (!key) return null
  const cached = database.getCompanyResearch(key)
  if (cached && !refresh) {
    const at = new Date(`${String(cached.fetchedAt).replace(' ', 'T')}Z`)
    if (!isNaN(at.getTime()) && Date.now() - at.getTime() < MAX_AGE_DAYS * 86400000) return cached
  }
  try {
    const headlines = await fetchNews(company, { region: cfg.indeedRegion, fetchImpl })
    const summary = await summarise(company, headlines, cfg)
    const data = { company, headlines, summary }
    database.saveCompanyResearch(key, data)
    return { ...data, fetchedAt: new Date().toISOString() }
  } catch (err) {
    return cached || { company, headlines: [], summary: '', error: err.message }
  }
}

// Only what is already cached — for places that must not touch the network.
function cachedResearch(company) {
  const key = companyKey(company)
  return key ? database.getCompanyResearch(key) : null
}

module.exports = { research, cachedResearch, parseNewsRss, companyKey, fetchNews }
