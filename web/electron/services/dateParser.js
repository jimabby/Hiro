// Best-effort date extraction from free text (job ad bodies and recruiter
// emails). Deliberately deterministic — no AI call — so it costs nothing, runs
// on every scanned job, and is unit-testable. Both entry points return null
// rather than guessing when nothing matches; callers treat a null as "unknown"
// and the UI lets the user fill it in by hand.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
}

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
}

const MONTH_NAMES = Object.keys(MONTHS).join('|')
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join('|')

// Format a Date as local "YYYY-MM-DD HH:MM:SS" — the same shape SQLite's
// datetime() produces, so stored values sort and compare consistently with
// the rest of the schema. toISOString() would silently shift the day in
// non-UTC timezones.
function toLocalSql(d, withTime = true) {
  const p = (n) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}:00` : date
}

// Two-digit years are ambiguous; job ads and emails always mean this century.
function normalizeYear(raw, fallbackYear) {
  if (raw == null) return fallbackYear
  const n = Number(raw)
  if (n >= 1000) return n
  return 2000 + n
}

// A bare "15 March" with no year means the *next* occurrence — in December a
// "5 January" deadline is next year, not eleven months ago.
function resolveBareMonthDay(month, day, now) {
  let year = now.getFullYear()
  const candidate = new Date(year, month, day)
  if (candidate.getTime() < startOfDay(now).getTime()) year += 1
  return new Date(year, month, day)
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function isValidDay(year, month, day) {
  const d = new Date(year, month, day)
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day
}

// ─── Timezones ───────────────────────────────────────────────────────────
//
// A recruiter writes "Thursday 12 March, 2:00 PM AEDT". Until this existed the
// zone was read past and discarded, the time was stored as a bare wall clock,
// and calendarSync then stamped it with `Intl.DateTimeFormat().resolvedOptions()
// .timeZone` — the DESKTOP's zone. For anyone interviewing outside their own
// timezone (a remote role, an overseas employer, a recruiter in another state)
// that is not a rounding error: a Sydney 2pm read on a London machine becomes a
// 2pm London event and the user misses the interview by nine hours.
//
// Offsets rather than IANA names on purpose. The abbreviation in an email is
// what the sender chose to write, and abbreviations are ambiguous across regions
// — "CST" alone is three different zones. An offset is what the sentence
// actually pins down, it is what an .ics VEVENT and a Google Calendar dateTime
// both accept, and it does not pretend to know a political region from three
// letters. `label` keeps the sender's own wording for display.
//
// Australian zones lead the list because Hiro targets Seek and au.indeed; the
// rest are the ones that turn up in remote hiring.
const ZONE_OFFSETS = [
  // [abbreviation, minutes east of UTC]
  ['AEDT', 660], ['AEST', 600], ['ACDT', 630], ['ACST', 570],
  ['AWST', 480], ['ACWST', 525], ['NZDT', 780], ['NZST', 720],
  ['GMT', 0], ['UTC', 0], ['BST', 60], ['WET', 0], ['WEST', 60],
  ['CET', 60], ['CEST', 120], ['EET', 120], ['EEST', 180],
  ['IST', 330], ['SGT', 480], ['HKT', 480], ['JST', 540], ['KST', 540],
  ['EST', -300], ['EDT', -240], ['CST', -360], ['CDT', -300],
  ['MST', -420], ['MDT', -360], ['PST', -480], ['PDT', -420],
]

const ZONE_NAMES = ZONE_OFFSETS.map(([name]) => name).join('|')

// "UTC+10", "GMT-5", "UTC+05:30". Tested BEFORE the named zones, because
// "UTC" and "GMT" are themselves names on that list — matching the name first
// reads "UTC+05:30" as plain UTC and silently throws away the offset, which is
// the whole of the information in it.
const OFFSET_RE = /\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i

const NAMED_RE = new RegExp(`\\b(${ZONE_NAMES})\\b`, 'i')

// A bare "+10:00" / "(-0500)", but only immediately after something that is
// unmistakably a time — one with a colon, or with am/pm on it.
//
// Requiring only "a digit" before the sign was far too loose: "salary
// 90000-120000" matched, reading `0-1200` as UTC-12:00 and silently shifting an
// interview by half a day. A loose signed number in an email body is much more
// often a salary range or a phone number than an offset, so the time it is
// attached to has to look like one.
const BARE_OFFSET_RE =
  /(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))\s*\(?\s*([+-])(\d{2}):?(\d{2})\s*\)?(?!\d)/i

