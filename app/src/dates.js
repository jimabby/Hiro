// Local-date helpers for follow-up dates.
//
// CommonJS on purpose, not a style slip. There is no mobile test framework here —
// the repo's convention is a zero-dependency Node harness (see app/test/run.js)
// and adding jest-expo to run four pure functions would cost more than it buys.
// Node cannot load ESM from a package without "type": "module", so the modules
// worth unit-testing are CommonJS and the screens import them normally; Metro
// compiles ESM imports to require() anyway, so the interop is free.
//
// Every function here works in LOCAL dates. A follow-up is a day, not an instant,
// and toISOString() is UTC — using it would put "tomorrow" on the wrong day for
// everyone east of Greenwich, which is the same bug the desktop's date handling
// is careful to avoid.

// A Date's LOCAL calendar day as YYYY-MM-DD — what a date picker's selection
// means, whatever time of day it happens to carry.
function localDateOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function localDateIn(days = 0) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDateOf(d)
}

function todayLocal() {
  return localDateIn(0)
}

// "in 3 days" is actionable in a way "2026-08-09" is not.
function describeDue(date, today = todayLocal()) {
  if (!date) return ''
  const iso = String(date).slice(0, 10)
  const days = Math.round(
    (new Date(`${iso}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000
  )
  if (Number.isNaN(days)) return iso
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days === -1) return 'overdue by a day'
  if (days < 0) return `overdue by ${-days} days`
  return `due in ${days} days`
}

// Compared as date STRINGS rather than as Dates: both sides are already local
// YYYY-MM-DD, and string comparison cannot be knocked off by a timezone.
function isOverdue(date, today = todayLocal()) {
  if (!date) return false
  return String(date).slice(0, 10) < today
}

function isDueOrOverdue(date, today = todayLocal()) {
  if (!date) return false
  return String(date).slice(0, 10) <= today
}

// Whole days from one local YYYY-MM-DD to another. Mirrors daysBetween() in
// web/electron/services/database.js, which is what fills daysToRespond on an
// offer over the LAN — the cloud path has to compute the same number from the
// same two dates or an offer would report a different urgency depending on how
// the phone happened to be connected.
//
// Returns null rather than NaN for an unparseable date: a null is skipped by
// every caller, a NaN colours a deadline chip red for no reason.
function daysBetweenDates(from, to) {
  if (!from || !to) return null
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00`).getTime()
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00`).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

// ── Instants from the desktop ────────────────────────────────────────────
//
// applied_at reaches the phone in two shapes depending on the transport. The
// cloud stores an ISO instant ("2026-08-06T02:15:00Z"); the LAN API hands over
// the desktop's SQLite value, which is datetime('now') — UTC, but written as
// "2026-08-06 02:15:00" with no zone marker. Parsed naively that string is read
// as LOCAL time, and the list used to print it raw with slice(0, 16), so an
// application sent at lunchtime in Sydney showed as "02:15".
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

function parseInstant(value) {
  if (!value) return null
  const s = String(value)
  const d = new Date(SQLITE_UTC.test(s) ? `${s.replace(' ', 'T')}Z` : s)
  return Number.isNaN(d.getTime()) ? null : d
}

// A wall-clock time with no zone (interview_events.scheduled_at is the
// desktop's local time by design). A bare date must get a time appended:
// new Date('2026-08-06') is UTC midnight, which is the previous day anywhere
// west of Greenwich.
function parseLocal(value) {
  if (!value) return null
  const s = String(value).trim().replace(' ', 'T')
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s)
  return Number.isNaN(d.getTime()) ? null : d
}

// Whole calendar days from `now` to `date`, both taken as local days. Rounding a
// millisecond difference instead mislabels anything within twelve hours of
// midnight — 7am tomorrow, seen at 8pm, is 0.46 days away and rounded to "today".
function calendarDaysFrom(date, now = new Date()) {
  if (!date) return null
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((b - a) / 86400000)
}

function relativeDay(date, now = new Date()) {
  const days = calendarDaysFrom(date, now)
  if (days == null) return ''
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days < 0) return `${-days} days ago`
  return `in ${days} days`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function clockTime(d) {
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

// "Today 2:15 pm", "Yesterday 9:02 am", "3 Aug", "3 Aug 2025". Built by hand
// rather than through toLocaleString: Hermes' Intl support varies by build, and
// a list is scanned by recency first — the full timestamp is on the detail page.
function formatWhen(value, now = new Date()) {
  const d = parseInstant(value)
  if (!d) return ''
  const days = calendarDaysFrom(d, now)
  if (days === 0) return `Today ${clockTime(d)}`
  if (days === -1) return `Yesterday ${clockTime(d)}`
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`
}

// The full local date and time, for the detail page.
function formatFull(value) {
  const d = parseInstant(value)
  if (!d) return ''
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clockTime(d)}`
}

// A local YYYY-MM-DD as "Tue 30 Sep" — used for deadlines, where the weekday is
// what a person plans around.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function formatDay(value) {
  const d = parseLocal(value)
  if (!d) return String(value || '')
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

module.exports = {
  localDateIn, localDateOf, todayLocal, describeDue, isOverdue, isDueOrOverdue, daysBetweenDates,
  parseInstant, parseLocal, calendarDaysFrom, relativeDay, formatWhen, formatFull, formatDay, clockTime,
}
