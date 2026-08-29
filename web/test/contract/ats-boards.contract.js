// Do the career-board APIs still serve what the ATS scraper parses?
//
// This is the highest-value contract test in the repo, because it protects the one
// job source that is supposed to be reliable. The aggregator scrapers fail loudly
// — a CAPTCHA, a blocked page, a selector that matches nothing. A boards API that
// renames `absolute_url` fails silently: `scrape()` skips every job for want of a
// URL, the scan reports "no listings matched", and the user concludes their search
// is too narrow.
//
// The boards below are large public employers who have used the same ATS for years.
// If one of them goes away the suite says so rather than pretending to pass.

const { PROVIDERS } = require('../../electron/services/scraper/ats')

let failures = 0
let ran = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
const note = (msg) => console.log(`      ${msg}`)

// Public boards, chosen for longevity rather than relevance.
const BOARDS = [
  { provider: 'greenhouse', slug: 'gitlab' },
  { provider: 'lever', slug: 'leverdemo' },
  { provider: 'ashby', slug: 'ashby' },
  { provider: 'workable', slug: 'zego' },
  { provider: 'recruitee', slug: 'vandebron' },
  // The one whose descriptions are not in the list response, so the detail
  // endpoint is exercised separately below.
  { provider: 'smartrecruiters', slug: 'Ubisoft2' },
]

async function fetchWithTimeout(url, ms = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Hiro/1.0 (+contract-test)' },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  for (const { provider, slug } of BOARDS) {
    const spec = PROVIDERS[provider]
    const url = spec.listUrl(slug)
    let res
    try {
      res = await fetchWithTimeout(url)
    } catch (err) {
      console.log(`SKIP  ${spec.label}: could not reach the endpoint (${err.message})`)
      continue
    }

    // A 404 means the board was renamed or made private. That is worth knowing —
    // the test fixture needs updating — but it is not a contract change.
    if (res.status === 404) {
      console.log(`SKIP  ${spec.label}: board "${slug}" no longer exists; pick another public board`)
      continue
    }
    if (res.status === 429 || res.status === 403) {
      console.log(`SKIP  ${spec.label}: rate-limited by the provider`)
      continue
    }
    if (!res.ok) {
      check(`${spec.label} responds`, res.status, 200)
      continue
    }

    ran++
    const data = await res.json()
    const parsed = spec.parse(data, slug)

    // The shape assertions. Each one names a field the scraper would silently
    // drop every job over.
    check(`${spec.label} returns a list of jobs`, Array.isArray(parsed) && parsed.length > 0, true)
    if (!parsed.length) continue
    note(`${parsed.length} jobs parsed from ${url}`)

    const withTitle = parsed.filter(j => j.job_title).length
    const withUrl = parsed.filter(j => j.job_url).length
    // scrape() drops any job missing either, so "most have them" is not good
    // enough — a rename shows up as a partial drop first.
    check(`${spec.label}: every job has a title`, withTitle, parsed.length)
    check(`${spec.label}: every job has an apply URL`, withUrl, parsed.length)
    check(`${spec.label}: apply URLs are absolute`,
      parsed.every(j => /^https?:\/\//.test(j.job_url)), true)
    check(`${spec.label}: every job has a stable id`,
      parsed.every(j => j.external_id && j.external_id !== 'undefined'), true)

    // A provider whose list omits descriptions fetches them one at a time. The
    // detail endpoint is a second contract, and it is the one that would break
    // silently — the list would keep working and every job would score on its
    // title alone.
    if (spec.parseDetail) {
      const target = parsed.find(j => j.detailUrl)
      check(`${spec.label}: the list carries a detail URL`, !!target, true)
      if (target) {
        const detailRes = await fetchWithTimeout(target.detailUrl)
        check(`${spec.label}: the detail endpoint responds`, detailRes.status, 200)
        if (detailRes.ok) {
          const detail = spec.parseDetail(await detailRes.json())
          check(`${spec.label}: the detail carries a description`,
            (detail.job_description || '').length > 50, true)
          check(`${spec.label}: the detail description is plain text`,
            /<[a-z][^>]*>/i.test(detail.job_description || ''), false)
          check(`${spec.label}: the detail supplies a posting URL`,
            /^https?:\/\//.test(detail.job_url || ''), true)
          note(`detail description is ${detail.job_description.length} chars`)
          // Fold it back in so the plain-text assertions below see real text
          // rather than the empty string the list gave.
          target.job_description = detail.job_description
        }
      }
    }

    // Descriptions are what the model scores against. An empty one is not fatal —
    // some postings really are terse — but ALL of them empty means the field moved.
    const described = parsed.filter(j => (j.job_description || '').length > 50).length
    check(`${spec.label}: descriptions are present`, described > 0, true)
    note(`${described}/${parsed.length} jobs have a substantial description`)

    // Greenhouse double-encodes HTML in `content`; the adapter decodes twice and
    // strips tags. Leftover markup here means that pipeline broke.
    const withMarkup = parsed.filter(j => /<[a-z][^>]*>/i.test(j.job_description || '')).length
    check(`${spec.label}: descriptions are plain text`, withMarkup, 0)
    const withEntities = parsed.filter(j => /&(lt|gt|amp|quot|nbsp);/.test(j.job_description || '')).length
    check(`${spec.label}: HTML entities are decoded`, withEntities, 0)
  }

  if (ran === 0) {
    console.log('SKIP  no board endpoint could be reached — nothing was verified')
  }
  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(err => { console.error(err); process.exitCode = 1 })
