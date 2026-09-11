// Calendar-day helpers for the renderer.
//
// Two things the pages kept getting wrong, now stated once:
//
// 1. "Is this date today?" is a calendar question, not an arithmetic one.
//    Timeline used to anchor the day at noon and divide the gap to `now` by
//    86,400,000 — so before midday, today's entry read "-1 days ago" and
//    yesterday's read "Today". Comparing the two local calendar days is the
//    only comparison that is right at every hour.
//
// 2. applied_at is stored in UTC, but the day a user sees is their local day.
//    Querying a local day therefore means converting its local midnight
//    boundaries to UTC before they reach the database. Timeline did this for a
//    single expanded day and forgot for "Expand All", which queried the local
//    day string as if it were UTC — in Australia that is ten hours out, so a
//    morning's applications appeared under the previous day or not at all.

const pad = (n) => String(n).padStart(2, '0')

// YYYY-MM-DD for a Date, in local time.
export function localDayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Whole days between two local calendar days (positive when `day` is in the
// future). Both arguments are YYYY-MM-DD strings.
export function daysBetweenLocal(day, today = localDayISO()) {
  const a = new Date(`${day}T00:00:00`)
  const b = new Date(`${today}T00:00:00`)
  return Math.round((a - b) / 86400000)
}

// "Today", "Yesterday", "3 days ago", or the full date. `now` is injectable so
// the label can be tested at any hour.
export function relativeDay(day, now = new Date()) {
  const diff = -daysBetweenLocal(day, localDayISO(now))
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return `${diff} days ago`
  if (diff === -1) return 'Tomorrow'
  if (diff < -1) return `In ${-diff} days`
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

// The UTC bounds of one local calendar day, in the 'YYYY-MM-DD HH:MM:SS'
// shape the applications table stores applied_at in.
export function localDayBoundsUTC(day) {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start.getTime() + 86400000 - 1000)
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ')
  return { dateFrom: fmt(start), dateTo: fmt(end) }
}
