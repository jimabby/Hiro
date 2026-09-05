// Follow-up dates are LOCAL dates, and the whole file exists because that is easy
// to get wrong: toISOString() is UTC, so "tomorrow" computed through it lands on
// the wrong day for everyone east of Greenwich, and a due-date comparison done
// through Date objects can be knocked off by an hour of DST.

const { createChecker } = require('./helpers')
const { localDateIn, todayLocal, describeDue, isOverdue, isDueOrOverdue, daysBetweenDates } = require('../src/dates')

const { check, done } = createChecker()

const today = todayLocal()

check('today is a plain local date', /^\d{4}-\d{2}-\d{2}$/.test(today), true)
check('offset zero is today', localDateIn(0), today)

// The property that matters, checked against the platform's own arithmetic rather
// than against a hardcoded date, so this suite does not expire.
const expected = (days) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
check('tomorrow is one local day ahead', localDateIn(1), expected(1))
check('a week ahead crosses month ends correctly', localDateIn(7), expected(7))
check('negative offsets go backwards', localDateIn(-3), expected(-3))

// The bug this guards: a UTC-derived "today" is the previous day for most of the
// day in UTC+ timezones.
check('today is never the UTC date by accident',
  localDateIn(0) === expected(0), true)

// ── Describing a due date ────────────────────────────────────────
check('no date describes as empty', describeDue(null), '')
check('today', describeDue('2026-08-06', '2026-08-06'), 'due today')
check('tomorrow', describeDue('2026-08-07', '2026-08-06'), 'due tomorrow')
check('a few days out', describeDue('2026-08-09', '2026-08-06'), 'due in 3 days')
check('yesterday reads as overdue', describeDue('2026-08-05', '2026-08-06'), 'overdue by a day')
check('several days overdue', describeDue('2026-08-01', '2026-08-06'), 'overdue by 5 days')
// A timestamp rather than a date (the cloud stores next_action_at as timestamptz)
// must describe the same way as the bare date.
check('a timestamp is truncated to its date',
  describeDue('2026-08-09T00:00:00.000Z', '2026-08-06'), 'due in 3 days')
// Better to show the raw value than "due in NaN days".
check('an unparseable value falls back to showing itself',
  describeDue('not-a-date', '2026-08-06'), 'not-a-date')

// Month and year boundaries, where naive day arithmetic breaks.
check('crossing a month boundary', describeDue('2026-09-01', '2026-08-31'), 'due tomorrow')
check('crossing a year boundary', describeDue('2027-01-01', '2026-12-31'), 'due tomorrow')
// 2028 is a leap year: 29 Feb exists and must not shift the count.
check('crossing a leap day', describeDue('2028-03-01', '2028-02-29'), 'due tomorrow')

// ── Overdue ──────────────────────────────────────────────────────
check('nothing booked is not overdue', isOverdue(null), false)
check('due today is not yet overdue', isOverdue('2026-08-06', '2026-08-06'), false)
check('yesterday is overdue', isOverdue('2026-08-05', '2026-08-06'), true)
check('tomorrow is not overdue', isOverdue('2026-08-07', '2026-08-06'), false)
check('a timestamp is compared by its date', isOverdue('2026-08-05T23:00:00Z', '2026-08-06'), true)

check('due-or-overdue includes today', isDueOrOverdue('2026-08-06', '2026-08-06'), true)
check('due-or-overdue includes the past', isDueOrOverdue('2026-07-01', '2026-08-06'), true)
check('due-or-overdue excludes the future', isDueOrOverdue('2026-08-07', '2026-08-06'), false)
check('due-or-overdue on nothing booked is false', isDueOrOverdue(null), false)



// ── daysBetweenDates ────────────────────────────────────────────────────
// This is what fills an offer's daysToRespond on the cloud path, and it has to
// produce the same number as the desktop's daysBetween() does on the LAN path —
// otherwise the same offer reports a different urgency, and a different colour,
// depending only on how the phone happened to be connected.

check('same day is zero', daysBetweenDates('2026-09-05', '2026-09-05'), 0)
check('forward is positive', daysBetweenDates('2026-09-05', '2026-09-08'), 3)
check('backward is negative', daysBetweenDates('2026-09-08', '2026-09-05'), -3)
check('across a month boundary', daysBetweenDates('2026-08-30', '2026-09-02'), 3)
check('across a year boundary', daysBetweenDates('2026-12-30', '2027-01-02'), 3)
// 2028 is a leap year, so February has 29 days.
check('across a leap day', daysBetweenDates('2028-02-28', '2028-03-01'), 2)
// A timestamp is truncated to its date rather than rejected — the desktop
// stores respond_by as a plain date but nothing stops a longer string arriving.
check('a timestamp is truncated to its date', daysBetweenDates('2026-09-05T23:00:00', '2026-09-06'), 1)
// Null rather than NaN: a null is skipped by every caller, a NaN would colour a
// deadline chip red for no reason.
check('a missing side is null, not NaN', daysBetweenDates(null, '2026-09-05'), null)
check('an empty string is null', daysBetweenDates('', '2026-09-05'), null)
check('an unparseable date is null', daysBetweenDates('not-a-date', '2026-09-05'), null)

// The property that matters is DST-independence: a span measured across a
// clock change must still be a whole number of days. Checked against the
// platform rather than a hardcoded answer so this cannot expire.
for (const [from, to] of [['2026-03-27', '2026-04-03'], ['2026-10-23', '2026-10-30']]) {
  check(`${from} to ${to} is exactly 7 days across a clock change`, daysBetweenDates(from, to), 7)
}

done()
