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

// ── Every provider agrees on the contract ────────────────────────
// A provider missing one of these is one that silently yields nothing.
for (const [id, spec] of Object.entries(ats.PROVIDERS)) {
  check(`${id} declares a label`, typeof spec.label, 'string')
  check(`${id} builds a list url`, typeof spec.listUrl('acme'), 'string')
  check(`${id} escapes the slug into its url`, spec.listUrl('a/b').includes('a/b'), false)
  check(`${id} parses an empty response without throwing`, (() => {
    try { return Array.isArray(spec.parse({}, 'acme')) } catch { return false }
  })(), true)
  // A provider that needs a detail fetch must be able to read one.
  check(`${id} pairs parseDetail with a detail url`,
    !spec.parseDetail || typeof spec.parseDetail === 'function', true)
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