function offsetFrom(sign, hoursText, minutesText) {
  const hours = Number(hoursText)
  const minutes = Number(minutesText || 0)
  if (!Number.isFinite(hours) || hours > 14 || minutes >= 60) return null
  const offsetMinutes = (sign === '-' ? -1 : 1) * (hours * 60 + minutes)
  return { offsetMinutes, label: formatOffset(offsetMinutes) }
}

// Returns { offsetMinutes, label } or null.
function parseTimezone(text) {
  const body = String(text || '')

  const explicit = OFFSET_RE.exec(body)
  if (explicit) {
    const parsed = offsetFrom(explicit[1], explicit[2], explicit[3])
    if (parsed) return parsed
  }

  const named = NAMED_RE.exec(body)
  if (named) {
    const name = named[1].toUpperCase()
    const found = ZONE_OFFSETS.find(([n]) => n === name)
    if (found) return { offsetMinutes: found[1], label: name }
  }

  const bare = BARE_OFFSET_RE.exec(body)
  if (bare) {
    const parsed = offsetFrom(bare[1], bare[2], bare[3])
    if (parsed) return parsed
  }

  return null
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const p = (n) => String(n).padStart(2, '0')
  return `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

// ─── Time of day ─────────────────────────────────────────────────────────
// "2pm", "2:30 PM", "14:00", "10.30am". Returns { hour, minute } or null.
function parseTimeOfDay(text) {
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i.exec(text)
  if (m) {
    let hour = Number(m[1])
    const minute = m[2] ? Number(m[2]) : 0
    const isPm = /^p/i.test(m[3])
    if (hour < 1 || hour > 12 || minute > 59) return null
    if (isPm && hour !== 12) hour += 12
    if (!isPm && hour === 12) hour = 0
    return { hour, minute }
  }
  // 24-hour "14:00" / "at 09:30". Require the colon so a bare year or a
  // street number can't be read as a time.
  const m24 = /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text)
  if (m24) return { hour: Number(m24[1]), minute: Number(m24[2]) }
  return null
}

// ─── Calendar date ───────────────────────────────────────────────────────
// Returns a Date at midnight local, or null. `now` is injectable for tests.
function parseCalendarDate(text, now = new Date()) {
  // ISO first — unambiguous, and recruiter tooling often emits it.
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  if (iso) {
    const [, y, mo, d] = iso.map(Number)
    if (isValidDay(y, mo - 1, d)) return new Date(y, mo - 1, d)
  }

  // "15 March 2026", "15th March", "15 Mar 26"
  const dmy = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:\\s+(\\d{2,4}))?\\b`, 'i'
  ).exec(text)
  if (dmy) {
    const day = Number(dmy[1])
    const month = MONTHS[dmy[2].toLowerCase()]
    if (dmy[3] != null) {
      const year = normalizeYear(dmy[3], now.getFullYear())
      if (isValidDay(year, month, day)) return new Date(year, month, day)
    } else if (isValidDay(now.getFullYear(), month, day)) {
      return resolveBareMonthDay(month, day, now)
    }
  }

  // "March 15, 2026", "Mar 15"
  const mdy = new RegExp(
    `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{2,4}))?\\b`, 'i'
  ).exec(text)
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase()]
    const day = Number(mdy[2])
    if (mdy[3] != null) {
      const year = normalizeYear(mdy[3], now.getFullYear())
      if (isValidDay(year, month, day)) return new Date(year, month, day)
    } else if (isValidDay(now.getFullYear(), month, day)) {
      return resolveBareMonthDay(month, day, now)
    }
  }

  // Numeric "15/03/2026" — day-first. Hiro targets AU job boards (Seek,
  // au.indeed), where D/M/Y is the convention; reading it month-first would
  // put most deadlines in the wrong month.
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text)
  if (numeric) {
    const day = Number(numeric[1])
    const month = Number(numeric[2]) - 1
    const year = normalizeYear(numeric[3], now.getFullYear())
    if (month >= 0 && month <= 11 && isValidDay(year, month, day)) {
      return numeric[3] != null ? new Date(year, month, day) : resolveBareMonthDay(month, day, now)
    }
  }

  // Relative: "in 5 days", "within 2 weeks"
  const rel = /\b(?:in|within)\s+(\d{1,3})\s+(day|week|month)s?\b/i.exec(text)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2].toLowerCase()
    const d = startOfDay(now)
    if (unit === 'day') d.setDate(d.getDate() + n)
    else if (unit === 'week') d.setDate(d.getDate() + n * 7)
    else d.setMonth(d.getMonth() + n)
    return d
  }

  if (/\btomorrow\b/i.test(text)) {
    const d = startOfDay(now)
    d.setDate(d.getDate() + 1)
    return d
  }
  if (/\btoday\b/i.test(text)) return startOfDay(now)

  // Weekday names: "Monday", "next Wednesday". Always resolves forward — a
  // recruiter writing "Tuesday" never means a Tuesday that already passed.
  const wd = new RegExp(`\\b(next\\s+)?(${WEEKDAY_NAMES})\\b`, 'i').exec(text)
  if (wd) {
    const target = WEEKDAYS[wd[2].toLowerCase()]
    const d = startOfDay(now)
    let delta = (target - d.getDay() + 7) % 7
    if (delta === 0) delta = 7            // "Monday" said on a Monday means next week
    if (wd[1] && delta < 7) delta += 7     // explicit "next" pushes a further week out
    d.setDate(d.getDate() + delta)
    return d
  }

  return null
}

