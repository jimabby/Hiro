// Company career boards hosted on Greenhouse, Lever, Ashby, Workable, Recruitee,
// SmartRecruiters, Workday, BambooHR or Personio.
//
// The aggregator scrapers (Seek/Indeed/LinkedIn) are the fragile part of this
// system: they need a logged-in browser, they change their markup, and they
// serve CAPTCHAs when they think you're a robot. ATS boards are the opposite —
// each one publishes a documented JSON endpoint, needs no login, has no bot
// defenses, and doesn't change shape. Watching ten companies you actually want
// to work for yields better matches per unit of maintenance than any amount of
// keyword scraping.
//
// iCIMS is the exception to the paragraph above, and the shape of the exception
// matters. It still publishes no free JSON board API — api.icims.com is sold to
// its own customers, and `format=json` on a careers portal returns HTML — so
// the note that used to sit here, refusing to add it, was right about the API.
//
// What changed the answer is that the two objections turned out to be separable.
// The listing page is HTML, but every iCIMS JOB page carries a schema.org
// JobPosting in application/ld+json, which is a W3C-standard shape rather than
// a per-customer template — so the description, title, company and location all
// come from structured data like every other provider here. Only the discovery
// step reads markup, and it reads iCIMS's own platform classes
// (iCIMS_JobCardItem, iCIMS_Anchor), not the employer's branding.
//
// The second objection — "it would report a template change as 'this company
// has no openings'" — is the one that actually decided it, and it is answered
// explicitly rather than tolerated. iCIMS_JobsTable is emitted on the results
// page whether or not the search matched anything, so an empty board and a
// moved template are distinguishable: the container present with no cards is a
// genuine zero, and the container missing altogether raises rather than
// returning []. See parseIcims.
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
    sampleSlug: 'acme',
    slugHint: 'The name in boards.greenhouse.io/NAME',
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
    sampleSlug: 'acme',
    slugHint: 'The name in jobs.lever.co/NAME',
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
    sampleSlug: 'acme',
    slugHint: 'The name in apply.workable.com/NAME',
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
    sampleSlug: 'acme',
    slugHint: 'The name in NAME.recruitee.com',
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
    sampleSlug: 'acme',
    slugHint: 'The name in jobs.smartrecruiters.com/NAME',
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
  // ─── Workday ───────────────────────────────────────────────────
  //
  // The largest enterprise ATS by a wide margin, and the reason a lot of real
  // openings were invisible to Hiro. Two things make it unlike the others here:
  //
  //   The list endpoint is a POST with a JSON body, not a GET. Hence `method`
  //   and `body` on the provider shape.
  //
  //   A board is not identified by one slug. It needs the tenant, the data
  //   centre (wd1/wd2/wd3/wd5/wd103…, which differs per customer and cannot be
  //   guessed) and the site name. Asking a user for three fields to add one
  //   board is a bad trade, so `slug` accepts the careers URL itself — the thing
  //   they already have in the address bar — and everything is parsed out of it.
  //   `tenant/site` still works for anyone who knows the shorthand.
  workday: {
    label: 'Workday',
    // The only provider whose identifier is a path rather than one token —
    // see parseWorkday for why it has to be.
    slugIsPath: true,
    sampleSlug: 'https://acme.wd3.myworkdayjobs.com/en-US/External',
    slugHint: 'The full careers URL, e.g. https://acme.wd3.myworkdayjobs.com/en-US/External',
    method: 'POST',
    // Workday pages results; one page of 20 is what a scan needs, and asking for
    // more of a large employer's list only to filter it out is wasted traffic.
    body: () => ({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
    listUrl: (slug) => {
      const { base, tenant, site } = parseWorkday(slug)
      return `${base}/wday/cxs/${tenant}/${site}/jobs`
    },
    parse: (data, slug) => {
      const { base, tenant, site, locale } = parseWorkday(slug)
      return (data.jobPostings || []).map(j => ({
        job_title: j.title || '',
        company: slug,
        salary: '',
        // externalPath already begins with a slash.
        job_url: j.externalPath ? `${base}/${locale}/${site}${j.externalPath}` : '',
        job_description: '',
        location: j.locationsText || '',
        external_id: String(j.bulletFields?.[0] || j.externalPath || ''),
        detailUrl: j.externalPath ? `${base}/wday/cxs/${tenant}/${site}${j.externalPath}` : '',
      }))
    },
    parseDetail: (data) => {
      const info = data?.jobPostingInfo || {}
      return {
        job_description: decodeHtml(stripTags(info.jobDescription || '')),
        // externalUrl is the canonical public posting; the one built above is a
        // reconstruction and is only the fallback.
        job_url: info.externalUrl || '',
      }
    },
  },

  // ─── BambooHR ──────────────────────────────────────────────────
  // Small and mid-size employers. The list is titles and locations only, so
  // descriptions cost one request each — bounded by MAX_DETAIL_FETCHES like
  // SmartRecruiters.
  bamboohr: {
    label: 'BambooHR',
    sampleSlug: 'acme',
    slugHint: 'The name in NAME.bamboohr.com/careers',
    listUrl: (slug) => `https://${encodeURIComponent(bareSlug(slug))}.bamboohr.com/careers/list`,
    parse: (data, slug) => {
      const host = bareSlug(slug)
      return (data.result || []).map(j => ({
        job_title: j.jobOpeningName || '',
        company: data.meta?.companyName || slug,
        salary: j.compensation || '',
        job_url: j.id ? `https://${host}.bamboohr.com/careers/${encodeURIComponent(j.id)}` : '',
        job_description: '',
        location: [j.location?.city, j.location?.state, j.location?.country]
          .filter(Boolean).join(', ') || j.atsLocation || '',
        external_id: String(j.id || ''),
        detailUrl: j.id
          ? `https://${host}.bamboohr.com/careers/${encodeURIComponent(j.id)}/detail`
          : '',
      }))
    },
    parseDetail: (data) => {
      const opening = data?.result?.jobOpening || data?.result || {}
      return { job_description: decodeHtml(stripTags(opening.description || '')), job_url: '' }
    },
  },

  // ─── Personio ──────────────────────────────────────────────────
  // Common across European employers, and the descriptions come with the list,
  // so it costs one request per company like Greenhouse.
  personio: {
    label: 'Personio',
    sampleSlug: 'acme',
    slugHint: 'The name in NAME.jobs.personio.com',
    // .com and .de are the same board; .com is the current canonical host.
    listUrl: (slug) => `https://${encodeURIComponent(bareSlug(slug))}.jobs.personio.com/search.json`,
    parse: (data, slug) => (Array.isArray(data) ? data : data?.jobs || []).map(j => ({
      job_title: j.name || j.title || '',
      company: slug,
      salary: '',
      job_url: j.id
        ? `https://${bareSlug(slug)}.jobs.personio.com/job/${encodeURIComponent(j.id)}`
        : '',
      // The description is split into named sections ("Your mission", "Your
      // profile"), and the requirements usually live in a later one — joining
      // them all is what keeps the must-haves in front of the scorer.
      job_description: decodeHtml(stripTags(
        Array.isArray(j.jobDescriptions)
          ? j.jobDescriptions.map(d => [d.name, d.value].filter(Boolean).join('\n')).join('\n\n')
          : (j.description || '')
      )),
      location: j.office || j.location || '',
      external_id: String(j.id || ''),
    })),
  },

  ashby: {
    label: 'Ashby',
    sampleSlug: 'acme',
    slugHint: 'The name in jobs.ashbyhq.com/NAME',
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

  // ─── iCIMS ─────────────────────────────────────────────────────
  //
  // The one provider whose LIST is markup rather than JSON — see the note at
  // the top of this file for why that was worth making an exception for, and
  // what had to be true before it was.
  //
  // Discovery reads the results page; content comes from the JobPosting
  // ld+json on each job page, so this behaves like SmartRecruiters or BambooHR
  // from fetchDescriptions() down: bounded per-job fetches, after filtering.
  //
  // `in_iframe=1` is the server-rendered variant of the results page. The
  // default one ships an empty shell and fills it in from script, so it parses
  // to zero jobs no matter how healthy the board is.
  icims: {
    label: 'iCIMS',
    responseType: 'html',
    // What a board with nothing open looks like, for the contract check that
    // every provider tolerates one. The others are JSON and an empty object
    // says it; here the container is the whole point — an empty results page
    // still carries it, and a response WITHOUT it is the break case that must
    // raise rather than parse to nothing.
    emptyResponse: '<div class="iCIMS_JobsTable"></div>',
    sampleSlug: 'careers-acme',
    slugHint: 'The name in careers-NAME.icims.com, or the full careers URL',
    listUrl: (slug) => `https://${icimsHost(slug)}/jobs/search?ss=1&in_iframe=1`,
    parse: (html, slug) => parseIcims(html, slug),
    parseDetail: (html) => parseIcimsDetail(html),
  },
}

// iCIMS tenants are one host, and the portal half of the name is part of it:
// "careers-acme" and "jobs-acme" are both real and neither is derivable from
// the company name. So the tenant is taken as given, and a pasted URL has its
// host lifted out rather than being picked apart.
function icimsHost(value) {
  const raw = String(value || '').trim()
  const bare = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]
  // A bare tenant is one token. Suffixing anything else — "acme.example.com"
  // becoming "acme.example.com.icims.com" — turns a pasted address for some
  // other ATS into a DNS failure days later instead of a wrong-provider message
  // at the moment it is added.
  const host = /icims\.com$/i.test(bare) ? bare
    : /^[A-Za-z0-9-]+$/.test(bare) ? `${bare}.icims.com`
    : ''
  // Same reasoning as assertSafeWorkday: this goes into a URL as a HOST, where
  // encodeURIComponent cannot help, so it is checked against what an iCIMS
  // tenant actually looks like instead of being escaped into something that
  // merely looks harmless.
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.icims\.com$/.test(host)) {
    throw new Error('that does not look like an iCIMS careers address — it should be of the form '
      + 'careers-acme.icims.com, or the full https://careers-acme.icims.com/jobs/search URL')
  }
  return host.toLowerCase()
}

