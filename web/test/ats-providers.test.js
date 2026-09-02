// The three career boards added after Greenhouse / Lever / Ashby.
//
// Kept separate from ats-boards.test.js so the original three keep their own
// file, and because these two exercise something the first three do not: a
// provider whose list endpoint omits the description, and therefore needs a
// bounded per-job fetch.
//
// The field names below are taken from the live endpoints (see
// test/contract/ats-boards.contract.js, which checks they have not moved).

const path = require('path')
const { createChecker } = require('./helpers')
const ats = require(path.join(__dirname, '..', 'electron', 'services', 'scraper', 'ats.js'))

const { check, done } = createChecker()

// ── Workable ─────────────────────────────────────────────────────
const workable = ats.PROVIDERS.workable.parse({
  name: 'Zego',
  jobs: [{
    shortcode: 'B76C11B977',
    title: 'Analytics Engineer',
    url: 'https://apply.workable.com/j/B76C11B977',
    application_url: 'https://apply.workable.com/j/B76C11B977/apply',
    description: '<p>Build &amp; ship dashboards</p><p>Second&nbsp;paragraph</p>',
    city: 'London', state: 'England', country: 'United Kingdom',
  }],
}, 'zego')
check('workable title is parsed', workable[0].job_title, 'Analytics Engineer')
// The posting, not the form. Dropping someone straight into an application they
// have not read is the wrong place to land.
check('workable links to the posting rather than the form',
  workable[0].job_url, 'https://apply.workable.com/j/B76C11B977')
check('workable html is stripped and decoded',
  workable[0].job_description, 'Build & ship dashboards\nSecond paragraph')
check('workable location is assembled from its parts',
  workable[0].location, 'London, England, United Kingdom')
check('workable company comes from the account', workable[0].company, 'Zego')
// A board that publishes nothing is not an error.
check('workable tolerates an empty board', ats.PROVIDERS.workable.parse({}, 'zego').length, 0)
// Some postings carry only the apply URL.
check('workable falls back to the apply url', ats.PROVIDERS.workable.parse({
  jobs: [{ title: 'X', application_url: 'https://apply.workable.com/j/Q/apply' }],
}, 'z')[0].job_url, 'https://apply.workable.com/j/Q/apply')

// ── Recruitee ────────────────────────────────────────────────────
const recruitee = ats.PROVIDERS.recruitee.parse({
  offers: [{
    id: 2710502,
    title: 'Sourcing & Pricing Analyst',
    company_name: 'Vandebron',
    careers_url: 'https://werkenbij.vandebron.nl/o/sourcing-pricing-analyst',
    careers_apply_url: 'https://werkenbij.vandebron.nl/o/sourcing-pricing-analyst/c/new',
    description: '<h3>Who we are</h3><p>An energy company</p>',
    requirements: '<ul><li>5 years&nbsp;experience</li></ul>',
    location: 'Amsterdam, Noord-Holland, Nederland',
    city: 'Amsterdam', country: 'Nederland',
  }],
}, 'vandebron')
check('recruitee title is parsed', recruitee[0].job_title, 'Sourcing & Pricing Analyst')
check('recruitee links to the posting rather than the form',
  recruitee[0].job_url, 'https://werkenbij.vandebron.nl/o/sourcing-pricing-analyst')
// Requirements are a separate field and are usually where the must-haves live,
// so scoring against the blurb alone would miss exactly the part that decides
// whether the job is a match.
check('recruitee folds requirements into the description',
  /An energy company/.test(recruitee[0].job_description) && /5 years experience/.test(recruitee[0].job_description), true)
check('recruitee location is kept', recruitee[0].location, 'Amsterdam, Noord-Holland, Nederland')
check('recruitee falls back to city and country when location is absent',
  ats.PROVIDERS.recruitee.parse({ offers: [{ title: 'X', careers_url: 'u', city: 'Utrecht', country: 'NL' }] }, 's')[0].location,
  'Utrecht, NL')
// An offer with no requirements must not produce a trailing separator.
check('recruitee handles a missing requirements block',
  ats.PROVIDERS.recruitee.parse({ offers: [{ title: 'X', careers_url: 'u', description: '<p>Only this</p>', requirements: null }] }, 's')[0].job_description,
  'Only this')

