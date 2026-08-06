// The phone's stats and chart series must agree with the desktop's.
//
// They did not. The desktop excluded never-submitted rows ('skipped', 'held') from
// its rate denominators but not from its counts; the phone copied that, so a
// review-heavy scan inflated "Today", "This Week" and "All Time" on both with
// applications no employer ever received. These assertions pin the corrected
// definitions on the phone side, and mirror
// web/test/stats-lifecycle.test.js on the desktop side — if the two drift again,
// one of the two suites fails.

const { createChecker, NOW, at, app } = require('./helpers')
const { deriveStats, derivePerDay, UNSENT_STATUSES } = require('../src/stats')

const { check, done } = createChecker()

// ── The definitions themselves ───────────────────────────────────
check('unsent statuses match the desktop', UNSENT_STATUSES, ['skipped', 'held'])

// ── Counts exclude never-submitted rows ──────────────────────────
// 5 submitted today with a spread of outcomes, plus one skipped and one held.
const rows = [
  app({ status: 'interview' }),
  app({ status: 'offer' }),
  app({ status: 'rejected' }),
  app({ status: 'pending' }),
  app({ status: 'applied' }),
  app({ status: 'skipped' }),
  app({ status: 'held' }),
]

const stats = deriveStats(rows, { now: NOW })

check('all-time counts submitted applications only', stats.totalAllTime, 5)
check('today counts submitted applications only', stats.totalToday, 5)
check('this week counts submitted applications only', stats.totalThisWeek, 5)
// Reported rather than hidden: a scan that skipped everything must read as
// "0 applied · 12 skipped", not an unexplained zero.
check('unsent rows are surfaced separately', stats.unsentToday, 2)
check('row count still covers the whole list', stats.rowsAllTime, 7)

// ── Rates ────────────────────────────────────────────────────────
// 4 of the 5 submitted got a reply of some kind.
check('response rate counts every kind of reply', stats.responseRate, 80)
// Interview + offer = 2 of 5. An offer implies the interview stage was reached,
// which is the regression that mattered: promoting a job to Offer must not lower
// either rate.
check('interview rate counts offers as interviews', stats.interviewRate, 40)
check('interviews tile includes offers', stats.interviews, 2)

const promoted = deriveStats(
  rows.map(r => (r.status === 'interview' ? { ...r, status: 'offer' } : r)),
  { now: NOW }
)
check('promoting to offer does not lower the response rate',
  promoted.responseRate >= stats.responseRate, true)
check('promoting to offer does not lower the interview rate',
  promoted.interviewRate >= stats.interviewRate, true)

// ── Breakdowns ───────────────────────────────────────────────────
const platformTotal = stats.byPlatform.reduce((n, p) => n + p.count, 0)
check('platform chart agrees with the tiles', platformTotal, 5)
// …while the status breakdown still shows them, because naming the status is the
// entire point of that chart.
check('status chart still lists skipped rows',
  stats.byStatus.find(s => s.status === 'skipped')?.count, 1)
check('status chart still lists held rows',
  stats.byStatus.find(s => s.status === 'held')?.count, 1)

// ── Empty input ──────────────────────────────────────────────────
const empty = deriveStats([], { now: NOW })
check('no applications means zero, not NaN', [empty.totalAllTime, empty.responseRate, empty.interviewRate], [0, 0, 0])
check('undefined input is tolerated', deriveStats(undefined, { now: NOW }).totalAllTime, 0)

// ── Time windows ─────────────────────────────────────────────────
// "This week" is the last 7 local days inclusive, matching the desktop's
// WEEK_START of start-of-day minus 6 days.
const spread = [
  app({ applied_at: at(0) }),
  app({ applied_at: at(3) }),
  app({ applied_at: at(6) }),   // inside the window
  app({ applied_at: at(7) }),   // outside it
  app({ applied_at: at(40) }),
]
const windowed = deriveStats(spread, { now: NOW })
check('today counts only today', windowed.totalToday, 1)
check('this week includes the sixth day back', windowed.totalThisWeek, 3)
check('all time includes everything submitted', windowed.totalAllTime, 5)

// A row applied late in the local evening still belongs to that local day. This
// is the case that breaks when the boundary is computed in UTC.
const lateEvening = deriveStats([app({ applied_at: at(0, 23) })], { now: NOW })
check('a late-evening application still counts as today', lateEvening.totalToday, 1)

// ── Per-day chart ────────────────────────────────────────────────
const perDay = derivePerDay(spread, 7, { now: NOW })
check('per-day returns one entry per requested day', perDay.length, 7)
check('per-day is padded with zeros rather than gaps',
  perDay.every(d => typeof d.count === 'number'), true)
check('per-day totals match the week tile',
  perDay.reduce((n, d) => n + d.count, 0), 3)
check('per-day ends on today', perDay[perDay.length - 1].date, '2026-08-06')
check('per-day starts six days back', perDay[0].date, '2026-07-31')

// Labels are LOCAL dates. toISOString().slice(0,10) would label them with the UTC
// day, shifting every bar for anyone east of Greenwich.
check('per-day labels are local dates',
  perDay.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), true)

const perDayUnsent = derivePerDay(
  [app({ status: 'held', applied_at: at(0) }), app({ status: 'skipped', applied_at: at(1) })],
  7, { now: NOW }
)
check('per-day draws no bar for a held or skipped row',
  perDayUnsent.reduce((n, d) => n + d.count, 0), 0)

// ── Falling back to updated_at ────────────────────────────────────
// A row restored from the cloud can arrive with no applied_at.
const noAppliedAt = deriveStats([app({ applied_at: null, updated_at: at(0) })], { now: NOW })
check('updated_at stands in for a missing applied_at', noAppliedAt.totalToday, 1)

done()
