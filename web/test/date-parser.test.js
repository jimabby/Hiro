// Closing-date and interview-time extraction. Pure functions over free text,
// so they're the cheapest thing in the app to get wrong silently: a bad parse
// writes a confident wrong deadline onto a job, or schedules an interview that
// isn't real. The risky cases are all "text that contains a date but isn't the
// date we want".

const { service, createChecker } = require('./helpers')
const { parseClosingDate, parseInterviewTime, parseTimeOfDay } = service('dateParser')

const { check, done } = createChecker()

// Fixed "now" so relative parsing ("in 5 days", weekday names, bare months)
// is deterministic. 10 March 2026 is a Tuesday.
const NOW = new Date(2026, 2, 10, 9, 0, 0)

// ── Closing dates ─────────────────────────────────────────────────
check('closing: explicit date after cue',
  parseClosingDate('Applications close 20 March 2026.', NOW), '2026-03-20')

check('closing: "apply by" cue',
  parseClosingDate('Great team. Apply by 15 April 2026 to be considered.', NOW), '2026-04-15')

check('closing: numeric day-first',
  parseClosingDate('Applications due 15/04/2026.', NOW), '2026-04-15')

check('closing: ISO date',
  parseClosingDate('Closing date: 2026-05-01.', NOW), '2026-05-01')

check('closing: relative window',
  parseClosingDate('Applications close in 5 days.', NOW), '2026-03-15')

check('closing: bare month/day rolls to next year when already past',
  parseClosingDate('Applications close 5 January.', NOW), '2027-01-05')

// The failure mode that matters most: long ads are full of numbers and dates
// that have nothing to do with the deadline.
check('closing: ignores dates with no cue',
  parseClosingDate('Founded in 2011, we shipped v2 on 3 March 2026. We are hiring!', NOW), null)

check('closing: ignores a start date',
  parseClosingDate('The role starts 1 June 2026. Competitive salary.', NOW), null)

check('closing: rejects a past deadline',
  parseClosingDate('Applications close 1 March 2026.', NOW), null)

check('closing: rejects an absurd horizon',
  parseClosingDate('Applications close 20 March 2099.', NOW), null)

check('closing: empty input', parseClosingDate('', NOW), null)
check('closing: non-string input', parseClosingDate(null, NOW), null)

// ── Times of day ──────────────────────────────────────────────────
check('time: 2pm', parseTimeOfDay('at 2pm'), { hour: 14, minute: 0 })
check('time: 2:30 PM', parseTimeOfDay('at 2:30 PM'), { hour: 14, minute: 30 })
check('time: 12am is midnight', parseTimeOfDay('at 12am'), { hour: 0, minute: 0 })
check('time: 12pm is noon', parseTimeOfDay('at 12pm'), { hour: 12, minute: 0 })
check('time: 24-hour', parseTimeOfDay('at 14:30'), { hour: 14, minute: 30 })
check('time: bare year is not a time', parseTimeOfDay('in 2026'), null)

// ── Interview times ───────────────────────────────────────────────
check('interview: date and time in one clause',
  parseInterviewTime('Interview invitation', 'We would like to interview you on 12 March 2026 at 2:00 PM.', NOW),
  { at: '2026-03-12 14:00:00', hasTime: true })

check('interview: 24-hour time',
  parseInterviewTime('Phone screen', 'Can we schedule a call on 18 March 2026 at 14:30?', NOW),
  { at: '2026-03-18 14:30:00', hasTime: true })

check('interview: date only still surfaces',
  parseInterviewTime('Interview', 'Your interview is scheduled for 25 March 2026.', NOW),
  { at: '2026-03-25 00:00:00', hasTime: false })

check('interview: weekday resolves forward',
  parseInterviewTime('Chat', 'Are you free to chat Thursday at 11am?', NOW),
  { at: '2026-03-12 11:00:00', hasTime: true })

// Said on a Tuesday, "Tuesday" means next week's — not today.
check('interview: same weekday means next week',
  parseInterviewTime('Call', 'Lets do the call Tuesday at 3pm.', NOW),
  { at: '2026-03-17 15:00:00', hasTime: true })

check('interview: subject-only cue with date in body',
  parseInterviewTime('Interview confirmation', 'See you 20 March 2026, 10:00.', NOW),
  { at: '2026-03-20 10:00:00', hasTime: true })

check('interview: rejection has no interview time',
  parseInterviewTime('Application update', 'Unfortunately we will not be moving forward. Posted 1 March 2026.', NOW),
  null)

check('interview: generic ack yields nothing',
  parseInterviewTime('Thanks for applying', 'We received your application and will be in touch.', NOW),
  null)

check('interview: past date rejected',
  parseInterviewTime('Interview', 'We met on 1 March 2026.', NOW), null)

check('interview: beyond a quarter out rejected',
  parseInterviewTime('Interview', 'Interview on 1 December 2026.', NOW), null)

check('interview: empty input', parseInterviewTime('', '', NOW), null)

done()
