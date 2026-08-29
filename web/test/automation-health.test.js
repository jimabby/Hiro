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
let storedConfig = {}
stub({ './config': {
  load: () => ({ ...storedConfig }),
  update: patch => {
    storedConfig = typeof patch === 'function' ? patch({ ...storedConfig }) : { ...storedConfig, ...patch }
    return storedConfig
  },
  CONFIG_DIR,
} })

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

// A diagnosed failure changes behaviour, not just the dashboard: pause the
// platform so the next scheduled scan does not hammer it again.
{
  const now = Date.now()
  health.startCooldown('Indeed', 'blocked', now)
  const cooldown = health.getCooldown('Indeed', now + 1000)
  check('automation failure starts a cooldown', cooldown.active, true)
  check('cooldown remembers why it paused', cooldown.reason, 'blocked')
  check('cooldown expires', health.getCooldown('Indeed', now + 7 * 3600000).active, false)
}

// ── Named selector breakage ────────────────────────────────────
// The streak heuristic can only ever say "something is broken". A probe names
// the selector that moved, which is the difference between an alarm and a fix.
{
  const d = health.diagnose('Seek', [ev('selector-stale', { detail: 'jobTitle', count: 1 }), ev('scrape-empty')])
  check('a stale selector is critical', d.status, 'critical')
  check('the broken selector is named', d.headline.includes('jobTitle'), true)
  check('the stale selectors are machine-readable', d.staleSelectors, ['jobTitle'])
  check('the advice points at the file', /scraper\/seek\.js/.test(d.advice), true)
}
{
  const d = health.diagnose('Indeed', [ev('selector-stale', { detail: 'jobTitle, companyName', count: 2 })])
  check('several stale selectors are all named',
    d.headline.includes('jobTitle') && d.headline.includes('companyName'), true)
  check('several stale selectors are all listed', d.staleSelectors, ['jobTitle', 'companyName'])
}

// A broken card container is a different message: nothing could be read at all,
// rather than one field being unreadable.
{
  const d = health.diagnose('Seek', [ev('selector-stale', { detail: 'job-card', count: 1 })])
  check('a broken card selector is reported as a markup change',
    /results markup has changed/.test(d.headline), true)
  check('the card advice explains nothing could be read',
    /no listing could be read/.test(d.advice), true)
}

// The partial break is the whole point: cards ARE being found, so no empty
// streak ever accumulates, but one field is unreadable so every listing is
// discarded and the scan reports a healthy-looking zero. Before the probe this
// was invisible.
{
  const d = health.diagnose('Seek', [
    ev('selector-stale', { detail: 'jobTitle' }),
    ev('scrape-empty'),
    ev('scrape-ok', { count: 20 }),
  ])
  check('a partial break is caught even after a successful scrape', d.status, 'critical')
  check('a partial break explains why the scan looked empty',
    /discarded|looked empty/.test(d.advice), true)
}

// A stale report must not outrank the causes that make every selector miss for
// reasons that have nothing to do with the markup.
{
  const d = health.diagnose('Seek', [ev('session-expired'), ev('selector-stale', { detail: 'jobTitle' })])
  check('an expired login still leads', d.headline, 'Login has expired')
}
{
  const d = health.diagnose('Seek', [ev('blocked'), ev('blocked'), ev('selector-stale', { detail: 'jobTitle' })])
  check('being blocked still leads', /blocking us/.test(d.headline), true)
}

// A stale report that has scrolled out of the recent window must stop driving
// the verdict, or one bad day would brand a platform broken indefinitely.
{
  const stale = ev('selector-stale', { detail: 'jobTitle' })
  const recent = Array.from({ length: 6 }, () => ev('scrape-ok', { count: 12 }))
  const d = health.diagnose('Seek', [...recent, stale])
  check('an old selector report stops driving the verdict', d.status, 'ok')
}

// ─── A success retracts the failure it answers ───────────────────
//
// Scrolling out of the window was the ONLY way a stale report stopped counting,
// and the window is six events deep — so a scraper that had been fixed went on
// being reported critical for six more scans, and recordScrape re-armed the
// six-hour cooldown on every one of those verdicts. A platform pulling twenty
// listings a scan kept pausing itself for the better part of a week.
{
  const d = health.diagnose('Seek', [
    ev('scrape-ok', { count: 20 }),
    ev('scrape-ok', { count: 18 }),
    ev('scrape-ok', { count: 22 }),
    ev('selector-stale', { detail: 'jobTitle' }),
    ev('scrape-empty'),
  ])
  check('a fixed selector is not still reported broken', d.status, 'ok')
  // This is the exact predicate recordScrape re-arms the cooldown on.
  check('and the platform is not paused again',
    d.status === 'critical' && /found nothing|selector/i.test(d.headline), false)
}

// One successful scrape is enough — the fix landed, the evidence says so.
{
  const d = health.diagnose('Seek', [
    ev('scrape-ok', { count: 15 }),
    ev('selector-stale', { detail: 'salary' }),
  ])
  check('a single healthy scrape clears a stale selector report', d.status, 'ok')
}

// Blocks are transient by nature, so getting results again answers them too.
{
  const d = health.diagnose('Seek', [
    ev('scrape-ok', { count: 11 }),
    ev('blocked'),
    ev('blocked'),
  ])
  check('results after a block mean we are through it', d.status, 'ok')
}

// But scraping and submitting fail independently, so a scrape must NOT vouch
// for the login or the application form. Clearing these on 'scrape-ok' would
// hide a genuinely broken form the moment the search page happened to load.
{
  const d = health.diagnose('Seek', [
    ev('scrape-ok', { count: 30 }),
    ev('session-expired'),
  ])
  check('a working search does not vouch for the login', d.headline, 'Login has expired')
}
{
  const d = health.diagnose('Seek', [
    ev('scrape-ok', { count: 30 }),
    ev('selector-miss'),
    ev('selector-miss'),
  ])
  check('a working search does not vouch for the apply form',
    /forms are not being completed/.test(d.headline), true)
}
// A submission that went through is what answers those.
{
  const d = health.diagnose('Seek', [
    ev('apply-ok'),
    ev('session-expired'),
    ev('selector-miss'),
    ev('selector-miss'),
    ev('scrape-ok', { count: 30 }),
  ])
  check('a successful apply clears both apply-side failures', d.status, 'ok')
}

done()
