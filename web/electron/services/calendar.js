// iCalendar (.ics) export for detected and hand-entered interviews.
//
// Hiro already knows when every interview is — it parses the time out of the
// recruiter's email — but that information lived only inside the app, so the
// user still had to re-enter it into their real calendar by hand. This emits a
// standard .ics feed that Calendar, Outlook, and Google all import.
//
// RFC 5545 with no external dependency: the format is small enough that pulling
// in a library would be more surface than it saves.

const CRLF = '\r\n'
const PRODID = '-//Hiro//Job Application Tracker//EN'

// Interviews with no stated time are all-day events. An hour is the usual
// default for one that does have a time — recruiters rarely say how long.
const DEFAULT_DURATION_MINUTES = 60

// Escape per RFC 5545 §3.3.11: backslash, semicolon, comma, and newlines.
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

// Lines longer than 75 octets must be folded, continued with a single space.
// Unfolded long summaries are the most common reason an .ics silently fails to
// import.
function foldLine(line) {
  if (line.length <= 75) return line
  const parts = [line.slice(0, 75)]
  let rest = line.slice(75)
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74))
    rest = rest.slice(74)
  }
  if (rest.length) parts.push(' ' + rest)
  return parts.join(CRLF)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

// SQLite stores interview times as local "YYYY-MM-DD HH:MM:SS". Parse into the
// component parts rather than through Date, so a local wall-clock time isn't
// shifted by the machine's UTC offset on the way out.
function parseLocalSql(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''))
  if (!m) return null
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: m[4] != null ? Number(m[4]) : 0,
    minute: m[5] != null ? Number(m[5]) : 0,
  }
}

// Floating local date-time (no TZID, no trailing Z). An interview at 2pm is at
// 2pm wherever the user's calendar is — which is the same city the recruiter
// meant — and a floating value is what every client interprets that way.
function formatLocal(p) {
  return `${p.year}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}00`
}

function formatDate(p) {
  return `${p.year}${pad(p.month)}${pad(p.day)}`
}

function addMinutes(p, minutes) {
  const d = new Date(p.year, p.month - 1, p.day, p.hour, p.minute + minutes)
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(),
  }
}

function addDays(p, days) {
  const d = new Date(p.year, p.month - 1, p.day + days)
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: 0, minute: 0 }
}

function utcStamp(date = new Date()) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

// Stable per-event UID so re-importing updates the existing entry instead of
// creating a duplicate.
function eventUid(event) {
  return `hiro-interview-${event.id}@hiro.local`
}

function buildEvent(event, stamp) {
  const start = parseLocalSql(event.scheduled_at)
  if (!start) return null

  const hasTime = event.has_time === 1 || event.has_time === true
  const lines = ['BEGIN:VEVENT']
  lines.push(`UID:${eventUid(event)}`)
  lines.push(`DTSTAMP:${stamp}`)

  if (hasTime) {
    lines.push(`DTSTART:${formatLocal(start)}`)
    lines.push(`DTEND:${formatLocal(addMinutes(start, DEFAULT_DURATION_MINUTES))}`)
  } else {
    // All-day events use DATE values, and DTEND is exclusive — the day after.
    lines.push(`DTSTART;VALUE=DATE:${formatDate(start)}`)
    lines.push(`DTEND;VALUE=DATE:${formatDate(addDays(start, 1))}`)
  }

  const title = event.job_title || 'Interview'
  const company = event.company || ''
  lines.push(`SUMMARY:${escapeText(company ? `Interview: ${title} at ${company}` : `Interview: ${title}`)}`)

  const description = [
    company ? `Company: ${company}` : null,
    event.platform ? `Found via: ${event.platform}` : null,
    event.note ? `Email subject: ${event.note}` : null,
    // The stored time is a conversion when the employer named a zone — say so
    // here too, so an exported .ics carries the same check the app shows.
    event.source_zone && event.source_local
      ? `They wrote: ${event.source_local} ${event.source_zone} — shown here in your local time.`
      : null,
    event.source === 'inbox'
      ? 'Time detected automatically from the recruiter\'s email — double-check it against the original.'
      : null,
    event.job_url || null,
  ].filter(Boolean).join('\n')
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`)
  if (event.job_url) lines.push(`URL:${escapeText(event.job_url)}`)

  // An auto-detected time is a best-effort parse, so it's marked tentative —
  // the user's calendar then shows it as unconfirmed rather than as fact.
  lines.push(`STATUS:${event.source === 'inbox' ? 'TENTATIVE' : 'CONFIRMED'}`)
  lines.push('END:VEVENT')
  return lines
}

// Build a complete calendar from interview rows (as returned by
// database.getUpcomingInterviews). Rows whose date can't be parsed are skipped
// rather than emitted as a broken event that breaks the whole import.
function buildCalendar(events) {
  const stamp = utcStamp()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Hiro Interviews',
  ]
  let count = 0
  for (const event of events || []) {
    const block = buildEvent(event, stamp)
    if (!block) continue
    lines.push(...block)
    count++
  }
  lines.push('END:VCALENDAR')
  return { ics: lines.map(foldLine).join(CRLF) + CRLF, count }
}

module.exports = { buildCalendar, buildEvent, escapeText, foldLine, parseLocalSql, DEFAULT_DURATION_MINUTES }