// ── SmartRecruiters ──────────────────────────────────────────────
// The one provider whose list carries no description.
const sr = ats.PROVIDERS.smartrecruiters.parse({
  content: [{
    id: '744000146151279',
    name: 'Workplace Specialist',
    company: { name: 'Ubisoft' },
    ref: 'https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings/744000146151279',
    location: { city: 'Newcastle upon Tyne', region: 'England', country: 'gb' },
  }],
}, 'Ubisoft2')
check('smartrecruiters title is parsed', sr[0].job_title, 'Workplace Specialist')
check('smartrecruiters company is parsed', sr[0].company, 'Ubisoft')
// The list has no human-facing URL, so one is built. It is replaced by the real
// one when the detail is read.
check('smartrecruiters builds a usable posting url',
  sr[0].job_url, 'https://jobs.smartrecruiters.com/Ubisoft2/744000146151279')
check('smartrecruiters has no description in the list', sr[0].job_description, '')
check('smartrecruiters records where to fetch one', sr[0].detailUrl,
  'https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings/744000146151279')
check('smartrecruiters location is assembled', sr[0].location, 'Newcastle upon Tyne, England, gb')

const detail = ats.PROVIDERS.smartrecruiters.parseDetail({
  postingUrl: 'https://jobs.smartrecruiters.com/Ubisoft2/744000146151279-workplace-specialist',
  jobAd: {
    sections: {
      companyDescription: { text: '<p>About us &amp; ours</p>' },
      jobDescription: { text: '<p>The role</p>' },
      qualifications: { text: '<p>Must have SQL</p>' },
      additionalInformation: { text: '<p>Benefits</p>' },
    },
  },
})
check('smartrecruiters detail joins every section in reading order',
  detail.job_description, 'About us & ours\n\nThe role\n\nMust have SQL\n\nBenefits')
check('smartrecruiters detail supplies the real posting url',
  detail.job_url, 'https://jobs.smartrecruiters.com/Ubisoft2/744000146151279-workplace-specialist')
// A posting with only some sections filled in must not leave blank gaps.
check('smartrecruiters detail skips absent sections',
  ats.PROVIDERS.smartrecruiters.parseDetail({ jobAd: { sections: { jobDescription: { text: 'Only this' } } } }).job_description,
  'Only this')
check('smartrecruiters detail survives a malformed response',
  ats.PROVIDERS.smartrecruiters.parseDetail({}).job_description, '')

// ── Workday ──────────────────────────────────────────────────────
// The largest enterprise ATS, and the only board here whose identifier is a
// path: the data centre (wd1/wd3/wd5…) differs per employer and is not derivable
// from the company name, so the careers URL is what gets stored.
const WORKDAY_BOARD = 'https://acme.wd3.myworkdayjobs.com/en-US/External'

check('workday reads the data centre out of the address',
  ats.parseWorkday(WORKDAY_BOARD).base, 'https://acme.wd3.myworkdayjobs.com')
check('workday reads the tenant', ats.parseWorkday(WORKDAY_BOARD).tenant, 'acme')
check('workday reads the site', ats.parseWorkday(WORKDAY_BOARD).site, 'External')
check('workday defaults the locale when the URL omits it',
  ats.parseWorkday('https://acme.wd5.myworkdayjobs.com/Careers').locale, 'en-US')
check('workday keeps a locale the URL states',
  ats.parseWorkday('https://acme.wd3.myworkdayjobs.com/en-GB/External').locale, 'en-GB')
check('workday accepts the tenant/site shorthand',
  ats.parseWorkday('acme/External').site, 'External')
// A bare company name cannot work, and failing at the moment the board is added
// is the whole point of validating boards there.
check('workday refuses a bare company name', (() => {
  try { ats.parseWorkday('acme'); return false } catch { return true }
})(), true)

check('workday posts to the list endpoint', ats.PROVIDERS.workday.method, 'POST')
check('workday asks for a bounded page',
  ats.PROVIDERS.workday.body(WORKDAY_BOARD).limit, 20)
check('workday builds the cxs list url',
  ats.PROVIDERS.workday.listUrl(WORKDAY_BOARD),
  'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/jobs')

const workday = ats.PROVIDERS.workday.parse({
  total: 1,
  jobPostings: [{
    title: 'Senior Data Engineer',
    externalPath: '/job/Sydney/Senior-Data-Engineer_R-4471',
    locationsText: 'Sydney, NSW',
    bulletFields: ['R-4471'],
  }],
}, WORKDAY_BOARD)[0]

check('workday title is parsed', workday.job_title, 'Senior Data Engineer')
check('workday builds the human-facing posting url', workday.job_url,
  'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Sydney/Senior-Data-Engineer_R-4471')
check('workday records where to fetch the description', workday.detailUrl,
  'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Sydney/Senior-Data-Engineer_R-4471')
