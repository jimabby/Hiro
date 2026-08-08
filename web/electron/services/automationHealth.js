// Whether the automation is actually working, per platform.
//
// The failure this exists to catch is the quiet one. When a site changes its
// markup, the scraper does not crash — it finds zero cards and reports "no
// listings matched", which is indistinguishable from a narrow search. The app
// goes on running its daily scan, reporting success, and applying to nothing.
// A user can lose weeks to that before noticing.
//
// So the useful signal is not any single scan. It is the shape over time:
//
//   * zero results once      — probably a narrow search, say nothing
//   * zero results repeatedly, while the page loads and is not blocking us
//                            — the selectors have almost certainly moved
//   * blocked                — the site is refusing us; a different problem
//                              with a different fix, and not a bug
//   * session expired        — the login has lapsed; the one case the user can
//                              fix in thirty seconds, so say so loudly
//
// Recording happens in the applicator rather than inside each scraper: it
// already knows the platform, the result count, whether the site blocked us and
// how each apply went, and putting it there keeps four scrapers unchanged.

const database = require('./database')
const configService = require('./config')

// How many consecutive empty-but-healthy scrapes before we call it a selector
// break. Two could easily be a quiet week on a narrow search; three in a row on
// a search that used to return results is a different claim.
const EMPTY_STREAK_FOR_SUSPICION = 3

// Beyond this, "last successful scrape" stops being reassuring.
const STALE_SUCCESS_HOURS = 72

function recordScrape(platform, { found = 0, blocked = false, error = null } = {}) {
  try {
    database.recordAutomationEvent({
      platform,
      kind: blocked ? 'blocked' : error ? 'error' : found > 0 ? 'scrape-ok' : 'scrape-empty',
      detail: error || (blocked ? 'Site served a challenge instead of results' : `${found} listing(s)`),
      count: found,
    })
    if (blocked) startCooldown(platform, 'blocked')
    else {
      const diagnosis = diagnose(platform, database.getAutomationEvents(platform, 40))
      if (diagnosis.status === 'critical' && /found nothing/.test(diagnosis.headline)) {
        startCooldown(platform, 'selector-suspected')
      }
    }
  } catch { /* health tracking must never break a scan */ }
}

function recordApply(platform, { success, reason = '' } = {}) {
  try {
    database.recordAutomationEvent({
      platform,
      kind: success ? 'apply-ok' : classifyApplyFailure(reason),
      detail: reason || (success ? 'Submitted' : 'Failed'),
      count: success ? 1 : 0,
    })
    if (!success) {
      const diagnosis = diagnose(platform, database.getAutomationEvents(platform, 40))
      if (/forms are not being completed/.test(diagnosis.headline)) startCooldown(platform, 'selector-miss')
    }
  } catch { /* as above */ }
}

function startCooldown(platform, reason, now = Date.now()) {
  try {
    const cfg = configService.load()
    const hours = Math.max(1, Number(cfg.automationCooldownHours) || 6)
    const until = new Date(now + hours * 3600000).toISOString()
    configService.update(current => ({
      ...current,
      automationCooldowns: {
        ...(current.automationCooldowns || {}),
        [platform]: { until, reason },
      },
    }))
    return { until, reason }
  } catch { return null }
}

function getCooldown(platform, now = Date.now()) {
  try {
    const entry = configService.load().automationCooldowns?.[platform]
    const until = typeof entry === 'string' ? entry : entry?.until
    if (!until || new Date(until).getTime() <= now) return { active: false, until: null, reason: null }
    return { active: true, until, reason: entry?.reason || 'automation-health' }
  } catch { return { active: false, until: null, reason: null } }
}

// An apply failure is only useful if it says which kind it is. These three have
// completely different fixes and were previously one undifferentiated string.
function classifyApplyFailure(reason) {
  const text = String(reason || '')
  if (/session expired|please re-login|not logged in/i.test(text)) return 'session-expired'
  if (/button not found|selector|no such element|waiting for selector/i.test(text)) return 'selector-miss'
  return 'apply-failed'
}

// Roll the event log up into one verdict per platform.
//
// Every branch has to end in something the user can do. "Degraded" with no next
// step is just anxiety.
function summarise(platforms, now = Date.now()) {
  const out = []
  for (const platform of platforms) {
    const events = database.getAutomationEvents(platform, 40)
    out.push(diagnose(platform, events, now))
  }
  return out
}

