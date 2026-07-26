// .ics output goes into the user's real calendar, where a malformed field
// doesn't degrade — the whole import fails silently. These cover the parts that
// break imports in practice: escaping, line folding, all-day vs timed events,
// and the local-time-not-shifted invariant.

const { createChecker, service } = require('./helpers')
const { buildCalendar, escapeText, foldLine, parseLocalSql } = service('calendar')

const { check, done } = createChecker()

const baseEvent = {
  id: 7,
  application_id: 3,
  scheduled_at: '2026-08-14 14:30:00',
  has_time: 1,
  source: 'inbox',
  note: 'Interview invitation — Senior Engineer',
  job_title: 'Senior Engineer',
  company: 'Acme Pty Ltd',
  platform: 'Seek',
  job_url: 'https://www.seek.com.au/job/123',
}

const lines = (ics) => ics.split('\r\n')
const find = (ics, prefix) => lines(ics).find(l => l.startsWith(prefix))

// ─── Envelope ────────────────────────────────────────────────────
{
  const { ics, count } = buildCalendar([baseEvent])
  check('one event counted', count, 1)
  check('opens with VCALENDAR', lines(ics)[0], 'BEGIN:VCALENDAR')
  check('closes with VCALENDAR', lines(ics).filter(Boolean).pop(), 'END:VCALENDAR')
  check('declares version 2.0', !!find(ics, 'VERSION:2.0'), true)
  // CRLF, not LF — some clients reject LF-only files outright.
  check('uses CRLF line endings', ics.includes('\r\n'), true)
  check('no bare LF line endings', /[^\r]\n/.test(ics), false)
}

// ─── Timed event keeps its local wall-clock time ─────────────────
// The bug this guards against: routing the stored local time through Date and
// out via toISOString shifts a 2:30pm interview by the machine's UTC offset.
{
  const { ics } = buildCalendar([baseEvent])
  check('DTSTART is the stated local time', find(ics, 'DTSTART'), 'DTSTART:20260814T143000')
  check('DTEND defaults to one hour later', find(ics, 'DTEND'), 'DTEND:20260814T153000')
  check('no trailing Z (floating local time)', find(ics, 'DTSTART').endsWith('Z'), false)
}

// ─── All-day event when no time was detected ─────────────────────
{
  const { ics } = buildCalendar([{ ...baseEvent, has_time: 0, scheduled_at: '2026-08-14 00:00:00' }])
  check('all-day uses a DATE value', find(ics, 'DTSTART'), 'DTSTART;VALUE=DATE:20260814')
  // DTEND is exclusive for all-day events, so a one-day event ends the next day.
  check('all-day DTEND is the following day', find(ics, 'DTEND'), 'DTEND;VALUE=DATE:20260815')
}

// ─── Status reflects how the time was obtained ───────────────────
{
  const auto = buildCalendar([baseEvent]).ics
  const manual = buildCalendar([{ ...baseEvent, source: 'manual' }]).ics
  check('auto-detected time is tentative', find(auto, 'STATUS:'), 'STATUS:TENTATIVE')
  check('hand-entered time is confirmed', find(manual, 'STATUS:'), 'STATUS:CONFIRMED')
}

// ─── Stable UID so re-import updates rather than duplicates ──────
{
  const a = buildCalendar([baseEvent]).ics
  const b = buildCalendar([baseEvent]).ics
  check('UID is stable across exports', find(a, 'UID:'), find(b, 'UID:'))
  check('UID is derived from the row id', find(a, 'UID:'), 'UID:hiro-interview-7@hiro.local')
}

// ─── Escaping ────────────────────────────────────────────────────
check('escapes commas', escapeText('Acme, Inc'), 'Acme\\, Inc')
check('escapes semicolons', escapeText('a;b'), 'a\\;b')
check('escapes backslashes first', escapeText('a\\b'), 'a\\\\b')
check('escapes newlines', escapeText('a\nb'), 'a\\nb')
{
  // A comma in a company name is common and unescaped commas split the field.
  const { ics } = buildCalendar([{ ...baseEvent, company: 'Acme, Inc' }])
  check('company comma survives escaping', ics.includes('Acme\\, Inc'), true)
}

// ─── Line folding ────────────────────────────────────────────────
{
  const short = 'SUMMARY:short'
  check('short lines are untouched', foldLine(short), short)
  const long = 'SUMMARY:' + 'x'.repeat(200)
  const folded = foldLine(long)
  check('long lines are folded', folded.includes('\r\n '), true)
  check('first fold segment is 75 chars', folded.split('\r\n')[0].length, 75)
  // Unfolding must reproduce the original exactly.
  check('folding is reversible', folded.split('\r\n').map((l, i) => i === 0 ? l : l.slice(1)).join(''), long)
}

// ─── Robustness ──────────────────────────────────────────────────
{
  // A row with an unparseable date is skipped rather than emitted as a broken
  // event that takes the whole import down with it.
  const { ics, count } = buildCalendar([{ ...baseEvent, scheduled_at: 'not a date' }, { ...baseEvent, id: 8 }])
  check('unparseable rows are skipped', count, 1)
  check('valid row still exported', ics.includes('UID:hiro-interview-8@hiro.local'), true)
}
check('empty input yields an empty calendar', buildCalendar([]).count, 0)
check('null input is tolerated', buildCalendar(null).count, 0)

// ─── Date parsing ────────────────────────────────────────────────
check('parses date and time', parseLocalSql('2026-08-14 14:30:00'), { year: 2026, month: 8, day: 14, hour: 14, minute: 30 })
check('parses date only', parseLocalSql('2026-08-14'), { year: 2026, month: 8, day: 14, hour: 0, minute: 0 })
check('parses ISO-style separator', parseLocalSql('2026-08-14T09:05'), { year: 2026, month: 8, day: 14, hour: 9, minute: 5 })
check('rejects garbage', parseLocalSql('later today'), null)
check('rejects empty', parseLocalSql(''), null)

done()