// The structural marker iCIMS emits around the results list. Present on a search
// that matched nothing, which is the entire reason this is checked separately
// from the card count — see parseIcims.
const ICIMS_CONTAINER = /iCIMS_JobsTable|iCIMS_JobCardItem|iCIMS_content/i

function parseIcims(html, slug) {
  const text = String(html || '')

  // An empty board and a moved template both yield zero cards, and they need
  // opposite responses: one is a fact about the employer, the other is a bug
  // that must be visible. The container tells them apart, so a break is raised
  // here rather than being laundered into "no openings" three days running.
  const cards = text.split(/class="[^"]*iCIMS_JobCardItem/i).slice(1)
  if (cards.length === 0 && !ICIMS_CONTAINER.test(text)) {
    throw new Error('the iCIMS results page did not contain a job list — the board may have moved, '
      + 'or the careers portal address may be wrong')
  }

  const jobs = []
  for (const card of cards) {
    // The anchor carries both identifiers: the href gives the requisition id and
    // the canonical posting, and iCIMS writes "<id> - <title>" into the title
    // attribute of that same tag.
    const href = card.match(/href="([^"]*\/jobs\/(\d+)\/[^"]*?\/job)[^"]*"/i)
    if (!href) continue
    const [, url, id] = href

    const titled = card.match(new RegExp(`title="${id}\\s*-\\s*([^"]*)"`, 'i'))
    const heading = card.match(/<h3[^>]*>\s*([^<]+?)\s*<\/h3>/i)
    // Last resort: the slug in the URL. Lossy on case and punctuation, but a
    // job with a readable title beats a job dropped for want of one.
    const fromSlug = url.match(/\/jobs\/\d+\/([^/]+)\/job/)
    const title = decodeHtml(
      titled?.[1] || heading?.[1] || (fromSlug ? decodeURIComponent(fromSlug[1]).replace(/-+/g, ' ') : '')
    ).trim()
    if (!title) continue

    // Tenants label this field differently ("Location" and "Job Locations" are
    // both live), so the label is matched on the word rather than the phrase.
    const loc = card.match(/field-label"[^>]*>[^<]*Location[^<]*<\/span>\s*<span[^>]*>\s*([^<]*)/i)

    jobs.push({
      job_title: title,
      company: slug,
      salary: '',
      // The reader gets the branded page; in_iframe is a fetching detail.
      job_url: url.replace(/[?&]in_iframe=1/i, ''),
      job_description: '',
      location: decodeHtml(loc?.[1] || '').replace(/\s+/g, ' ').trim(),
      external_id: id,
      detailUrl: `${url}${url.includes('?') ? '&' : '?'}in_iframe=1`,
    })
  }
  return jobs
}

