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

function localDateIn(days = 0) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

module.exports = { localDateIn, todayLocal, describeDue, isOverdue, isDueOrOverdue, daysBetweenDates }