// ─── Public: job ad closing date ─────────────────────────────────────────
// Scans only the sentence around a closing-date cue, so an unrelated date
// elsewhere in a long ad ("founded in 2011", "sprint starts 3 March") can't be
// mistaken for the deadline. Returns "YYYY-MM-DD" or null.
const CLOSING_CUES = /(applications?\s+clos\w*|closing\s+date|clos\w+\s+on|apply\s+by|applications?\s+due|deadline|closes)/i

function parseClosingDate(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null

  // Split into clauses and keep only those mentioning a closing cue.
  const clauses = text.split(/(?<=[.!?\n])\s+|\s{2,}/)
  for (const clause of clauses) {
    if (!CLOSING_CUES.test(clause)) continue
    const d = parseCalendarDate(clause, now)
    if (!d) continue
    // A deadline in the past is a parse error, not a real closing date.
    if (d.getTime() < startOfDay(now).getTime()) continue
    // Guard against absurd horizons from a stray year elsewhere in the clause.
    if (d.getTime() - now.getTime() > 400 * 86400000) continue
    return toLocalSql(d, false)
  }
  return null
}

// ─── Public: interview date/time from a recruiter email ──────────────────
// Returns { at: "YYYY-MM-DD HH:MM:SS", hasTime: bool } or null. A date with no
// time is still worth surfacing — the panel shows it as all-day and the user
// can refine it.
const INTERVIEW_CUES = /(interview|meet|call|chat|screen|catch\s*up|discussion|availab|schedul|book)/i

function parseInterviewTime(subject, body, now = new Date()) {
  const text = `${subject || ''}\n${body || ''}`
  if (!text.trim()) return null

  const clauses = text.split(/(?<=[.!?\n])\s+|\s{2,}/)

  // Pass 1: a clause that mentions an interview cue AND parses to a date.
  // Pass 2: any clause with both a date and a time, for emails that put the
  // logistics in their own line ("Thursday 12 March, 2:00 PM AEDT").
  for (const pass of [1, 2]) {
    for (const clause of clauses) {
      if (pass === 1 && !INTERVIEW_CUES.test(clause)) continue
      const d = parseCalendarDate(clause, now)
      if (!d) continue
      const time = parseTimeOfDay(clause)
      if (pass === 2 && !time) continue
      // Interviews are scheduled forward, and rarely more than a quarter out.
      if (d.getTime() < startOfDay(now).getTime()) continue
      if (d.getTime() - now.getTime() > 120 * 86400000) continue
      if (time) d.setHours(time.hour, time.minute, 0, 0)

      // A zone only means anything alongside a time — "Thursday AEST" pins
      // nothing down — and only the zone written in the SAME clause as the time
      // can be trusted to be about it. An email signature saying "Sydney,
      // Australia" three paragraphs down is not a statement about this meeting.
      const zone = time ? parseTimezone(clause) : null
      // Always stored with a time component, even when none was detected — the
      // 00:00 is what `has_time: false` exists to qualify, and callers compare
      // these strings against SQLite datetimes.
      if (!zone) return { at: toLocalSql(d, true), hasTime: !!time }

      // The sender's wall clock is not ours. Convert to this machine's local
      // time — which is what every other stored time here means, and what the
      // dashboard, the reminders and the calendar all assume — and keep the
      // original alongside so the UI can show "2:00 PM AEDT (4:00 AM your time)"
      // rather than silently presenting a converted figure the user never saw.
      const utcMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes())
        - zone.offsetMinutes * 60000
      const local = new Date(utcMs)
      return {
        at: toLocalSql(local, true),
        hasTime: true,
        sourceZone: zone.label,
        sourceLocal: toLocalSql(d, true),
      }
    }
  }
  return null
}

module.exports = {
  parseClosingDate,
  parseInterviewTime,
  parseTimezone,
  // exported for tests
  parseCalendarDate,
  parseTimeOfDay,
  toLocalSql,
}
