// Turning an interview into a calendar event. Pure, so the time handling is
// testable from plain Node — see test/run.js.
//
// Times: `scheduled_at` is the desktop's wall-clock time ("2026-08-12 14:00"),
// or a bare date when the reply gave no time, or occasionally an instant with an
// offset. parseLocal reads the first two as THIS phone's local time and the
// third as the instant it names. The event is then written with the phone's own
// IANA zone, so the calendar stores 14:00-in-this-zone rather than a UTC time
// the OS might shift. When the recruiter wrote the time in another zone the
// desktop has already converted it, and the note says what they actually wrote.
const { parseLocal } = require('./dates')

const DEFAULT_MINUTES = 60

function interviewEvent(iv, { timeZone, durationMinutes = DEFAULT_MINUTES } = {}) {
  const start = parseLocal(iv?.scheduled_at)
  if (!start) return null
  const hasTime = iv.has_time === true || iv.has_time === 1
  const title = `Interview: ${iv.job_title || 'Interview'}${iv.company ? ` at ${iv.company}` : ''}`
  const notes = [
    iv.source_zone && iv.source_local ? `They wrote: ${iv.source_local} ${iv.source_zone}.` : '',
    hasTime ? '' : 'Hiro found the date but not the time — check the recruiter’s message.',
    iv.note || '',
    iv.job_url ? iv.job_url : '',
    'Added from Hiro.',
  ].filter(Boolean).join('\n')

  if (!hasTime) {
    // All-day events are dates, not instants: midnight to midnight local.
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
    return { title, notes, startDate: day, endDate: next, allDay: true, timeZone }
  }
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000)
  return { title, notes, startDate: start, endDate: end, allDay: false, timeZone }
}

// The phone's IANA zone, or undefined to let the OS use its default.
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

// Which of the device's calendars to write to on Android, which has no single
// default: the primary calendar of an account the user can write to, else any
// writable one. Null means none — the caller offers to create a Hiro calendar.
function pickWritableCalendar(calendars) {
  const writable = (calendars || []).filter(c => c && c.allowsModifications !== false
    && (c.accessLevel == null || ['owner', 'editor', 'contributor', 'root'].includes(c.accessLevel)))
  return writable.find(c => c.isPrimary) || writable.find(c => c.isVisible !== false) || writable[0] || null
}

module.exports = { interviewEvent, deviceTimeZone, pickWritableCalendar, DEFAULT_MINUTES }
