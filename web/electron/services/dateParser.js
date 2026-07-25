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
      return { at: toLocalSql(d, true), hasTime: !!time }
    }
  }
  return null
}

module.exports = {
  parseClosingDate,
  parseInterviewTime,
  // exported for tests
  parseCalendarDate,
  parseTimeOfDay,
  toLocalSql,
}