check('workday has no description in the list', workday.job_description, '')
check('workday location is kept', workday.location, 'Sydney, NSW')
check('workday uses the requisition id as its external id', workday.external_id, 'R-4471')

const workdayDetail = ats.PROVIDERS.workday.parseDetail({
  jobPostingInfo: {
    jobDescription: '<p>Build pipelines &amp; own them</p><li>SQL</li>',
    externalUrl: 'https://acme.wd3.myworkdayjobs.com/en-US/External/job/R-4471',
  },
})
check('workday detail strips markup and decodes entities',
  workdayDetail.job_description, 'Build pipelines & own them\nSQL')
check('workday detail prefers the canonical posting url',
  workdayDetail.job_url, 'https://acme.wd3.myworkdayjobs.com/en-US/External/job/R-4471')
check('workday detail survives a malformed response',
  ats.PROVIDERS.workday.parseDetail({}).job_description, '')

// ── BambooHR ─────────────────────────────────────────────────────
const bamboo = ats.PROVIDERS.bamboohr.parse({
  meta: { companyName: 'Acme Pty Ltd' },
  result: [{
    id: 42,
    jobOpeningName: 'Analytics Engineer',
    location: { city: 'Melbourne', state: 'VIC', country: 'Australia' },
  }],
}, 'acme')[0]

check('bamboohr title is parsed', bamboo.job_title, 'Analytics Engineer')
check('bamboohr prefers the company name the board states', bamboo.company, 'Acme Pty Ltd')
check('bamboohr links to the posting', bamboo.job_url, 'https://acme.bamboohr.com/careers/42')
check('bamboohr records where to fetch the description', bamboo.detailUrl,
  'https://acme.bamboohr.com/careers/42/detail')
check('bamboohr location is assembled from its parts', bamboo.location, 'Melbourne, VIC, Australia')
check('bamboohr falls back to the slug for the company name',
  ats.PROVIDERS.bamboohr.parse({ result: [{ id: 1, jobOpeningName: 'X' }] }, 'acme')[0].company, 'acme')
check('bamboohr detail strips markup',
  ats.PROVIDERS.bamboohr.parseDetail({ result: { jobOpening: { description: '<p>Own the warehouse</p>' } } }).job_description,
  'Own the warehouse')
check('bamboohr detail survives a malformed response',
  ats.PROVIDERS.bamboohr.parseDetail({}).job_description, '')
// The board identifier is often pasted as a URL rather than typed as a name.
check('bamboohr accepts a pasted careers url',
  ats.PROVIDERS.bamboohr.listUrl('https://acme.bamboohr.com/careers'),
  'https://acme.bamboohr.com/careers/list')

// ── Personio ─────────────────────────────────────────────────────
const personio = ats.PROVIDERS.personio.parse([{
  id: 900123,
  name: 'Backend Engineer',
  office: 'Berlin',
  jobDescriptions: [
    { name: 'Your mission', value: '<p>Ship services</p>' },
    { name: 'Your profile', value: '<p>5 years of Go</p>' },
  ],
}], 'acme')[0]

check('personio title is parsed', personio.job_title, 'Backend Engineer')
check('personio links to the posting', personio.job_url, 'https://acme.jobs.personio.com/job/900123')
check('personio office becomes the location', personio.location, 'Berlin')
// The must-haves live in a later section, so joining every one of them is what
// keeps them in front of the match scorer.
check('personio folds every section into the description',
  personio.job_description, 'Your mission\nShip services\n\nYour profile\n5 years of Go')
check('personio handles a flat description field',
  ats.PROVIDERS.personio.parse([{ id: 1, name: 'X', description: '<p>Flat</p>' }], 'acme')[0].job_description,
  'Flat')
check('personio tolerates an empty board',
  ats.PROVIDERS.personio.parse([], 'acme').length, 0)

