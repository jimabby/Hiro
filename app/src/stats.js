// Stats and chart series, derived from a list of applications.
//
// This logic used to live inside CloudClient in supabase.js, tangled up with the
// Supabase client — which meant it could not be tested, and it drifted from the
// desktop's getStats(): the phone counted skipped and held rows as applications
// in "Today", "This Week" and "All Time" long after the desktop stopped. The two
// implementations have to agree, so the part that has to agree is now a pure
// function with a test that pins it.
//
// CommonJS for the same reason as dates.js — see the note at the top of that file.

// Statuses that mean the employer got back to us. An offer implies the interview
// stage was reached and a rejection is still a reply, so both count.
// Mirrors RESPONDED_STATUSES in web/electron/services/database.js.
const RESPONDED_STATUSES = ['interview', 'offer', 'rejected', 'pending']

// Rows drafted but never submitted: scored below the match threshold ('skipped')
// or parked by review mode ('held'). They must stay out of every application
// count, chart and rate — mirrors UNSENT_STATUSES on the desktop.
const UNSENT_STATUSES = ['skipped', 'held']

const isUnsent = (a) => UNSENT_STATUSES.includes(a.status)

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Local YYYY-MM-DD. toISOString() is UTC and would label a bar with the previous
// day for anyone east of Greenwich.
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const appliedTime = (a) => new Date(a.applied_at || a.updated_at || 0).getTime()

// `now` is injectable so the tests are not at the mercy of the clock.
function deriveStats(apps, { now = new Date() } = {}) {
  const rows = apps || []
  const today = startOfDay(now).getTime()
  const weekAgo = today - 6 * 86400000

  const sent = rows.filter(a => !isUnsent(a))
  const interviews = rows.filter(a => a.status === 'interview' || a.status === 'offer').length
  const responded = rows.filter(a => RESPONDED_STATUSES.includes(a.status)).length

  const byStatus = {}
  const byPlatform = {}
  // byStatus keeps every row — it is a breakdown BY status, so 'held' is the
  // point. byPlatform counts submitted rows only, matching the tiles.
  for (const a of rows) byStatus[a.status] = (byStatus[a.status] || 0) + 1
  for (const a of sent) byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1

  return {
    totalToday: sent.filter(a => appliedTime(a) >= today).length,
    totalThisWeek: sent.filter(a => appliedTime(a) >= weekAgo).length,
    totalAllTime: sent.length,
    // Surfaced rather than hidden, so a scan that skipped everything reads as
    // "0 applied · 12 skipped" instead of an unexplained zero.
    unsentToday: rows.filter(a => isUnsent(a) && appliedTime(a) >= today).length,
    rowsAllTime: rows.length,
    interviews,
    responseRate: sent.length ? Math.round((responded / sent.length) * 100) : 0,
    interviewRate: sent.length ? Math.round((interviews / sent.length) * 100) : 0,
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
    byPlatform: Object.entries(byPlatform).map(([platform, count]) => ({ platform, count })),
  }
}

// Submitted applications per day, padded so the chart always gets a continuous
// series rather than gaps the renderer has to guess at.
function derivePerDay(apps, days = 7, { now = new Date() } = {}) {
  const sent = (apps || []).filter(a => !isUnsent(a))
  const today = startOfDay(now)
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const from = new Date(today.getTime() - i * 86400000)
    const to = new Date(from.getTime() + 86400000)
    out.push({
      date: localDateKey(from),
      count: sent.filter(a => {
        const t = appliedTime(a)
        return t >= from.getTime() && t < to.getTime()
      }).length,
    })
  }
  return out
}

module.exports = {
  deriveStats, derivePerDay,
  RESPONDED_STATUSES, UNSENT_STATUSES, isUnsent, localDateKey,
}
