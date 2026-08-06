// Two-way calendar sync.
//
// The bugs a two-way sync produces are the quiet destructive kind, so these
// assertions are about the rules that stop them:
//
//   • An unchanged event must not be rewritten on every pass. A sync that runs
//     every fifteen minutes and PATCHes everything would burn the API quota and,
//     worse, keep overwriting the user's own edits.
//   • An edit made in the calendar must win for that event — and must NOT then be
//     pushed back over by the local copy on the same pass.
//   • An event the USER created must never be touched, in either direction.
//   • A local delete removes the event; a remote delete removes the interview.
//   • Times must survive the round trip without moving by the UTC offset.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-cal-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = {
  calendarProvider: 'google',
  calendarSyncEnabled: true,
  calendarRefreshToken: 'refresh-token',
  calendarClientId: 'client-id',
  calendarClientSecret: 'secret',
  calendarId: 'primary',
  calendarSyncCursor: '',
  calendarReminderMinutes: 45,
}

// A tiny stand-in for Google Calendar: the event store plus a record of every
// request, so "did this pass rewrite anything?" is directly observable.
const remote = new Map()
let requests = []
let nextId = 1
let changeFeed = [] // what the next changes() call reports

global.fetch = async (url, options = {}) => {
  const method = options.method || 'GET'
  requests.push({ method, url })
  const body = options.body ? JSON.parse(options.body) : null
  const idMatch = /\/events\/([^?]+)/.exec(url)

  if (method === 'POST' && /\/events$/.test(url)) {
    const id = `remote-${nextId++}`
    const event = { ...body, id, updated: new Date().toISOString() }
    remote.set(id, event)
    return ok(event)
  }
  if (method === 'PATCH' && idMatch) {
    const id = decodeURIComponent(idMatch[1])
    if (!remote.has(id)) return notFound()
    const event = { ...remote.get(id), ...body, id, updated: new Date().toISOString() }
    remote.set(id, event)
    return ok(event)
  }
  if (method === 'DELETE' && idMatch) {
    remote.delete(decodeURIComponent(idMatch[1]))
    return { ok: true, status: 204, text: async () => '' }
  }
  if (method === 'GET' && /\/events\?/.test(url)) {
    const items = changeFeed
    changeFeed = []
    return ok({ items, nextSyncToken: 'cursor-1' })
  }
  if (method === 'GET' && /calendarList/.test(url)) {
    return ok({ items: [{ id: 'primary', summary: 'Jane', primary: true }] })
  }
  return ok({})
}

const ok = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
const notFound = () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'Not Found' } }) })

stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => config,
    update: (patch) => { config = { ...config, ...patch }; return config },
  },
  './logger': { append: () => {} },
  // The token exchange is not what is under test; short-circuit it.
  './calendarAuth': {
    getAccessToken: async () => 'access-token',
    isConnected: () => true,
    describeProviders: () => [{ id: 'google', label: 'Google Calendar' }],
    disconnect: () => ({ success: true }),
    PROVIDERS: { google: { label: 'Google Calendar' } },
  },
})

const db = service('database')
const calendarSync = service('calendarSync')
const { check, done } = createChecker()

let seq = 0
function addApplication(company) {
  seq++
  db.insertApplication({
    job_title: `Role ${seq}`,
    company,
    platform: 'Seek',
    salary: '',
    job_url: `https://example.com/job/${seq}`,
    job_description: '',
    match_score: 90,
    match_explanation: '',
    tailored_resume: '',
    screening_qa: [],
    status: 'interview',
    closing_date: null,
  })
  return seq
}

