// Pure halves of the App Lock, job-link import and calendar features.
const { createChecker } = require('./helpers')
const { shouldLock, parseLockSettings, DEFAULT_TIMEOUT_MINUTES } = require('../src/appLock')
const { extractJobUrl, parseImportLink } = require('../src/importLink')
const { interviewEvent, pickWritableCalendar } = require('../src/calendarEvent')
const { check, done } = createChecker()

// ── App Lock ──
const MIN = 60 * 1000, T = 1_000_000_000
check('off never locks', shouldLock({ enabled: false, backgroundedAt: T, now: T + 99 * MIN }), false)
check('never backgrounded does not lock', shouldLock({ enabled: true, backgroundedAt: null, now: T }), false)
check('back within the timeout stays unlocked', shouldLock({ enabled: true, timeoutMinutes: 5, backgroundedAt: T, now: T + 4 * MIN }), false)
check('back after the timeout locks', shouldLock({ enabled: true, timeoutMinutes: 5, backgroundedAt: T, now: T + 5 * MIN }), true)
check('"immediately" locks on any return', shouldLock({ enabled: true, timeoutMinutes: 0, backgroundedAt: T, now: T + 1 }), true)
check('a clock moved backwards locks', shouldLock({ enabled: true, timeoutMinutes: 15, backgroundedAt: T, now: T - MIN }), true)
check('settings default to off', parseLockSettings(null), { enabled: false, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES })
check('settings parse', parseLockSettings('{"enabled":true,"timeoutMinutes":1}'), { enabled: true, timeoutMinutes: 1 })
check('an unknown timeout falls back to the default', parseLockSettings('{"enabled":true,"timeoutMinutes":7}').timeoutMinutes, DEFAULT_TIMEOUT_MINUTES)

// ── Job links ──
check('bare URL', extractJobUrl('https://jobs.example/42'), 'https://jobs.example/42')
check('URL inside shared text', extractJobUrl('Senior Engineer at Acme — https://jobs.example/42?ref=share.'), 'https://jobs.example/42?ref=share')
check('no URL', extractJobUrl('just some words'), null)
check('non-web scheme is not a job link', extractJobUrl('javascript:alert(1)'), null)
check('deep link', parseImportLink('hiro://import?url=https%3A%2F%2Fjobs.example%2F42&title=Engineer'), { url: 'https://jobs.example/42', title: 'Engineer' })
check('deep link without a title', parseImportLink('hiro://import?url=https%3A%2F%2Fjobs.example%2F1'), { url: 'https://jobs.example/1' })
check('other hiro links are not imports', parseImportLink('hiro://settings'), null)
check('other schemes are ignored', parseImportLink('https://import?url=https://x.example'), null)
check('an import link with a bad URL is ignored', parseImportLink('hiro://import?url=ftp%3A%2F%2Fx'), null)

// ── Calendar ──
const timed = interviewEvent({ job_title: 'Engineer', company: 'Acme', scheduled_at: '2026-10-20 14:30', has_time: 1 }, { timeZone: 'Australia/Sydney' })
check('timed interview starts at the local wall-clock time',
  [timed.startDate.getFullYear(), timed.startDate.getMonth(), timed.startDate.getDate(), timed.startDate.getHours(), timed.startDate.getMinutes()],
  [2026, 9, 20, 14, 30])
check('and lasts an hour', timed.endDate - timed.startDate, 60 * MIN)
check('carries the device time zone', timed.timeZone, 'Australia/Sydney')
check('is not all-day', timed.allDay, false)
check('title names the role and company', timed.title, 'Interview: Engineer at Acme')

const dateOnly = interviewEvent({ job_title: 'E', scheduled_at: '2026-10-21', has_time: 0 })
check('date-only interview is an all-day event', dateOnly.allDay, true)
check('on its own day', [dateOnly.startDate.getDate(), dateOnly.startDate.getHours()], [21, 0])
check('ending at the next midnight', dateOnly.endDate.getDate(), 22)
check('and says the time is unknown', /not the time/.test(dateOnly.notes), true)

const zoned = interviewEvent({ job_title: 'E', scheduled_at: '2026-10-20 09:00', has_time: true, source_local: '3pm', source_zone: 'PST' })
check('notes keep what the recruiter wrote', /They wrote: 3pm PST/.test(zoned.notes), true)
check('no date, no event', interviewEvent({ scheduled_at: '' }), null)

check('picks the primary writable calendar', pickWritableCalendar([
  { id: 'r', allowsModifications: false, isPrimary: true },
  { id: 'w', allowsModifications: true, accessLevel: 'owner' },
  { id: 'p', allowsModifications: true, accessLevel: 'owner', isPrimary: true },
]).id, 'p')
check('read-only calendars are never chosen', pickWritableCalendar([{ id: 'r', allowsModifications: false }]), null)

done()
