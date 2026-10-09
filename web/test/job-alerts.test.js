// Job-alert emails as a source of listings: what is read out of them, what is
// refused, and how they join a scan.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-job-alerts-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { automationCooldowns: {} }
let alertJobs = []
let alertError = null
stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => ({ ...config }),
    update: patch => { config = { ...config, ...patch }; return config },
  },
  './logger': { append: () => {} },
  './scraper/utils': { randomDelay: async () => {}, stripMarkdown: value => String(value || '') },
  './jobAlerts': {
    collect: async () => { if (alertError) throw alertError; return alertJobs },
  },
})

const { parseAlertEmail, jobLinkIn, platformForSender, companyFromPosting } = require('../electron/services/jobAlerts')
const { check, done } = createChecker()

// ─── Fixtures, in the shapes the boards send ─────────────────────
const LINKEDIN = `
<table><tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/3901234567/?trackingId=abc%3D%3D&amp;refId=x">
    <img alt="Acme logo" src="logo.png"></a>
  <a href="https://www.linkedin.com/comm/jobs/view/3901234567/?trackingId=abc">Senior Data Engineer</a>
  <p>Acme Analytics · Sydney, New South Wales, Australia</p>
  <p>Actively recruiting</p>
  <a href="https://www.linkedin.com/comm/jobs/view/3901234567/">View job</a>
</td></tr><tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/3909999999/?trk=eml">Platform Engineer</a>
  <p>Easy Apply</p>
  <p>Globex · Melbourne (Hybrid)</p>
</td></tr></table>
<a href="https://www.linkedin.com/comm/jobs/search/?keywords=data">See all jobs</a>`

const SEEK = `
<div><a href="https://click.s.seek.com.au/?qs=1&amp;url=https%3A%2F%2Fwww.seek.com.au%2Fjob%2F78123456%3Ftracking%3DJAE">Backend Developer</a></div>
<div>Initech Pty Ltd</div><div>Brisbane QLD</div><div>$120,000 – $140,000</div>
<div><a href="https://www.seek.com.au/job/78123457?type=standard">Frontend Developer</a></div>
<div>Umbrella Corp</div>
<div><a href="https://www.linkedin.com/jobs/view/1234567890/">Not a Seek job</a></div>`

const INDEED = `
<a href="https://au.indeed.com/rc/clk/dl?jk=0a1b2c3d4e5f6a7b&amp;from=ja&amp;tk=x">DevOps Engineer</a>
<span>Hooli - Perth WA</span>
<a href="https://au.indeed.com/pagead/clk?mo=r&amp;jk=ffeeddccbbaa9988">Site Reliability Engineer</a>
<span>Pied Piper</span>`

// ─── Senders ─────────────────────────────────────────────────────
check('linkedin sender', platformForSender('jobalerts-noreply@linkedin.com'), 'LinkedIn')
check('linkedin subdomain sender', platformForSender('jobs@e.linkedin.com'), 'LinkedIn')
check('seek sender', platformForSender('noreply@s.seek.com.au'), 'Seek')
check('indeed sender', platformForSender('alert@indeed.com'), 'Indeed')
check('a lookalike domain is not linkedin', platformForSender('alerts@linkedin.com.evil.io'), null)
check('anyone else is ignored', platformForSender('friend@gmail.com'), null)
check('mail from a stranger yields nothing', parseAlertEmail({ from: 'x@gmail.com', html: LINKEDIN }), [])

// ─── Links through tracking redirects ────────────────────────────
check('linkedin link canonicalised', jobLinkIn('https://www.linkedin.com/comm/jobs/view/3901234567/?trackingId=abc')?.url, 'https://www.linkedin.com/jobs/view/3901234567/')
check('a slugged linkedin link', jobLinkIn('https://www.linkedin.com/jobs/view/data-engineer-at-acme-3901234567')?.url, 'https://www.linkedin.com/jobs/view/3901234567/')
check('seek link inside an encoded redirect', jobLinkIn('https://click.s.seek.com.au/?url=https%3A%2F%2Fwww.seek.com.au%2Fjob%2F78123456%3Ftracking%3DJAE')?.url, 'https://www.seek.com.au/job/78123456')
check('indeed jk link', jobLinkIn('https://au.indeed.com/rc/clk/dl?jk=0a1b2c3d4e5f6a7b&from=ja')?.url, 'https://au.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b')
check('a search link is not a job', jobLinkIn('https://www.linkedin.com/comm/jobs/search/?keywords=data'), null)

// ─── Parsing whole emails ────────────────────────────────────────
const li = parseAlertEmail({ from: 'jobalerts-noreply@linkedin.com', html: LINKEDIN })
check('linkedin: one entry per posting, not per link', li.length, 2)
check('linkedin: title from the title link, not "View job"', li[0].job_title, 'Senior Data Engineer')
check('linkedin: company before the location', li[0].company, 'Acme Analytics')
check('linkedin: "Easy Apply" is not a company', li[1].company, 'Globex')
check('linkedin: platform', li[0].platform, 'LinkedIn')
check('linkedin: marked as coming from an alert', li[0].source, 'alert')

