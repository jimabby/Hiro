// Reading a job ad from a link pasted into Ask Hiro: structured JobPosting
// data first, the page's main text otherwise, and never a page on this
// computer or the private network.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-job-page-'))
const { service, createChecker } = require('./helpers')
const jobPage = service('jobPage')

const { check, done } = createChecker()

const LONG = 'You will build and run data pipelines in Python and Spark, work with analysts on reporting, and look after data quality. '.repeat(4)
const POSTING = {
  '@context': 'https://schema.org', '@type': 'JobPosting',
  title: 'Data Engineer', hiringOrganization: { '@type': 'Organization', name: 'Globex &amp; Co' },
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Sydney', addressRegion: 'NSW', addressCountry: 'AU' } },
  baseSalary: { currency: 'AUD', value: { minValue: 120000, maxValue: 140000, unitText: 'YEAR' } },
  validThrough: '2026-12-15T00:00:00Z',
  description: `&lt;p&gt;${LONG}&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;li&gt;Spark&lt;/li&gt;&lt;/ul&gt;`,
}
const STRUCTURED = `<html><head><title>Jobs</title><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, POSTING] })}</script></head><body>menu</body></html>`
const PLAIN = `<html><head><meta property="og:title" content="Analyst role"><title>x</title></head><body><nav>Home Jobs About</nav><main><h1>Analyst</h1><p>${LONG}</p></main><footer>© Acme</footer></body></html>`

async function main() {
  // ─── Parsing ───────────────────────────────────────────────────
  const job = jobPage.parseJobPage(STRUCTURED)
  check('structured data is found inside an @graph', job.structured, true)
  check('the title comes from it', job.title, 'Data Engineer')
  check('the employer is decoded', job.company, 'Globex & Co')
  check('the location is assembled', job.location, 'Sydney, NSW, AU')
  check('the pay is stated with its currency and unit', job.salary, 'AUD 120000–140000 per year')
  check('the closing date is a day', job.closingDate, '2026-12-15')
  check('an entity-escaped HTML description becomes text', job.description.includes('<p>'), false)
  check('list items become bullets', /• Python\n• Spark/.test(job.description), true)

  const plain = jobPage.parseJobPage(PLAIN)
  check('without structured data the main content is used', [plain.structured, plain.description.startsWith('Analyst')], [false, true])
  check('navigation and footers are left out', /Home Jobs|© Acme/.test(plain.description), false)
  check('the title comes from the page', plain.title, 'Analyst role')
  check('a script never becomes text', jobPage.htmlToText('<p>a</p><script>alert(1)</script><p>b</p>'), 'a\nb')

  const text = jobPage.formatJobText(job, 'https://x.test/1')
  check('the facts lead the job ad', text.split('\n').slice(0, 2), ['Job title: Data Engineer', 'Company: Globex & Co'])

  // ─── Fetching ──────────────────────────────────────────────────
  const pages = {
    '/job': [200, 'text/html; charset=utf-8', STRUCTURED],
    '/plain': [200, 'text/html', PLAIN],
    '/moved': [301, 'text/html', '', { Location: '/job' }],
    '/loop': [302, 'text/html', '', { Location: '/loop' }],
    '/blocked': [999, 'text/html', 'no'],
    '/gone': [404, 'text/html', 'no'],
    '/pdf': [200, 'application/pdf', '%PDF'],
    '/empty': [200, 'text/html', '<html><body>Sign in to see this job</body></html>'],
    '/huge': [200, 'text/html', `<main><p>${'x '.repeat(2 * 1024 * 1024)}</p></main>`],
  }
  const server = http.createServer((req, res) => {
    const [status, type, body, headers = {}] = pages[req.url] || [404, 'text/plain', '']
    res.writeHead(status, { 'Content-Type': type, ...headers })
    res.end(body)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const read = (p, opts = { allowPrivate: true }) => jobPage.readJobLink(`${base}${p}`, opts)
  const failure = async (p, opts) => { try { await read(p, opts); return '' } catch (err) { return err.message } }

  const fetched = await read('/job')
  check('a posting is read from its link', [fetched.title, fetched.structured], ['Data Engineer', true])
  check('the conversation text carries the link', fetched.text.includes(`Link: ${base}/job`), true)
  check('a redirect is followed', (await read('/moved')).url, `${base}/job`)
  check('a redirect loop ends', /redirects too many/.test(await failure('/loop')), true)
  check('a site that refuses robots says to paste the ad', /refuses automatic reading \(HTTP 999\).*paste/.test(await failure('/blocked')), true)
  check('a closed ad says so', /no longer exists/.test(await failure('/gone')), true)
  check('a PDF link points at "From file…"', /From file/.test(await failure('/pdf')), true)
  check('a sign-in wall says the ad was not found', /could not find the job ad/.test(await failure('/empty')), true)
  const huge = await read('/huge')
  check('an oversized page is cut off, not read whole', huge.description.length <= 30000, true)

  // Private targets, without the test allowance.
  check('this computer is refused by IP', /private network/.test(await failure('/job', {})), true)
  check('localhost is refused by name', /private network/.test(await (async () => {
    try { await jobPage.readJobLink(`http://localhost:${server.address().port}/job`); return '' } catch (err) { return err.message }
  })()), true)
  let viaRedirect = ''
  const outer = http.createServer((req, res) => { res.writeHead(302, { Location: `${base}/job` }); res.end() })
  await new Promise(r => outer.listen(0, '127.0.0.1', r))
  try { await jobPage.fetchPage(`http://127.0.0.1:${outer.address().port}/`, {}) } catch (err) { viaRedirect = err.message }
  check('a redirect into the private network is refused too', /private network/.test(viaRedirect), true)
  check('only web links are read', /http and https/.test(await jobPage.readJobLink('file:///etc/passwd').catch(e => e.message)), true)
  check('nonsense is not a link', /not a web address/.test(await jobPage.readJobLink('acme careers').catch(e => e.message)), true)
  check('credentials in a link are refused', /user name or password/.test(await jobPage.readJobLink('https://a:b@example.com/').catch(e => e.message)), true)

  server.close()
  outer.close()
  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