// schema.org/JobPosting, which is what makes this provider tenable: the part
// that carries the content a match score turns on is a standard, not a layout.
function parseIcimsDetail(html) {
  for (const block of String(html || '').matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    let data
    try { data = JSON.parse(block[1].trim()) } catch { continue }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (!node || node['@type'] !== 'JobPosting') continue
      return {
        job_description: decodeHtml(stripTags(node.description || '')),
        // Only overrides the constructed URL when the posting names one.
        job_url: typeof node.url === 'string' ? node.url : '',
      }
    }
  }
  return { job_description: '', job_url: '' }
}

// A board identifier with any surrounding URL stripped off, so a user can paste
// what they have rather than having to know which part is the slug.
function bareSlug(value) {
  const raw = String(value || '').trim()
  const withoutScheme = raw.replace(/^https?:\/\//i, '')
  // "acme.bamboohr.com/careers" and "acme" both mean acme.
  return withoutScheme.split(/[/?#]/)[0].split('.')[0]
}

// Workday needs three things the others get from one slug: which data centre the
// tenant is on, the tenant, and the site. All three are in the careers URL, so
// that is what this accepts — plus a "tenant/site" shorthand for anyone who
// knows it.
//
// Throws rather than guessing. A wrong data centre is a 404 three days later on
// a board the user believes is being watched, and the whole point of validating
// boards at the moment they are added is to make that impossible.
function parseWorkday(value) {
  const raw = String(value || '').trim()

  const url = /myworkdayjobs\.com/i.test(raw)
    ? raw.replace(/^https?:\/\//i, '')
    : null

  if (url) {
    const [host, ...segments] = url.split('/').filter(Boolean)
    const tenant = host.split('.')[0]
    // The path is either /{locale}/{site}/... or /{site}/...; a locale is
    // always of the form xx-XX, which nothing else in the path looks like.
    const locale = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] || '') ? segments[0] : 'en-US'
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] || '') ? segments[1] : segments[0]
    if (!tenant || !site) {
      throw new Error('that Workday address is missing the site name — it should look like '
        + 'https://acme.wd3.myworkdayjobs.com/en-US/External')
    }
    const parsed = { base: `https://${host}`, tenant, site, locale }
    assertSafeWorkday(parsed)
    return parsed
  }

  const parts = raw.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new Error('a Workday board needs the full careers URL (for example '
      + 'https://acme.wd3.myworkdayjobs.com/en-US/External) — the data centre in it '
      + '(wd1, wd3, wd5…) differs per employer and cannot be guessed from the company name')
  }
  const [tenant, site] = parts
  const parsed = { base: `https://${tenant}.wd3.myworkdayjobs.com`, tenant, site, locale: 'en-US' }
  assertSafeWorkday(parsed)
  return parsed
}

