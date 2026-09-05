// Health, per watched career board.
//
// The failure this exists to catch is invisible to every other signal in the
// app. Boards are watched one employer at a time and fail one at a time: a slug
// that is renamed or made private returns 404 while the other five keep
// returning jobs. ats.js pushed that onto a `failures` list and then discarded
// it unless EVERY board failed — so a user watching six employers could have
// one dead for weeks while the scan reported success each morning, and the
// aggregate "ATS" health row stayed green because the category was working.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-board-health-' + Date.now())
let config = {}
stub({
  './config': {
    load: () => config,
    update: (fn) => { config = typeof fn === 'function' ? fn(config) : { ...config, ...fn } },
    CONFIG_DIR,
  },
})

const db = service('database.js')
const health = service('automationHealth.js')
const ats = service('scraper/ats.js')
const { check, done } = createChecker()

const BOARDS = [
  { provider: 'greenhouse', slug: 'acme', label: 'Acme' },
  { provider: 'lever', slug: 'globex', label: 'Globex' },
]
const only = (rows, label) => rows.find(r => r.platform === label)

;(async () => {
  await db.init()

  // ── Before anything has run ────────────────────────────────────
  const fresh = health.summariseBoards(BOARDS)
  check('every configured board gets a row', fresh.length, 2)
  check('an unscanned board says so', only(fresh, 'Acme').status, 'unknown')
  check('and does not claim anything is wrong', only(fresh, 'Acme').headline, 'Not scanned yet')
  check('the row carries the provider so the user knows where to fix it',
    only(fresh, 'Acme').provider, 'greenhouse')

  // ── A healthy board ────────────────────────────────────────────
  health.recordBoard({ key: 'greenhouse:acme', found: 12, matched: 3 })
  const ok = only(health.summariseBoards(BOARDS), 'Acme')
  check('a board that returned postings is ok', ok.status, 'ok')
  check('and reports how many', /12 posting/.test(ok.headline), true)

  // A board publishing plenty of roles that match no keywords is HEALTHY. This
  // is why the count reported is what the board published, not what survived
  // filtering — otherwise every narrow search looks like a broken board.
  health.recordBoard({ key: 'lever:globex', found: 40, matched: 0 })
  check('a board whose postings all filtered out is still healthy',
    only(health.summariseBoards(BOARDS), 'Globex').status, 'ok')

  // ── A renamed or private board ─────────────────────────────────
  health.recordBoard({ key: 'greenhouse:acme', error: 'board not found — check the slug', notFound: true })
  const gone = only(health.summariseBoards(BOARDS), 'Acme')
  check('a 404 is critical immediately', gone.status, 'critical')
  // Immediately, and not after a streak: unlike an empty scrape this is not
  // ambiguous, and it will not fix itself.
  check('and says the board is gone rather than empty', gone.headline, 'This board no longer exists')
  check('and names the slug to fix', /acme/.test(gone.advice), true)
  check('and points at where to fix it', /Settings/.test(gone.advice), true)
  // Meanwhile the other board is untouched — the whole point of separate keys.
  check('one dead board does not affect another',
    only(health.summariseBoards(BOARDS), 'Globex').status, 'ok')

  // A fixed slug has to clear the verdict, or a corrected board stays red.
  health.recordBoard({ key: 'greenhouse:acme', found: 5, matched: 1 })
  check('a working scan retracts the missing-board verdict',
    only(health.summariseBoards(BOARDS), 'Acme').status, 'ok')

  // ── A board that fails to load ─────────────────────────────────
  health.recordBoard({ key: 'lever:globex', error: 'HTTP 503' })
  const once = only(health.summariseBoards(BOARDS), 'Globex')
  check('one failure is a warning, not a fault', once.status, 'warning')
  check('and says it may be a blip', /blip|repeats/.test(once.advice), true)
  health.recordBoard({ key: 'lever:globex', error: 'HTTP 503' })
  const twice = only(health.summariseBoards(BOARDS), 'Globex')
  check('repeated failures are critical', twice.status, 'critical')
  check('and quote what the provider said', /HTTP 503/.test(twice.advice), true)

  // ── An employer with nothing open ──────────────────────────────
  // Not a fault. A hiring freeze must never be reported as a broken board.
  const quiet = [{ provider: 'ashby', slug: 'quiet', label: 'Quiet Co' }]
  health.recordBoard({ key: 'ashby:quiet', found: 0, matched: 0 })
  check('one empty scan is not a problem', only(health.summariseBoards(quiet), 'Quiet Co').status, 'ok')
  health.recordBoard({ key: 'ashby:quiet', found: 0, matched: 0 })
  health.recordBoard({ key: 'ashby:quiet', found: 0, matched: 0 })
  const empty = only(health.summariseBoards(quiet), 'Quiet Co')
  check('a run of empty scans is worth mentioning', empty.status, 'warning')
  // …but as a "check the slug" prompt, not as a failure. A valid but wrong slug
  // returns an empty board rather than an error, which is the case this catches.
  check('and never claims the board is broken', /never returned|careers page/.test(empty.advice), true)

  // ── The scraper reports each board separately ──────────────────
  // Without this the health records above could never be written: the failure
  // was swallowed inside scrape() unless every board failed.
  //
  // fetch is stubbed rather than reaching a real board. A unit suite that makes
  // network calls fails somebody's branch on a blip, which is exactly why the
  // live checks live in test/contract instead.
  const realFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
  const seen = []
  try {
    await ats.scrape(
      { atsBoards: [{ provider: 'greenhouse', slug: 'definitely-not-a-real-board-xyz', label: 'Ghost' }],
        jobKeywords: '', jobLocation: '' },
      { onBoard: (b) => seen.push(b) }
    ).catch(() => {})
  } finally {
    global.fetch = realFetch
  }
  check('a failing board is reported to the caller', seen.length, 1)
  check('with a key that identifies it', seen[0].key, 'greenhouse:definitely-not-a-real-board-xyz')
  check('and its label', seen[0].label, 'Ghost')
  check('and the fact that it was a 404 rather than a blip', seen[0].notFound, true)

  done()
})()
