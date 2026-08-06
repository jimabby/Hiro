// Company career boards hosted on Greenhouse, Lever or Ashby.
//
// The aggregator scrapers (Seek/Indeed/LinkedIn) are the fragile part of this
// system: they need a logged-in browser, they change their markup, and they
// serve CAPTCHAs when they think you're a robot. ATS boards are the opposite —
// each one publishes a documented JSON endpoint, needs no login, has no bot
// defenses, and doesn't change shape. Watching ten companies you actually want
// to work for yields better matches per unit of maintenance than any amount of
// keyword scraping.
//
// These boards cannot be auto-submitted: the application forms are custom per
// company and often include file uploads and EEO questions. So every match is
// routed to Needs Attention with its resume and cover letter already drafted —
// the user clicks through and pastes. `supportsAutoApply` tells the applicator
// to skip the submit step rather than pretend it failed.

const { BlockedError } = require('./utils')

const supportsAutoApply = false

// Endpoint shapes, per provider. `slug` is the company's board identifier —
// the part of the careers URL that names them (boards.greenhouse.io/SLUG).
const PROVIDERS = {
  greenhouse: {
    label: 'Greenhouse',
    listUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    parse: (data, slug) => (data.jobs || []).map(j => ({
      job_title: j.title || '',
      company: j.company_name || slug,
      salary: '',
      job_url: j.absolute_url || '',
      // `content` is HTML-escaped HTML — decoded and stripped below.
      job_description: decodeHtml(stripTags(decodeHtml(j.content || ''))),
      location: j.location?.name || '',
      external_id: String(j.id || ''),
    })),
  },
  lever: {
    label: 'Lever',
    listUrl: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    parse: (data, slug) => (Array.isArray(data) ? data : []).map(j => ({
      job_title: j.text || '',
      company: slug,
      salary: j.salaryRange
        ? `${j.salaryRange.currency || ''} ${j.salaryRange.min || ''}-${j.salaryRange.max || ''} ${j.salaryRange.interval || ''}`.trim()
        : '',
      job_url: j.hostedUrl || j.applyUrl || '',
      // decodeHtml, not just stripTags. Lever's `descriptionPlain` is stripped of
      // tags but NOT of entities, so descriptions arrived full of "&amp;" and
      // "&nbsp;" — which the model then scores against and the Needs Attention
      // page shows literally. Only Greenhouse was being decoded.
      job_description: decodeHtml(stripTags(j.descriptionPlain || j.description || '')),
      location: j.categories?.location || '',
      external_id: String(j.id || ''),
    })),
  },
  ashby: {
    label: 'Ashby',
    listUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    parse: (data, slug) => (data.jobs || []).map(j => ({
      job_title: j.title || '',
      company: data.name || slug,
      salary: j.compensation?.compensationTierSummary || '',
      job_url: j.jobUrl || j.applyUrl || '',
      // Ashby's descriptionHtml is real HTML, so stripping tags leaves entities
      // behind — see the note on the Lever adapter above.
      job_description: decodeHtml(stripTags(j.descriptionHtml || j.descriptionPlain || '')),
      location: j.location || '',
      external_id: String(j.id || ''),
    })),
  },
}

function stripTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Ampersand last, or "&amp;lt;" would decode to "<" in one pass.
    .replace(/&amp;/g, '&')
}

const TIMEOUT_MS = 20000

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Hiro/1.0 (+job-search-assistant)' },
    })
    // A board that has been renamed or made private returns 404. That's a
    // configuration problem the user must fix, not a transient block.
    if (res.status === 404) {
      const err = new Error('board not found — check the slug in Settings → Job Boards')
      err.notFound = true
      throw err
    }
    if (res.status === 429 || res.status === 403) {
      throw new BlockedError('ATS', 'rate-limit')
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Keyword filter. The boards return a company's ENTIRE job list, which for a
// large employer is hundreds of unrelated roles — scoring all of them would
// cost a fortune in AI calls. Match on the title first (cheap and precise),
// falling back to the description only when keywords are specific enough to
// not match everything.
function matchesKeywords(job, keywords) {
  const terms = String(keywords || '')
    .split(/[,\n]/).map(k => k.trim().toLowerCase()).filter(Boolean)
  if (terms.length === 0) return true
  const title = (job.job_title || '').toLowerCase()
  const body = (job.job_description || '').toLowerCase()
  return terms.some(t => title.includes(t) || (t.length >= 5 && body.includes(t)))
}

function matchesLocation(job, location) {
  const want = String(location || '').trim().toLowerCase()
  if (!want) return true
  const have = (job.location || '').toLowerCase()
  if (!have) return true // board didn't say — don't exclude on missing data
  // "Sydney, NSW" should match a configured location of "Sydney", and a remote
  // role is a match for any location the user typed.
  if (/remote|anywhere|distributed/.test(have)) return true
  return want.split(/[,\s]+/).filter(w => w.length > 2).some(w => have.includes(w))
}

async function scrape(cfg) {
  const boards = (cfg.atsBoards || []).filter(b => b?.slug && PROVIDERS[b.provider])
  if (boards.length === 0) return []

  const jobs = []
  const seen = new Set()
  const failures = []

  for (const board of boards) {
    const provider = PROVIDERS[board.provider]
    try {
      const data = await fetchJson(provider.listUrl(board.slug))
      const parsed = provider.parse(data, board.label || board.slug)
      for (const job of parsed) {
        if (!job.job_url || !job.job_title) continue
        if (seen.has(job.job_url)) continue
        if (!matchesKeywords(job, cfg.jobKeywords)) continue
        if (!matchesLocation(job, cfg.jobLocation)) continue
        seen.add(job.job_url)
        jobs.push({
          job_title: job.job_title,
          company: board.label || job.company,
          salary: job.salary || '',
          job_url: job.job_url,
          // Cached so getJobDescription doesn't have to re-fetch the board.
          _description: job.job_description || '',
          _provider: provider.label,
        })
      }
    } catch (err) {
      // One misconfigured board must not take the whole platform down.
      if (err.blocked) throw err
      failures.push(`${board.label || board.slug}: ${err.message}`)
    }
  }

  if (failures.length > 0 && jobs.length === 0) {
    throw new Error(`no job boards could be read — ${failures.join('; ')}`)
  }
  return jobs
}

// The list endpoint already returned the full description, so this is a lookup
// rather than a second network round trip.
const descriptionCache = new Map()

async function getJobDescription(jobUrl) {
  if (descriptionCache.has(jobUrl)) return descriptionCache.get(jobUrl)
  return ''
}

// Called by the applicator before scoring; lets scrape() hand descriptions
// forward without a global.
function primeDescriptions(jobs) {
  descriptionCache.clear()
  for (const j of jobs) {
    if (j.job_url && j._description) descriptionCache.set(j.job_url, j._description)
  }
}

// Career-board forms are custom per company and frequently require uploads and
// EEO questions, so there is nothing safe to automate here. The applicator
// checks supportsAutoApply and routes these to Needs Attention with the
// documents already written, rather than calling this.
async function apply() {
  return {
    success: false,
    reason: 'Company career board — open the posting and submit there. Your tailored resume and cover letter are ready below.',
  }
}

module.exports = {
  scrape, getJobDescription, apply, primeDescriptions, supportsAutoApply,
  // exported for tests
  PROVIDERS, matchesKeywords, matchesLocation, stripTags, decodeHtml,
}
