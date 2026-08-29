// Company career boards hosted on Greenhouse, Lever, Ashby, Workable, Recruitee
// or SmartRecruiters.
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
//
// A provider is a `listUrl` and a `parse`. Most boards return the description
// with the listing, which is what makes them cheap: one request per company per
// scan. A board that does NOT — SmartRecruiters is the one here — declares
// `detailUrl` and `parseDetail`, and the description is fetched per surviving
// job instead. See fetchDescriptions() for why that is bounded rather than
// applied to every posting a large employer has open.
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
  // Descriptions come with the listing, so this costs one request per company.
  workable: {
    label: 'Workable',
    listUrl: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
    parse: (data, slug) => (data.jobs || []).map(j => ({
      job_title: j.title || '',
      company: data.name || slug,
      salary: '',
      // `url` is the public posting; `application_url` is the same page's form.
      // The posting is what a person should be sent to.
      job_url: j.url || j.application_url || '',
      job_description: decodeHtml(stripTags(j.description || '')),
      location: [j.city, j.state, j.country].filter(Boolean).join(', '),
      external_id: String(j.shortcode || j.id || ''),
    })),
  },
  recruitee: {
    label: 'Recruitee',
    listUrl: (slug) => `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
    parse: (data, slug) => (data.offers || []).map(j => ({
      job_title: j.title || '',
      company: j.company_name || slug,
      salary: '',
      // careers_url is the posting; careers_apply_url jumps straight into the
      // form, which is the wrong place to land someone who has not read the ad.
      job_url: j.careers_url || j.careers_apply_url || '',
      // Requirements are a separate field and are frequently where the actual
      // must-haves live — scoring against the blurb alone would miss them.
      job_description: decodeHtml(stripTags([j.description, j.requirements].filter(Boolean).join('\n\n'))),
      location: j.location || [j.city, j.country].filter(Boolean).join(', '),
      external_id: String(j.id || ''),
    })),
  },
  // The one board here whose list endpoint omits descriptions. `ref` is the
  // per-posting API URL the detail fetch uses.
  smartrecruiters: {
    label: 'SmartRecruiters',
    listUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`,
    parse: (data, slug) => (data.content || []).map(j => ({
      job_title: j.name || '',
      company: j.company?.name || slug,
      salary: '',
      // Built rather than read: the list carries `ref` (an API URL, not
      // something to send a person to) and the human-facing posting URL only
      // appears on the detail response.
      job_url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(j.id)}`,
      job_description: '',
      location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', '),
      external_id: String(j.id || ''),
      detailUrl: typeof j.ref === 'string' ? j.ref : '',
    })),
    // Four sections, of which the middle two are the ones a match score should
    // actually turn on. Joined in reading order so the text is coherent.
    parseDetail: (data) => {
      const sections = data?.jobAd?.sections || {}
      const text = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
        .map(name => sections[name]?.text)
        .filter(Boolean)
        .join('\n\n')
      return {
        job_description: decodeHtml(stripTags(text)),
        // The detail response knows the real posting URL; prefer it over the
        // one built above, which omits the slugified title.
        job_url: data?.postingUrl || '',
      }
    },
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

// Descriptions for a provider whose list endpoint does not carry them.
//
// Bounded on purpose. These boards return a company's ENTIRE job list, so a
// large employer means hundreds of postings, and one HTTP request each would be
// both slow and rude. This runs AFTER the keyword and location filters, so it
// only pays for jobs that were going to be scored anyway, and it stops at a
// ceiling rather than walking an unbounded list.
//
// A failure on one job is not a failure of the board: the job is kept with an
// empty description and the scan carries on. The applicator already scores on
// the title when there is no description, and a missing description is a worse
// match score, not a lost listing.
const MAX_DETAIL_FETCHES = 40

async function fetchDescriptions(provider, jobs, log) {
  const wanted = jobs.filter(j => j.detailUrl && !j.job_description)
  if (wanted.length === 0) return
  const budget = wanted.slice(0, MAX_DETAIL_FETCHES)
  if (wanted.length > budget.length) {
    log?.(`  ${provider.label}: reading the first ${budget.length} of ${wanted.length} matching descriptions`)
  }
  for (const job of budget) {
    try {
      const detail = provider.parseDetail(await fetchJson(job.detailUrl))
      if (detail.job_description) job.job_description = detail.job_description
      if (detail.job_url) job.job_url = detail.job_url
    } catch (err) {
      if (err.blocked) throw err
      // Keep the job. A title is enough to be worth a look, and dropping it
      // would make one flaky request look like a listing that never existed.
      log?.(`  ${provider.label}: could not read "${job.job_title}" (${err.message})`)
    }
  }
}

async function scrape(cfg, { log, skipDetails = false } = {}) {
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
      // Filtered BEFORE any per-job description fetch, so the detail requests
      // below are only made for jobs that survived.
      const kept = []
      for (const job of parsed) {
        if (!job.job_url || !job.job_title) continue
        if (seen.has(job.job_url)) continue
        if (!matchesKeywords(job, cfg.jobKeywords)) continue
        if (!matchesLocation(job, cfg.jobLocation)) continue
        seen.add(job.job_url)
        kept.push(job)
      }

      if (provider.parseDetail && !skipDetails) await fetchDescriptions(provider, kept, log)

      for (const job of kept) {
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
  PROVIDERS, matchesKeywords, matchesLocation, stripTags, decodeHtml, MAX_DETAIL_FETCHES,
}