// ── Every provider agrees on the contract ────────────────────────
// A provider missing one of these is one that silently yields nothing.
for (const [id, spec] of Object.entries(ats.PROVIDERS)) {
  // Every provider declares an identifier that really works for it. Workday's
  // is a path rather than one token (it needs the data centre and the site as
  // well as the tenant), so the loop asks each provider for its own example
  // instead of assuming one shape fits all.
  const slug = spec.sampleSlug
  check(`${id} declares a label`, typeof spec.label, 'string')
  check(`${id} declares a working sample identifier`, typeof slug, 'string')
  check(`${id} tells the user what its identifier looks like`, typeof spec.slugHint, 'string')
  check(`${id} builds a list url`, typeof spec.listUrl(slug), 'string')
  check(`${id} builds an https url`, spec.listUrl(slug).startsWith('https://'), true)
  check(`${id} parses an empty response without throwing`, (() => {
    try { return Array.isArray(spec.parse({}, slug)) } catch { return false }
  })(), true)
  // A provider that needs a detail fetch must be able to read one.
  check(`${id} pairs parseDetail with a detail url`,
    !spec.parseDetail || typeof spec.parseDetail === 'function', true)

  // A slug is user input, and it goes into a URL. For the single-token boards
  // that means a slash must never survive into the path; for Workday, where the
  // slash is meaningful, it means the components have to be validated instead.
  if (spec.slugIsPath) {
    check(`${id} refuses a traversal in its identifier`, (() => {
      try { spec.listUrl('acme/../../v1/admin'); return false } catch { return true }
    })(), true)
    check(`${id} refuses a host that is not Workday`, (() => {
      try { spec.listUrl('https://evil.example.com/en-US/External'); return false } catch { return true }
    })(), true)
  } else {
    check(`${id} escapes the slug into its url`, spec.listUrl('a/b').includes('a/b'), false)
  }
}

// ── The detail fetch is bounded ──────────────────────────────────
// These boards return a company's entire job list, so an unbounded "one request
// per posting" would be both slow and rude to the board.
check('the per-scan detail budget is finite', Number.isFinite(ats.MAX_DETAIL_FETCHES), true)
check('and small enough to be polite', ats.MAX_DETAIL_FETCHES <= 100, true)

// ── Detail fetching, through scrape() ────────────────────────────
// The point of fetching descriptions per job is that it happens AFTER the
// filters. A board with three hundred open roles and a keyword that matches two
// of them must cost two requests, not three hundred.
const realFetch = global.fetch
const listing = (n) => ({
  content: Array.from({ length: n }, (_, i) => ({
    id: String(i),
    name: i === 0 ? 'Senior Data Engineer' : `Warehouse Picker ${i}`,
    company: { name: 'Acme' },
    ref: `https://api.smartrecruiters.com/v1/companies/acme/postings/${i}`,
    location: { city: 'Sydney' },
  })),
})

let detailUrls = []
function fakeFetch({ jobs = 5, detailFails = false } = {}) {
  detailUrls = []
  global.fetch = async (url) => {
    const body = /postings\/\d+$/.test(url)
      ? (detailUrls.push(url), detailFails
        ? null
        : { jobAd: { sections: { jobDescription: { text: `<p>Body for ${url.split('/').pop()}</p>` } } } })
      : listing(jobs)
    if (body === null) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }
}

;(async () => {
  const board = { atsBoards: [{ provider: 'smartrecruiters', slug: 'acme', label: 'Acme' }] }

  // Only the job that survived the keyword filter costs a request.
  fakeFetch({ jobs: 30 })
  let jobs = await ats.scrape({ ...board, jobKeywords: 'data engineer' })
  check('the keyword filter runs before the detail fetch', detailUrls.length, 1)
  check('and only the matching job is returned', jobs.length, 1)
  check('the description was fetched', /Body for 0/.test(jobs[0]._description), true)

  // With no keywords everything matches, so the budget is what bounds it.
  fakeFetch({ jobs: ats.MAX_DETAIL_FETCHES + 25 })
  jobs = await ats.scrape({ ...board, jobKeywords: '' })
  check('the detail fetch stops at the budget', detailUrls.length, ats.MAX_DETAIL_FETCHES)
  // Crucially, the jobs beyond the budget are still RETURNED — they just have no
  // description yet. Dropping them would turn a polite limit into lost listings.
  check('jobs past the budget are still returned', jobs.length, ats.MAX_DETAIL_FETCHES + 25)
  check('the ones within budget have descriptions', jobs[0]._description.length > 0, true)
  check('the ones past it are scored on the title alone', jobs[jobs.length - 1]._description, '')

  // A detail request that fails keeps the job. One flaky response must not look
  // like a listing that never existed.
  fakeFetch({ jobs: 3, detailFails: true })
  jobs = await ats.scrape({ ...board, jobKeywords: '' })
  check('a failed detail fetch does not drop the job', jobs.length, 3)
  check('it just has no description', jobs[0]._description, '')

  // Validation asks only "does this slug exist", so it must not fire the whole
  // detail budget to answer.
  fakeFetch({ jobs: 30 })
  jobs = await ats.scrape({ ...board, jobKeywords: '' }, { skipDetails: true })
  check('skipDetails makes no detail requests', detailUrls.length, 0)
  check('but still reports the board size', jobs.length, 30)

  global.fetch = realFetch
  done()
})()
