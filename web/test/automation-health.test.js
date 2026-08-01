// Automation health: telling a broken scraper apart from a quiet job market.
//
// The failure this catches is silent. When a site changes its markup the
// scraper does not crash — it finds zero cards, reports "no listings matched",
// and the daily scan goes on succeeding at nothing. Every case below is about
// which diagnosis the same zero-result scan gets, because the right answer
// depends entirely on what surrounded it.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-health-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const health = service('automationHealth.js')
const { check, done } = createChecker()

// Newest first, matching what the database returns.
const ev = (kind, opts = {}) => ({
  kind,
  count: opts.count ?? 0,
  detail: opts.detail || '',
  at: opts.at || new Date().toISOString(),
})
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString()

// ── Apply failure classification ───────────────────────────────
// Three failures with three different fixes, previously one string.
check('expired session is recognised',
  health.classifyApplyFailure('Seek session expired — please re-login'), 'session-expired')
check('a missing button is a selector problem',
  health.classifyApplyFailure('Submit button not found'), 'selector-miss')
check('a playwright timeout is a selector problem',
  health.classifyApplyFailure('Timeout waiting for selector .foo'), 'selector-miss')
check('anything else stays generic',
  health.classifyApplyFailure('Network error'), 'apply-failed')
check('an empty reason does not crash', health.classifyApplyFailure(''), 'apply-failed')
check('a null reason does not crash', health.classifyApplyFailure(null), 'apply-failed')

// ── No history ─────────────────────────────────────────────────
check('no events reports unknown, not broken',
  health.diagnose('Seek', []).status, 'unknown')

// ── Healthy ────────────────────────────────────────────────────
{
  const d = health.diagnose('Seek', [ev('scrape-ok', { count: 14 }), ev('apply-ok')])
  check('a successful scrape is ok', d.status, 'ok')
  check('the headline reports the count', d.headline.includes('14'), true)
  check('a healthy platform needs no advice', d.advice, '')
}

// ── The canary ─────────────────────────────────────────────────
{
  // One empty scan is a narrow search, not a bug. Crying wolf here would train
  // the user to ignore the panel.
  const one = health.diagnose('Seek', [ev('scrape-empty'), ev('scrape-ok', { count: 9 })])
  check('a single empty scan is only a warning', one.status, 'warning')
  check('a single empty scan blames the search', one.advice.includes('too narrow'), true)

  // Three in a row, unblocked and error-free, is the signature of moved markup.
  const three = health.diagnose('Seek', [
    ev('scrape-empty'), ev('scrape-empty'), ev('scrape-empty'),
    ev('scrape-ok', { count: 12, at: hoursAgo(50) }),
  ])
  check('three empty scans is critical', three.status, 'critical')
  check('the diagnosis names a layout change', three.advice.includes('layout'), true)
  check('it says when this last worked', three.advice.includes('day(s) ago'), true)

  // A success in between resets the streak — the selectors demonstrably work.
  const reset = health.diagnose('Seek', [
    ev('scrape-empty'), ev('scrape-empty'), ev('scrape-ok', { count: 3 }), ev('scrape-empty'),
  ])
  check('a success between empties resets the streak', reset.status, 'warning')

  // Never worked at all is a different message: the search or the network, not
  // a regression.
  const never = health.diagnose('Seek', [ev('scrape-empty'), ev('scrape-empty'), ev('scrape-empty')])
  check('never having worked is still critical', never.status, 'critical')
  check('it points at the search first', never.advice.includes('keywords'), true)
}

// ── Blocked is not a bug ───────────────────────────────────────
{
  const once = health.diagnose('Indeed', [ev('blocked'), ev('scrape-ok', { count: 5 })])
  check('one block is a warning', once.status, 'warning')
  check('one block is described as normal', once.advice.includes('normal'), true)

  const twice = health.diagnose('Indeed', [ev('blocked'), ev('blocked')])
  check('repeated blocks are critical', twice.status, 'critical')
  check('the advice is to back off', twice.advice.includes('daily limit'), true)
  // Crucially it must NOT send the user hunting for a broken selector.
  check('a block is not blamed on the scraper', twice.advice.includes('not a broken scraper'), true)

  // A block interrupts the empty streak: we were refused, not fooled.
  const blockedNotEmpty = health.diagnose('Indeed', [
    ev('scrape-empty'), ev('blocked'), ev('scrape-empty'), ev('scrape-empty'),
  ])
  check('a block breaks the empty streak', blockedNotEmpty.status !== 'critical' || blockedNotEmpty.headline.includes('Blocked'), true)
}

// ── Session expiry wins ────────────────────────────────────────
{
  // The most actionable diagnosis, and it makes every other signal meaningless
  // while it lasts — so it is reported first even alongside empty scans.
  const d = health.diagnose('LinkedIn', [
    ev('session-expired'), ev('scrape-empty'), ev('scrape-empty'), ev('scrape-empty'),
  ])
  check('expired login is critical', d.status, 'critical')
  check('expired login is reported ahead of the canary', d.headline, 'Login has expired')
  check('it says exactly where to fix it', d.advice.includes('Settings → LinkedIn Session'), true)

  // Stale expiry that has since been resolved must not stick around.
  const resolved = health.diagnose('LinkedIn', [
    ev('scrape-ok', { count: 8 }), ev('apply-ok'), ev('apply-ok'), ev('apply-ok'), ev('apply-ok'),
    ev('session-expired'),
  ])
  check('an old expiry is not still reported', resolved.status, 'ok')
}

// ── Scraping works, submitting does not ────────────────────────
{
  const d = health.diagnose('Seek', [
    ev('selector-miss'), ev('selector-miss'), ev('scrape-ok', { count: 11 }),
  ])
  check('form failures are a warning', d.status, 'warning')
  check('it separates scraping from submitting', d.headline.includes('forms'), true)
  check('it reassures that nothing was sent', d.advice.includes('nothing was sent'), true)
}

// ── Stale success ──────────────────────────────────────────────
{
  const d = health.diagnose('Seek', [ev('scrape-ok', { count: 6, at: hoursAgo(100) })], Date.now())
  check('a long-ago success is a warning', d.status, 'warning')
  check('it suggests checking the schedule', d.advice.includes('scheduled scans'), true)

  const fresh = health.diagnose('Seek', [ev('scrape-ok', { count: 6, at: hoursAgo(2) })], Date.now())
  check('a recent success is fine', fresh.status, 'ok')
}

// ── Reported fields ────────────────────────────────────────────
{
  const d = health.diagnose('Seek', [
    ev('scrape-ok', { count: 7, at: hoursAgo(1) }),
    ev('apply-ok', { at: hoursAgo(1) }),
  ])
  check('the last good scrape is reported', !!d.lastScrapeOkAt, true)
  check('the count is reported', d.lastScrapeCount, 7)
  check('the last good apply is reported', !!d.lastApplyOkAt, true)
  check('the platform is carried through', d.platform, 'Seek')
}

// A malformed timestamp must not throw or claim freshness.
check('an unparseable timestamp does not crash',
  health.diagnose('Seek', [ev('scrape-ok', { count: 1, at: 'not-a-date' })]).status, 'warning')

done()