const sk = parseAlertEmail({ from: 'noreply@s.seek.com.au', html: SEEK })
check('seek: both postings', sk.map(j => j.job_title), ['Backend Developer', 'Frontend Developer'])
check('seek: company on its own line', sk[0].company, 'Initech Pty Ltd')
check('seek: a LinkedIn link inside a Seek email is not taken', sk.some(j => j.platform !== 'Seek'), false)

const ind = parseAlertEmail({ from: 'alert@indeed.com', html: INDEED })
check('indeed: both postings', ind.length, 2)
check('indeed: "Company - Location" gives the company', ind[0].company, 'Hooli')
check('indeed: company without a location', ind[1].company, 'Pied Piper')

// ─── Company from the posting, when the email omits it ───────────
async function main() {
  const fakeFetch = async () => ({ ok: true, text: async () => '<script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"@type":"Organization","name":"Stark &amp; Sons"}}</script>' })
  check('company read from the posting\'s JobPosting block', await companyFromPosting('https://x', fakeFetch), 'Stark & Sons')
  check('a failed fetch yields blank, not a guess', await companyFromPosting('https://x', async () => { throw new Error('offline') }), '')

  // ─── Joining a scan ────────────────────────────────────────────
  const db = service('database')
  const seek = service('scraper/seek')
  const ai = service('ai/index')
  const applicator = service('applicator')
  await db.init()

  const cfg = {
    aiProvider: 'test', aiApiKey: 'key', masterResume: 'Jane Example\nSoftware Engineer at Acme',
    resumes: [{ id: 'general', name: 'General', text: 'Jane Example\nSoftware Engineer at Acme' }],
    defaultResumeId: 'general', matchThreshold: 70, companyCooldownDays: 0,
    enableSeek: true, enableIndeed: false, enableLinkedIn: false, enableAtsBoards: false,
    dailyLimitSeek: 50, extractRecruiterEmail: false, jobAlertsEnabled: true,
  }
  let scrapeCalls = 0
  const scored = []
  seek.scrape = async () => { scrapeCalls++; return [{ job_title: 'Scraped Role', company: 'Scraped Co', salary: '', job_url: 'https://www.seek.com.au/job/1' }] }
  seek.getJobDescription = async (url) => `Description for ${url}`
  seek.apply = async () => ({ success: true, screeningQa: [] })
  ai.scoreMatchWithExplanation = async (_p, _k, jd) => { scored.push(jd); return { score: 40, explanation: 'Weak.' } }

  alertJobs = [
    { job_title: 'Alert Role', company: 'Alert Co', salary: '', job_url: 'https://www.seek.com.au/job/2', platform: 'Seek', source: 'alert' },
    { job_title: 'Dup', company: 'Scraped Co', salary: '', job_url: 'https://www.seek.com.au/job/1', platform: 'Seek', source: 'alert' },
    { job_title: 'Other board', company: 'X', salary: '', job_url: 'https://www.linkedin.com/jobs/view/9/', platform: 'LinkedIn', source: 'alert' },
  ]
  const run1 = await applicator.run(cfg, { log: () => {}, notifyAttention: () => {} })
  check('alerts join the scraped results', scored.some(d => d.includes('/job/2')), true)
  check('a URL both found is processed once', scored.filter(d => d.includes('/job/1')).length, 1)
  check('a disabled board\'s alerts are not processed', scored.some(d => d.includes('linkedin')), false)
  check('the count includes the alert listing', run1.found, 2)

  scored.length = 0
  scrapeCalls = 0
  alertJobs = [{ job_title: 'Only Alert', company: 'Only Co', salary: '', job_url: 'https://www.seek.com.au/job/3', platform: 'Seek', source: 'alert' }]
  await applicator.run({ ...cfg, jobAlertsOnly: true }, { log: () => {}, notifyAttention: () => {} })
  check('"alerts instead of searching" never loads the search page', scrapeCalls, 0)
  check('…and still processes the alert', scored.some(d => d.includes('/job/3')), true)

  scored.length = 0
  alertError = new Error('Job alerts: mailbox unavailable')
  seek.scrape = async () => [{ job_title: 'Still Scraped', company: 'S Co', salary: '', job_url: 'https://www.seek.com.au/job/4' }]
  await applicator.run(cfg, { log: () => {}, notifyAttention: () => {} })
  check('an unreadable mailbox does not stop the scan', scored.some(d => d.includes('/job/4')), true)
  alertError = null

  scored.length = 0
  seek.scrape = async () => { const e = new Error('CAPTCHA'); e.blocked = true; throw e }
  alertJobs = [{ job_title: 'Blocked Board Alert', company: 'B Co', salary: '', job_url: 'https://www.seek.com.au/job/5', platform: 'Seek', source: 'alert' }]
  await applicator.run(cfg, { log: () => {}, notifyAttention: () => {} })
  check('a blocked search page does not lose the alerts', scored.some(d => d.includes('/job/5')), true)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
