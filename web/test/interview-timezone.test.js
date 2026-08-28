// A recruiter's timezone is part of what they said, and it used to be thrown
// away.
//
// "Thursday 12 March, 2:00 PM AEDT" was parsed for the date and the time, the
// zone was read past, and the result was stored as a bare wall clock. calendar
// sync then stamped that with Intl.DateTimeFormat().resolvedOptions().timeZone —
// the DESKTOP's zone. For anyone interviewing outside their own timezone (a
// remote role, an overseas employer, a recruiter interstate) that is not a
// rounding error: a Sydney 2pm read on a London machine became a 2pm London
// event and the interview was missed by nine hours.
//
// The stored value stays this machine's local time, because everything that
// reads it — the dashboard, the reminders, calendar sync, the .ics export —
// depends on that. What changes is that it is now a CONVERSION of what the
// employer said, with the original kept alongside so the user can check it.

const { createChecker } = require('./helpers')
const { parseInterviewTime, parseTimezone } = require('../electron/services/dateParser')

const { check, done } = createChecker()

// ─── Zone recognition ────────────────────────────────────────────
check('an Australian abbreviation resolves', parseTimezone('2pm AEST').offsetMinutes, 600)
check('daylight saving is its own zone', parseTimezone('2pm AEDT').offsetMinutes, 660)
check('a US abbreviation resolves', parseTimezone('9am PST').offsetMinutes, -480)
check('GMT is zero', parseTimezone('10:00 GMT').offsetMinutes, 0)

// "UTC" and "GMT" are themselves names on the list, so the offset form has to be
// tested first — matching the name would read "UTC+05:30" as plain UTC and throw
// away the whole of the information in it.
check('an explicit offset beats the bare name', parseTimezone('14:00 UTC+10').offsetMinutes, 600)
check('a half-hour offset survives', parseTimezone('09:00 UTC+05:30').offsetMinutes, 330)
check('a negative offset survives', parseTimezone('09:00 GMT-5').offsetMinutes, -300)
check('a bare offset after a time is read', parseTimezone('2:00 PM (+1000)').offsetMinutes, 600)

check('no zone means no zone', parseTimezone('let us meet on Thursday'), null)
// A loose signed number in a body is far more likely to be a phone number or a
// salary range than an offset.
check('a bare number is not an offset', parseTimezone('salary 90000-120000'), null)

// ─── End-to-end conversion ───────────────────────────────────────
// Asserted as an absolute instant, which is the only way to state this
// independently of whatever zone the test machine happens to be in.
const NOW = new Date(2026, 2, 1, 9, 0)

function instantOf(result) {
  return new Date(result.at.replace(' ', 'T')).toISOString()
}

const pst = parseInterviewTime('Interview confirmed 12 March 2026, 9:00 AM PST', '', NOW)
check('a foreign zone is converted to the right instant', instantOf(pst), '2026-03-12T17:00:00.000Z')
check('the sender\'s zone is preserved', pst.sourceZone, 'PST')
check('the sender\'s own wall clock is preserved', pst.sourceLocal, '2026-03-12 09:00:00')

const gmt = parseInterviewTime('Interview 12 March 2026 at 10:00 GMT', '', NOW)
check('GMT converts correctly', instantOf(gmt), '2026-03-12T10:00:00.000Z')

const offset = parseInterviewTime('Call booked for 12 March 2026 at 14:00 UTC+10', '', NOW)
check('an explicit offset converts correctly', instantOf(offset), '2026-03-12T04:00:00.000Z')

// No zone named: unchanged behaviour, and no conversion claimed.
const bare = parseInterviewTime('Interview on 12 March 2026 at 2:00 PM', '', NOW)
check('a zoneless time is left alone', bare.at, '2026-03-12 14:00:00')
check('nothing is claimed about a zone that was not given', bare.sourceZone, undefined)

// A zone means nothing without a time — "Thursday AEST" pins nothing down.
const dateOnly = parseInterviewTime('Interview on 25 March 2026 AEST', '', NOW)
check('a date with no time is still returned', dateOnly.at, '2026-03-25 00:00:00')
check('a date with no time is flagged as such', dateOnly.hasTime, false)
check('no conversion is applied without a time', dateOnly.sourceZone, undefined)

// Only the zone in the SAME clause as the time is about that time. An email
// signature three paragraphs down is not a statement about the meeting.
const signature = parseInterviewTime(
  'Interview 12 March 2026 at 2:00 PM.',
  'Regards, Sam. Our office is in Los Angeles, PST.',
  NOW
)
check('a zone in an unrelated clause is ignored', signature.sourceZone, undefined)
check('and the time is left as written', signature.at, '2026-03-12 14:00:00')

done()