// Workday is the one provider whose identifier legitimately contains slashes, so
// it cannot rely on encodeURIComponent to keep its parts from becoming path
// segments the way the single-token boards do. Each component is checked
// against what a real tenant, site and host look like instead — which also
// rejects the "acme/../../v1/admin" shape outright rather than encoding it into
// something harmless-looking.
const WORKDAY_HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.myworkdayjobs\.com$/
const WORKDAY_PART = /^[A-Za-z0-9._-]+$/

function assertSafeWorkday({ base, tenant, site, locale }) {
  const host = base.replace(/^https:\/\//, '')
  const ok = WORKDAY_HOST.test(host)
    && WORKDAY_PART.test(tenant) && WORKDAY_PART.test(site)
    && /^[a-z]{2}-[A-Z]{2}$/.test(locale)
    && tenant !== '.' && tenant !== '..' && site !== '.' && site !== '..'
  if (!ok) {
    throw new Error('that does not look like a Workday careers address — it should be of the form '
      + 'https://acme.wd3.myworkdayjobs.com/en-US/External')
  }
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

// `init` carries a method and body for the one provider whose list endpoint is a
// POST (Workday), and `responseType` for the one whose pages are markup rather
// than JSON (iCIMS). Everything else is a plain GET and passes nothing.
async function fetchJson(url, init = {}) {
  const wantsHtml = init.responseType === 'html'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      method: init.method || 'GET',
      headers: {
        Accept: wantsHtml ? 'text/html,application/xhtml+xml' : 'application/json',
        'User-Agent': 'Hiro/1.0 (+job-search-assistant)',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
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
    return wantsHtml ? await res.text() : await res.json()
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
      const detail = provider.parseDetail(
        await fetchJson(job.detailUrl, { responseType: provider.responseType })
      )
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

// `onBoard` is how a per-board failure escapes this function.
//
// Boards are watched individually and fail individually: a slug that is renamed
// or made private 404s while every other board keeps working. That failure used
// to be pushed onto `failures` and then discarded unless EVERY board failed, so
// a user watching six employers could have one dead for weeks while the scan
// reported success each morning. The aggregate "ATS" health signal cannot see it
// either — the platform is working, one board inside it is not.
async function scrape(cfg, { log, skipDetails = false, onBoard } = {}) {
  const boards = (cfg.atsBoards || []).filter(b => b?.slug && PROVIDERS[b.provider])
  if (boards.length === 0) return []

  const jobs = []
  const seen = new Set()
  const failures = []

  const report = (board, outcome) => {
    try {
      onBoard?.({
        // Stable across renames of the display label, which is the thing a user
        // is most likely to edit.
        key: `${board.provider}:${board.slug}`,
        provider: board.provider,
        label: board.label || board.slug,
        slug: board.slug,
        ...outcome,
      })
    } catch { /* health reporting must never break a scan */ }
  }

  for (const board of boards) {
    const provider = PROVIDERS[board.provider]
    try {
      const data = await fetchJson(provider.listUrl(board.slug), {
        method: provider.method,
        body: provider.body ? provider.body(board.slug) : undefined,
        responseType: provider.responseType,
      })
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

      // `parsed` rather than `kept`: a board publishing forty roles of which
      // none match your keywords is healthy, and reporting it as zero would
      // make every narrow search look like a broken board.
      report(board, { found: parsed.length, matched: kept.length })
    } catch (err) {
      // One misconfigured board must not take the whole platform down.
      if (err.blocked) throw err
      failures.push(`${board.label || board.slug}: ${err.message}`)
      // A renamed or private board is a configuration problem the user has to
      // fix, and it is permanent until they do; anything else may be transient.
      report(board, { error: err.message, notFound: !!err.notFound })
      log?.(`  ${board.label || board.slug}: ${err.message}`)
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
  parseWorkday, bareSlug, icimsHost, parseIcims, parseIcimsDetail,
}