function diagnose(platform, events, now = Date.now()) {
  const lastScrapeOk = events.find(e => e.kind === 'scrape-ok')
  const lastApplyOk = events.find(e => e.kind === 'apply-ok')
  const lastEvent = events[0] || null

  const base = {
    platform,
    lastScrapeOkAt: lastScrapeOk?.at || null,
    lastScrapeCount: lastScrapeOk?.count ?? null,
    lastApplyOkAt: lastApplyOk?.at || null,
    lastEventAt: lastEvent?.at || null,
  }

  if (events.length === 0) {
    return { ...base, status: 'unknown', headline: 'No scans recorded yet', advice: 'Run a scan to establish a baseline.' }
  }

  // Session expiry first: it is the most actionable and it makes every other
  // signal below meaningless while it lasts.
  if (events.slice(0, 5).some(e => e.kind === 'session-expired')) {
    return {
      ...base,
      status: 'critical',
      headline: 'Login has expired',
      advice: `Open Settings → ${platform} Session and log in again. Applications will keep failing until you do.`,
    }
  }

  // Blocked is not a bug and must not be reported as one — the fix is to wait
  // or slow down, not to check for a broken selector.
  const recentBlocks = events.slice(0, 5).filter(e => e.kind === 'blocked').length
  if (recentBlocks >= 2) {
    return {
      ...base,
      status: 'critical',
      headline: 'The site is blocking us',
      advice: 'Lower the daily limit and pages per scan, and leave it a few hours. This is rate limiting, not a broken scraper.',
    }
  }
  if (recentBlocks === 1) {
    return {
      ...base,
      status: 'warning',
      headline: 'Blocked once recently',
      advice: 'One challenge is normal. If it repeats, reduce the daily limit and pages per scan.',
    }
  }

  // The canary. Consecutive empty scrapes with no block and no error is the
  // signature of markup that moved underneath us.
  let emptyStreak = 0
  for (const e of events) {
    if (e.kind === 'scrape-empty') emptyStreak++
    else if (e.kind === 'scrape-ok' || e.kind === 'blocked' || e.kind === 'error') break
  }
  if (emptyStreak >= EMPTY_STREAK_FOR_SUSPICION) {
    return {
      ...base,
      status: 'critical',
      headline: `${emptyStreak} scans in a row found nothing`,
      advice: lastScrapeOk
        ? `This last worked ${describeAge(lastScrapeOk.at, now)}. If your search still returns results on the site itself, ${platform}'s page layout has probably changed and the scraper needs updating.`
        : `This platform has never returned a listing. Check the keywords and location first, then whether ${platform} is reachable from this machine.`,
    }
  }

  const selectorMisses = events.slice(0, 10).filter(e => e.kind === 'selector-miss').length
  if (selectorMisses >= 2) {
    return {
      ...base,
      status: 'warning',
      headline: 'Application forms are not being completed',
      advice: `Scraping works but submitting does not, which usually means ${platform} changed its application form. Held drafts are safe; nothing was sent.`,
    }
  }

  if (emptyStreak > 0) {
    return {
      ...base,
      status: 'warning',
      headline: `Last ${emptyStreak} scan${emptyStreak === 1 ? '' : 's'} found nothing`,
      advice: 'Usually a search that is too narrow, or one that has been exhausted. Worth widening the keywords if it continues.',
    }
  }

  if (lastScrapeOk && ageHours(lastScrapeOk.at, now) > STALE_SUCCESS_HOURS) {
    return {
      ...base,
      status: 'warning',
      headline: 'No successful scan in a while',
      advice: `The last one was ${describeAge(lastScrapeOk.at, now)}. Check that scheduled scans are still enabled.`,
    }
  }

  return {
    ...base,
    status: 'ok',
    headline: `Working — ${lastScrapeOk?.count ?? 0} listing(s) on the last scan`,
    advice: '',
  }
}

function ageHours(at, now = Date.now()) {
  const t = new Date(String(at).replace(' ', 'T') + (String(at).includes('T') ? '' : 'Z')).getTime()
  if (!Number.isFinite(t)) return Infinity
  return (now - t) / 3600000
}

function describeAge(at, now = Date.now()) {
  const hours = ageHours(at, now)
  if (!Number.isFinite(hours)) return 'at an unknown time'
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${Math.round(hours)} hour(s) ago`
  return `${Math.round(hours / 24)} day(s) ago`
}

module.exports = {
  recordScrape, recordApply, summarise, diagnose, classifyApplyFailure,
  startCooldown, getCooldown,
  EMPTY_STREAK_FOR_SUSPICION, STALE_SUCCESS_HOURS,
}
