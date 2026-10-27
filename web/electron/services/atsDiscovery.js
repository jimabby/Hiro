// Careers-board discovery: is the employer you just applied to on Greenhouse,
// Lever or Ashby?
//
// A watched board is the most reliable source Hiro has (see scraper/ats.js),
// but adding one means knowing the slug, and nobody goes looking for it. Most
// slugs are simply the company's name, so for employers already in the user's
// history this tries the obvious spellings against each provider and reports
// the boards that answer with open roles.
//
// What it will not do:
//
//   - Run by itself. It is a button. Each probe is a request to a third party
//     on the user's behalf, so it happens when they ask and not otherwise.
//   - Add anything. A hit is a suggestion with the board's own name and a few
//     of its job titles beside it, because "acme" on Greenhouse may well be a
//     different Acme. Adding it is a separate click in Settings.
//   - Guess widely. At most two spellings per company (joined and hyphenated),
//     three providers, a capped number of companies, one request at a time
//     with a pause between them, and it stops at the first board found for a
//     company and altogether at the first sign of rate limiting.

const PROVIDERS = ['greenhouse', 'lever', 'ashby']
const MAX_COMPANIES = 10
const MAX_SLUGS = 2
const DELAY_MS = 400

const LEGAL = /\b(pty|ltd|limited|inc|incorporated|llc|plc|gmbh|ag|sa|bv|corp|corporation|co|company|group|holdings|the)\b\.?/g

// Two candidates at most, most likely first. Pure, for tests.
function slugCandidates(company) {
  const words = String(company || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ') // "Acme (Australia)" — the bracket is a region, not the name
    .replace(LEGAL, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const joined = words.join('')
  // A one- or two-letter slug matches some unrelated board far too often.
  if (joined.length < 3) return []
  const out = [joined]
  if (words.length > 1) out.push(words.join('-'))
  return out.slice(0, MAX_SLUGS)
}

let running = false
const sleep = ms => new Promise(r => setTimeout(r, ms))

// `existing` is the board list as it stands in Settings. `testBoard` and
// `companies` are injectable for tests.
async function discover({
  existing = [], companies = null, testBoard = null, delayMs = DELAY_MS, maxCompanies = MAX_COMPANIES,
} = {}) {
  if (running) throw new Error('A board search is already running.')
  running = true
  try {
    const probe = testBoard || require('./scraper/ats').testBoard
    const have = new Set(existing.map(b => `${b?.provider}:${String(b?.slug || '').toLowerCase()}`))
    const watchedNames = new Set(existing.map(b => String(b?.label || '').trim().toLowerCase()).filter(Boolean))
    // Required here rather than at the top so the slug logic can be loaded
    // (and tested) without opening the database.
    const names = (companies || require('./database').getAtsDiscoveryCompanies(maxCompanies * 3))
      .filter(c => !watchedNames.has(String(c).trim().toLowerCase()))
      .slice(0, maxCompanies)

    const hits = []
    let probed = 0
    let stopped = ''
    let first = true
    outer:
    for (const company of names) {
      const slugs = slugCandidates(company)
      if (slugs.some(s => PROVIDERS.some(p => have.has(`${p}:${s}`)))) continue
      for (const slug of slugs) {
        for (const provider of PROVIDERS) {
          if (!first && delayMs > 0) await sleep(delayMs)
          first = false
          probed++
          try {
            const res = await probe(provider, slug)
            // An empty board is as likely to be someone else's dormant account
            // as the employer's, so only a board with open roles is offered.
            if (res?.count > 0) {
              hits.push({ company, provider, slug, count: res.count, sample: res.sample || [], boardName: res.boardName || '' })
              continue outer
            }
          } catch (err) {
            if (err?.blocked) { stopped = 'The board providers asked Hiro to slow down; try again later.'; break outer }
            // Not found, or unreachable: try the next candidate.
          }
        }
      }
    }
    return { hits, probed, companies: names.length, stopped }
  } finally {
    running = false
  }
}

module.exports = { discover, slugCandidates, PROVIDERS, MAX_COMPANIES }
