// Company career boards (Greenhouse / Lever / Ashby). These return a company's
// ENTIRE job list, so the keyword and location filters are what stop a scan
// from paying to score hundreds of unrelated roles.

const path = require('path')
const { createChecker } = require('./helpers')
const ats = require(path.join(__dirname, '..', 'electron', 'services', 'scraper', 'ats.js'))

const { check, done } = createChecker()

// ── Provider parsing ─────────────────────────────────────────────
const greenhouse = ats.PROVIDERS.greenhouse.parse({
  jobs: [{
    id: 1, title: 'Senior Engineer', company_name: 'Acme',
    absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
    // Greenhouse double-escapes: HTML, then HTML-escaped again.
    content: '&lt;p&gt;Build &amp;amp; ship things&lt;/p&gt;',
    location: { name: 'Sydney, NSW' },
  }],
}, 'acme')
check('greenhouse title is parsed', greenhouse[0].job_title, 'Senior Engineer')
check('greenhouse url is parsed', greenhouse[0].job_url, 'https://boards.greenhouse.io/acme/jobs/1')
check('greenhouse double-escaped html is decoded and stripped', greenhouse[0].job_description, 'Build & ship things')
check('greenhouse location is kept', greenhouse[0].location, 'Sydney, NSW')

const lever = ats.PROVIDERS.lever.parse([{
  id: 'abc', text: 'Platform Engineer', hostedUrl: 'https://jobs.lever.co/acme/abc',
  // Lever's "plain" description is stripped of TAGS but keeps entities.
  descriptionPlain: 'Run the platform &amp; keep it up&nbsp;always',
  categories: { location: 'Remote' },
  salaryRange: { currency: 'AUD', min: 150000, max: 190000, interval: 'per-year-salary' },
}], 'acme')
check('lever title is parsed', lever[0].job_title, 'Platform Engineer')
check('lever salary range is carried through', /150000-190000/.test(lever[0].salary), true)
// Only Greenhouse used to be decoded, so every Lever description reached the
// model — and the Needs Attention page — full of "&amp;" and "&nbsp;".
// test/contract/ats-boards.contract.js found this against the real API.
check('lever entities are decoded', lever[0].job_description, 'Run the platform & keep it up always')

const ashby = ats.PROVIDERS.ashby.parse({
  name: 'Acme', jobs: [{
    id: 'x1', title: 'Data Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/x1',
    descriptionHtml: '<p>Pipelines &amp; dashboards</p>', location: 'Melbourne',
    compensation: { compensationTierSummary: 'A$160K – A$200K' },
  }],
}, 'acme')
check('ashby title is parsed', ashby[0].job_title, 'Data Engineer')
// descriptionHtml is real HTML, so stripping tags leaves entities behind.
check('ashby entities are decoded', ashby[0].job_description, 'Pipelines & dashboards')
check('ashby compensation summary is used as the salary', ashby[0].salary, 'A$160K – A$200K')
check('ashby company name comes from the board', ashby[0].company, 'Acme')

// ── Keyword filter ───────────────────────────────────────────────
const job = { job_title: 'Senior Data Engineer', job_description: 'Work with kubernetes daily.' }
check('a title keyword matches', ats.matchesKeywords(job, 'data'), true)
check('an unrelated keyword does not', ats.matchesKeywords(job, 'nursing'), false)
check('any keyword in the list can match', ats.matchesKeywords(job, 'nursing, engineer'), true)
check('no keywords means everything matches', ats.matchesKeywords(job, ''), true)
// Short terms are title-only: a two-letter fragment would match every
// description ever written and defeat the point of the filter.
check('a long keyword may match the description', ats.matchesKeywords(job, 'kubernetes'), true)
check('a short keyword is title-only', ats.matchesKeywords({ job_title: 'Nurse', job_description: 'go to ward' }, 'go'), false)

// ── Location filter ──────────────────────────────────────────────
check('a matching city passes', ats.matchesLocation({ location: 'Sydney, NSW' }, 'Sydney'), true)
check('a different city is excluded', ats.matchesLocation({ location: 'Perth, WA' }, 'Sydney'), false)
check('remote matches any configured location', ats.matchesLocation({ location: 'Remote — Australia' }, 'Sydney'), true)
// Missing data must not exclude — the board simply didn't say.
check('a board that states no location is not excluded', ats.matchesLocation({ location: '' }, 'Sydney'), true)
check('no configured location means everything passes', ats.matchesLocation({ location: 'Perth' }, ''), true)

// ── Auto-apply is deliberately unsupported ───────────────────────
check('career boards declare they cannot auto-apply', ats.supportsAutoApply, false)

;(async () => {
  const result = await ats.apply()
  check('apply() refuses rather than pretending', result.success, false)
  check('the reason tells the user what to do', /submit there/i.test(result.reason), true)

  // An empty board list is a no-op, not an error.
  check('no configured boards yields nothing', (await ats.scrape({ atsBoards: [] })).length, 0)
  check('an unknown provider is ignored',
    (await ats.scrape({ atsBoards: [{ provider: 'nope', slug: 'x' }] })).length, 0)

  done()
})()