const p = (n) => String(n).padStart(2, '0')
function localSql(daysAhead, hour = 14, minute = 30) {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(hour)}:${p(minute)}:00`
}

const writes = () => requests.filter(r => r.method !== 'GET').length

async function main() {
  await db.init()

  // ── First pass creates events ────────────────────────────────
  const appId = addApplication('Acme')
  db.addInterviewEvent({ applicationId: appId, scheduledAt: localSql(3), hasTime: true, source: 'inbox' })
  const interviewId = db.getInterviewEvents(appId)[0].id

  requests = []
  let result = await calendarSync.syncNow()
  check('the first pass creates one event', result.created, 1)
  check('and the calendar has it', remote.size, 1)

  const created = [...remote.values()][0]
  check('the summary names the role and company', created.summary, 'Interview: Role 1 at Acme')
  // A floating local time plus an explicit zone is what keeps a 2:30pm interview
  // at 2:30pm rather than shifting it by the machine's UTC offset.
  check('the start is a local wall-clock time', /T14:30:00$/.test(created.start.dateTime), true)
  check('and carries an explicit time zone', typeof created.start.timeZone, 'string')
  check('the reminder honours the setting', created.reminders.overrides[0].minutes, 45)
  // Survives a reinstall: the mapping can be rebuilt from the events themselves.
  check('the event is tagged with the interview id',
    created.extendedProperties.private.hiroInterviewId, String(interviewId))
  // An auto-detected time is a best-effort parse of an email, so it does not
  // block out the calendar as if it were confirmed.
  check('an inbox-detected time shows as tentative', created.transparency, 'transparent')

  // ── An unchanged interview is not rewritten ──────────────────
  requests = []
  result = await calendarSync.syncNow()
  check('a second pass creates nothing', result.created, 0)
  check('and updates nothing', result.updated, 0)
  check('no write requests at all', writes(), 0)

  // ── A local change is pushed ─────────────────────────────────
  db.updateInterviewEventTime(interviewId, { scheduledAt: localSql(3, 16, 0), hasTime: true })
  requests = []
  result = await calendarSync.syncNow()
  check('a local reschedule updates the event', result.updated, 1)
  check('the calendar shows the new time',
    /T16:00:00$/.test([...remote.values()][0].start.dateTime), true)

  // ── A remote change wins for that event ──────────────────────
  const remoteId = created.id
  const movedTo = localSql(4, 9, 15)
  changeFeed = [{
    id: remoteId,
    status: 'confirmed',
    updated: new Date(Date.now() + 60000).toISOString(),
    extendedProperties: { private: { hiroInterviewId: String(interviewId) } },
    // Google returns a full offset; the conversion has to go through the local
    // zone rather than slicing the string.
    start: { dateTime: new Date(movedTo.replace(' ', 'T')).toISOString() },
  }]
  requests = []
  result = await calendarSync.syncNow()
  check('an edit in the calendar moves the interview', result.moved, 1)
  check('the local time matches what the calendar said',
    db.getInterviewEvent(interviewId).scheduled_at, movedTo)
  // The provenance changes with it: this is no longer the time Hiro parsed out of
  // an email, and labelling it 'inbox' forever would be a lie.
  check('the source is recorded as the calendar',
    db.getInterviewEvent(interviewId).source, 'calendar')
  // And the crucial part: the outgoing half of the SAME pass must not push the
  // old time straight back over the user's change.
  check('the local copy was not pushed back over it', result.updated, 0)

  requests = []
  await calendarSync.syncNow()
  check('the pass after a remote edit writes nothing', writes(), 0)

  // ── A user's own event is left alone ─────────────────────────
  changeFeed = [{
    id: 'users-own-event',
    status: 'confirmed',
    updated: new Date().toISOString(),
    summary: 'Dentist',
    start: { dateTime: new Date().toISOString() },
  }]
  const interviewsBefore = db.getAllInterviewEventsForSync().length
  await calendarSync.syncNow()
  check('an event Hiro did not create is not adopted',
    db.getAllInterviewEventsForSync().length, interviewsBefore)

  // ── A remote delete removes the interview ────────────────────
  // The user deleted it in their calendar, so it is gone from the store as well
  // as reported cancelled in the change feed.
  remote.delete(remoteId)
  changeFeed = [{ id: remoteId, status: 'cancelled', updated: new Date().toISOString() }]
  result = await calendarSync.syncNow()
  check('deleting the event deletes the interview', result.removed, 1)
  check('the interview is gone locally', db.getInterviewEvent(interviewId), null)
  check('and the link is gone with it', db.getCalendarLinks('google').length, 0)

  // ── A local delete removes the event ─────────────────────────
  const appId2 = addApplication('Globex')
  db.addInterviewEvent({ applicationId: appId2, scheduledAt: localSql(5), hasTime: true, source: 'manual' })
  const id2 = db.getInterviewEvents(appId2)[0].id
  await calendarSync.syncNow()
  check('the second interview reached the calendar', remote.size, 1)
  const created2 = [...remote.values()][0]
  // A hand-entered time is a fact, not a guess.
  check('a manually entered time is not tentative', created2.transparency, 'opaque')

  db.deleteInterviewEvent(id2)
  result = await calendarSync.syncNow()
  check('deleting the interview deletes the event', result.deleted, 1)
  check('the calendar is empty again', remote.size, 0)

  // ── The event was deleted in the calendar, then edited here ──
  // A PATCH would 404. Recreating is the only sensible answer; failing the whole
  // sync would strand every later interview behind one stale link.
  const appId3 = addApplication('Initech')
  db.addInterviewEvent({ applicationId: appId3, scheduledAt: localSql(6), hasTime: true })
  const id3 = db.getInterviewEvents(appId3)[0].id
  await calendarSync.syncNow()
  check('a third event exists', remote.size, 1)
  remote.clear() // the user deleted it in their calendar, outside a sync
  db.updateInterviewEventTime(id3, { scheduledAt: localSql(6, 11, 0), hasTime: true })
  result = await calendarSync.syncNow()
  check('a vanished event is recreated rather than failing', result.created, 1)
  check('the calendar has it again', remote.size, 1)

  // ── All-day interviews ───────────────────────────────────────
  // A recruiter who names a day but no time gets an all-day event, whose end is
  // the FOLLOWING day because the end is exclusive in both APIs.
  const appId4 = addApplication('Dateless Ltd')
  db.addInterviewEvent({ applicationId: appId4, scheduledAt: '2026-09-10 00:00:00', hasTime: false })
  await calendarSync.syncNow()
  const allDay = [...remote.values()].find(e => e.start.date)
  check('an interview with no time is an all-day event', allDay.start.date, '2026-09-10')
  check('and its end is the following day', allDay.end.date, '2026-09-11')

  // ── Status and disconnect ────────────────────────────────────
  const status = calendarSync.getStatus()
  check('status reports the provider', status.provider, 'google')
  check('status reports how many interviews are mirrored', status.linkedCount, 2)
  check('status reports the reminder setting', status.reminderMinutes, 45)

  const remoteCountBefore = remote.size
  calendarSync.disconnect()
  // Silently deleting a month of the user's calendar entries because a token was
  // revoked would be indefensible; the links go, the events stay.
  check('disconnecting leaves the events in the calendar', remote.size, remoteCountBefore)
  check('but drops the local links', db.getCalendarLinks('google').length, 0)

  // ── Disabled means no requests ───────────────────────────────
  config = { ...config, calendarSyncEnabled: false }
  requests = []
  result = await calendarSync.syncNow()
  check('a disabled sync does nothing', result.skipped, 'disabled')
  check('and makes no requests', requests.length, 0)

  // ── Local time conversion ────────────────────────────────────
  // The helper the incoming half depends on, checked directly: an instant must
  // come back as the LOCAL wall clock, not the UTC one.
  const instant = new Date(2026, 8, 10, 14, 30, 0)
  check('an ISO instant converts to local wall-clock',
    calendarSync.toLocalSql(instant.toISOString(), true), '2026-09-10 14:30:00')
  check('a bare date converts to local midnight',
    calendarSync.toLocalSql('2026-09-10', false), '2026-09-10 00:00:00')
  check('a zone-less local time is taken as local',
    calendarSync.toLocalSql('2026-09-10T14:30:00', true), '2026-09-10 14:30:00')
  check('an unparseable value converts to null',
    calendarSync.toLocalSql('nonsense', true), null)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
