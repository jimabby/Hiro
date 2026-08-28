// Two-way interview sync with Google Calendar or Outlook.
//
// The .ics export it replaces was one-way and one-shot: Hiro knew when every
// interview was, wrote a file, and from then on the two copies drifted. Moving an
// interview in Google Calendar left Hiro reminding you about the old time;
// correcting it in Hiro left the calendar wrong. Both are the failure that
// matters, because the calendar is the copy the user actually acts on.
//
// What "two-way" means here, precisely:
//
//   Hiro → calendar   Every interview becomes an event. Changing the time or the
//                     note in Hiro updates the event. Deleting the interview
//                     deletes the event, but ONLY if Hiro created it.
//   calendar → Hiro   Moving or deleting one of those events updates or deletes
//                     the interview.
//
// Events the user created themselves are left alone in both directions. Pulling
// them in would mean inventing an application for each one, and Hiro has nothing
// true to attach them to.
//
// Conflicts resolve by evidence rather than by clock comparison: an event whose
// remote timestamp has moved since Hiro last saw it was edited in the calendar,
// so the calendar wins for that event. Otherwise the local copy is authoritative.
// Comparing two machines' clocks — the obvious alternative — silently discards
// whichever side is running slow.

const crypto = require('crypto')
const configService = require('./config')
const database = require('./database')
const calendarAuth = require('./calendarAuth')
const logger = require('./logger')
const { DEFAULT_DURATION_MINUTES, parseLocalSql } = require('./calendar')

const GOOGLE_API = 'https://www.googleapis.com/calendar/v3'
const GRAPH_API = 'https://graph.microsoft.com/v1.0'
const TIMEOUT_MS = 20000

let syncing = false
let lastError = null
let lastResult = null

// ─── HTTP ────────────────────────────────────────────────────────

async function api(method, url, body) {
  const token = await calendarAuth.getAccessToken()
  if (!token) throw new Error('Not connected to a calendar.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    // 204 is a successful DELETE with no body, and a 404 on a DELETE means the
    // event is already gone — which is what the caller wanted either way.
    //
    // 404 on anything ELSE must still throw. Treating it as benign here meant a
    // PATCH of an event the user had deleted in their calendar returned null,
    // was counted as a successful update, and had its link re-saved with the new
    // hash — so the interview was never recreated and never retried.
    if (res.status === 204) return null
    if (res.status === 404 && method === 'DELETE') return null
    const text = await res.text()
    const parsed = text ? JSON.parse(text) : null
    if (!res.ok) {
      const message = parsed?.error?.message || parsed?.error_description || `HTTP ${res.status}`
      const err = new Error(message)
      err.status = res.status
      // Google signals "your sync token is too old to be useful" this way, and
      // the only correct response is a full resync rather than a retry.
      err.syncTokenExpired = res.status === 410
      throw err
    }
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

// ─── Local → event shape ─────────────────────────────────────────

function endOf(start, hasTime) {
  if (hasTime) {
    const d = new Date(start.year, start.month - 1, start.day, start.hour, start.minute + DEFAULT_DURATION_MINUTES)
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() }
  }
  // All-day events end on the following day (the end is exclusive in both APIs).
  const d = new Date(start.year, start.month - 1, start.day + 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: 0, minute: 0 }
}

const pad = (n) => String(n).padStart(2, '0')
const isoDate = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`
// Local wall-clock with no zone suffix. Both APIs accept this alongside an
// explicit timeZone, which is what keeps a 2pm interview at 2pm rather than
// shifting it by the machine's UTC offset.
const isoLocal = (p) => `${isoDate(p)}T${pad(p.hour)}:${pad(p.minute)}:00`

function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

function summaryFor(ev) {
  const title = ev.job_title || 'Interview'
  return ev.company ? `Interview: ${title} at ${ev.company}` : `Interview: ${title}`
}

function descriptionFor(ev) {
  return [
    ev.company ? `Company: ${ev.company}` : null,
    ev.platform ? `Found via: ${ev.platform}` : null,
    ev.note ? `Email subject: ${ev.note}` : null,
    // When the employer wrote a timezone, the stored time is a CONVERSION of
    // what they said. Saying so, and saying what they actually wrote, is the
    // difference between a user who can check the arithmetic and one who has to
    // trust it — and this event is the copy they will actually be looking at on
    // the morning.
    ev.source_zone && ev.source_local
      ? `They wrote: ${ev.source_local} ${ev.source_zone} — shown here in your local time.`
      : null,
    ev.source === 'inbox'
      ? 'Time detected automatically from the recruiter\'s email — double-check it against the original.'
      : null,
    ev.job_url || null,
    // A human-readable marker, so someone looking at the event in their calendar
    // can tell where it came from. The authoritative mapping is calendar_links.
    `[Hiro interview #${ev.id}]`,
  ].filter(Boolean).join('\n')
}

// Everything Hiro writes to the remote event. If this hash is unchanged there is
// nothing to push, which is what keeps a sync every two minutes from rewriting
// every event forever (and burning through the API quota doing it).
function localHash(ev) {
  return crypto.createHash('sha256').update(JSON.stringify([
    ev.scheduled_at, ev.has_time ? 1 : 0, summaryFor(ev), descriptionFor(ev),
  ])).digest('hex').slice(0, 32)
}

// ─── Provider adapters ───────────────────────────────────────────
// Each provider gets four operations. Keeping them behind one shape means the
// sync algorithm below is written once.

const google = {
  calendarPath(cfg) {
    return `${GOOGLE_API}/calendars/${encodeURIComponent(cfg.calendarId || 'primary')}/events`
  },

  body(ev, cfg) {
    const start = parseLocalSql(ev.scheduled_at)
    const hasTime = ev.has_time === 1 || ev.has_time === true
    const end = endOf(start, hasTime)
    const tz = localTimeZone()
    return {
      summary: summaryFor(ev),
      description: descriptionFor(ev),
      start: hasTime ? { dateTime: isoLocal(start), timeZone: tz } : { date: isoDate(start) },
      end: hasTime ? { dateTime: isoLocal(end), timeZone: tz } : { date: isoDate(end) },
      // An auto-detected time is a best-effort parse of an email, so the calendar
      // shows it as unconfirmed rather than as fact.
      status: 'confirmed',
      transparency: ev.source === 'inbox' ? 'transparent' : 'opaque',
      // Survives Hiro being reinstalled: the mapping can be rebuilt from the
      // events themselves rather than only from the local database.
      extendedProperties: { private: { hiroInterviewId: String(ev.id) } },
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: Number(cfg.calendarReminderMinutes) || 60 }],
      },
    }
  },

  async create(ev, cfg) {
    const created = await api('POST', this.calendarPath(cfg), this.body(ev, cfg))
    return { externalId: created.id, remoteUpdatedAt: created.updated || null }
  },

  async update(externalId, ev, cfg) {
    const updated = await api('PATCH', `${this.calendarPath(cfg)}/${encodeURIComponent(externalId)}`, this.body(ev, cfg))
    return { remoteUpdatedAt: updated?.updated || null }
  },

  async remove(externalId, cfg) {
    await api('DELETE', `${this.calendarPath(cfg)}/${encodeURIComponent(externalId)}`)
  },

  // Google's incremental sync: the first pass returns a nextSyncToken, later
  // passes pass it back and receive only what changed since.
  async changes(cfg, cursor) {
    const items = []
    let pageToken = null
    let nextCursor = cursor
    do {
      const params = new URLSearchParams({ maxResults: '250', showDeleted: 'true' })
      if (cursor) params.set('syncToken', cursor)
      // A first pass with no token would otherwise walk the user's entire
      // calendar history.
      else params.set('timeMin', new Date(Date.now() - 30 * 86400000).toISOString())
      if (pageToken) params.set('pageToken', pageToken)

      const page = await api('GET', `${this.calendarPath(cfg)}?${params}`)
      items.push(...(page.items || []))
      pageToken = page.nextPageToken || null
      if (page.nextSyncToken) nextCursor = page.nextSyncToken
    } while (pageToken)

    return {
      cursor: nextCursor,
      events: items.map(e => ({
        externalId: e.id,
        deleted: e.status === 'cancelled',
        updatedAt: e.updated || null,
        hiroInterviewId: e.extendedProperties?.private?.hiroInterviewId || null,
        start: e.start?.dateTime || e.start?.date || null,
        hasTime: !!e.start?.dateTime,
      })),
    }
  },

  async listCalendars() {
    const res = await api('GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer')
    return (res.items || []).map(c => ({ id: c.id, label: c.summary, primary: !!c.primary }))
  },
}

const outlook = {
  eventsPath(cfg) {
    return cfg.calendarId
      ? `${GRAPH_API}/me/calendars/${encodeURIComponent(cfg.calendarId)}/events`
      : `${GRAPH_API}/me/events`
  },

  body(ev, cfg) {
    const start = parseLocalSql(ev.scheduled_at)
    const hasTime = ev.has_time === 1 || ev.has_time === true
    const end = endOf(start, hasTime)
    const tz = localTimeZone()
    return {
      subject: summaryFor(ev),
      body: { contentType: 'text', content: descriptionFor(ev) },
      // Graph requires a dateTime even for all-day events, and insists the times
      // be midnight when isAllDay is set.
      start: { dateTime: hasTime ? isoLocal(start) : `${isoDate(start)}T00:00:00`, timeZone: tz },
      end: { dateTime: hasTime ? isoLocal(end) : `${isoDate(end)}T00:00:00`, timeZone: tz },
      isAllDay: !hasTime,
      isReminderOn: true,
      reminderMinutesBeforeStart: Number(cfg.calendarReminderMinutes) || 60,
      showAs: ev.source === 'inbox' ? 'tentative' : 'busy',
      // Graph has no extendedProperties equivalent that survives a PATCH cleanly,
      // so the marker lives in the body and the mapping in calendar_links.
      categories: ['Hiro'],
    }
  },

  async create(ev, cfg) {
    const created = await api('POST', this.eventsPath(cfg), this.body(ev, cfg))
    return { externalId: created.id, remoteUpdatedAt: created.lastModifiedDateTime || null }
  },

  async update(externalId, ev, cfg) {
    const updated = await api('PATCH', `${GRAPH_API}/me/events/${encodeURIComponent(externalId)}`, this.body(ev, cfg))
    return { remoteUpdatedAt: updated?.lastModifiedDateTime || null }
  },

  async remove(externalId) {
    await api('DELETE', `${GRAPH_API}/me/events/${encodeURIComponent(externalId)}`)
  },

  // Graph's delta query. The cursor is a full URL rather than a token, so the
  // first call builds one and later calls use what the last pass handed back.
  async changes(cfg, cursor) {
    const from = new Date(Date.now() - 30 * 86400000).toISOString()
    const to = new Date(Date.now() + 365 * 86400000).toISOString()
    let url = cursor
      || `${GRAPH_API}/me/calendarView/delta?startDateTime=${from}&endDateTime=${to}`
    const items = []
    let nextCursor = cursor
    // Guard against a provider that keeps handing back a nextLink: a delta walk
    // is bounded in practice, and an unbounded loop here would hang the sync.
    for (let page = 0; page < 50; page++) {
      const res = await api('GET', url)
      items.push(...(res.value || []))
      if (res['@odata.nextLink']) { url = res['@odata.nextLink']; continue }
      nextCursor = res['@odata.deltaLink'] || nextCursor
      break
    }
    return {
      cursor: nextCursor,
      events: items.map(e => ({
        externalId: e.id,
        deleted: !!e['@removed'],
        updatedAt: e.lastModifiedDateTime || null,
        // Recovered from the body marker, since Graph has no private property
        // that round-trips reliably.
        hiroInterviewId: (/\[Hiro interview #(\d+)\]/.exec(e.body?.content || e.bodyPreview || '') || [])[1] || null,
        start: e.start?.dateTime || null,
        hasTime: e.isAllDay === false,
      })),
    }
  },

  async listCalendars() {
    const res = await api('GET', `${GRAPH_API}/me/calendars`)
    return (res.value || [])
      .filter(c => c.canEdit !== false)
      .map(c => ({ id: c.id, label: c.name, primary: !!c.isDefaultCalendar }))
  },
}

function adapter(provider) {
  if (provider === 'google') return google
  if (provider === 'outlook') return outlook
  throw new Error(`Unknown calendar provider: ${provider}`)
}

// ─── Outgoing: Hiro → calendar ───────────────────────────────────

async function pushLocal(provider, cfg) {
  const impl = adapter(provider)
  const events = database.getAllInterviewEventsForSync()
  let created = 0
  let updated = 0

  for (const ev of events) {
    if (!parseLocalSql(ev.scheduled_at)) continue // unparseable date; nothing true to write
    const hash = localHash(ev)
    const link = database.getCalendarLink({ provider, interviewId: ev.id })

    if (!link) {
      const { externalId, remoteUpdatedAt } = await impl.create(ev, cfg)
      database.saveCalendarLink({ interviewId: ev.id, provider, externalId, origin: 'hiro', localHash: hash, remoteUpdatedAt })
      created++
      continue
    }
    if (link.local_hash === hash) continue // nothing has changed on this side
    try {
      const { remoteUpdatedAt } = await impl.update(link.external_id, ev, cfg)
      database.saveCalendarLink({ interviewId: ev.id, provider, externalId: link.external_id, origin: link.origin, localHash: hash, remoteUpdatedAt })
      updated++
    } catch (err) {
      // The user deleted the event in their calendar and then edited the
      // interview in Hiro. Recreate rather than failing the whole sync.
      if (err.status === 404 || err.status === 410) {
        database.deleteCalendarLink(link.id)
        const recreated = await impl.create(ev, cfg)
        database.saveCalendarLink({ interviewId: ev.id, provider, externalId: recreated.externalId, origin: 'hiro', localHash: hash, remoteUpdatedAt: recreated.remoteUpdatedAt })
        created++
      } else {
        throw err
      }
    }
  }
  return { created, updated }
}

// Interviews deleted in Hiro. Only events Hiro created are removed — an event
// the user made themselves is theirs, even if it once got linked.
async function pushDeletions(provider, cfg) {
  const impl = adapter(provider)
  let deleted = 0
  for (const link of database.getOrphanedCalendarLinks(provider)) {
    if (link.origin === 'hiro') {
      try { await impl.remove(link.external_id, cfg) } catch (err) {
        if (err.status !== 404 && err.status !== 410) throw err
      }
      deleted++
    }
    database.deleteCalendarLink(link.id)
  }
  return { deleted }
}

// ─── Incoming: calendar → Hiro ───────────────────────────────────

// Both providers hand back an ISO instant (or a bare date for all-day events).
// interview_events stores local wall-clock "YYYY-MM-DD HH:MM:SS", so convert
// through the local zone rather than slicing the string — slicing an ISO instant
// keeps the UTC hour and moves every interview by the offset.
function toLocalSql(value, hasTime) {
  if (!value) return null
  if (!hasTime || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value)
    return m ? `${m[1]} 00:00:00` : null
  }
  // Graph returns a zone-less local time (with the zone named separately);
  // Google returns a full offset. A zone-less value is already local.
  const d = /[Z+]|[-]\d{2}:\d{2}$/.test(value) ? new Date(value) : new Date(value.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

async function pullRemote(provider, cfg) {
  const impl = adapter(provider)
  let result
  try {
    result = await impl.changes(cfg, cfg.calendarSyncCursor || '')
  } catch (err) {
    if (!err.syncTokenExpired) throw err
    // The cursor aged out (Google keeps them for a few weeks). Start again from
    // scratch rather than silently stopping.
    logger.append('Calendar: the incremental sync cursor expired — doing a full pass.')
    configService.update({ calendarSyncCursor: '' })
    result = await impl.changes(cfg, '')
  }

  let moved = 0
  let removed = 0

  for (const remote of result.events) {
    const link = database.getCalendarLink({ provider, externalId: remote.externalId })
    // Not one of ours. Adopting it would mean inventing an application to hang
    // it off, so it is left alone — including events created in the calendar by
    // the user, which is the common case here.
    if (!link) continue

    if (remote.deleted) {
      if (link.interview_id) {
        database.deleteInterviewEvent(link.interview_id)
        removed++
      }
      database.deleteCalendarLink(link.id)
      continue
    }

    // Unchanged since Hiro last wrote or read it: nothing to apply. This is also
    // what stops Hiro's own writes from bouncing back as remote edits.
    if (link.remote_updated_at && remote.updatedAt && link.remote_updated_at === remote.updatedAt) continue

    const scheduledAt = toLocalSql(remote.start, remote.hasTime)
    if (!scheduledAt || !link.interview_id) {
      database.saveCalendarLink({
        interviewId: link.interview_id, provider, externalId: remote.externalId,
        origin: link.origin, localHash: link.local_hash, remoteUpdatedAt: remote.updatedAt,
      })
      continue
    }

    const current = database.getInterviewEvent(link.interview_id)
    if (!current) continue
    const sameTime = current.scheduled_at === scheduledAt
      && (current.has_time === 1) === !!remote.hasTime
    if (!sameTime) {
      // The calendar is where the user actually rescheduled, so it wins for the
      // time. Recording it as a 'calendar' source keeps the provenance honest —
      // it is no longer the time Hiro parsed out of an email.
      database.updateInterviewEventTime(link.interview_id, {
        scheduledAt,
        hasTime: !!remote.hasTime,
        source: 'calendar',
      })
      moved++
      logger.append(`Calendar: ${current.company || 'interview'} moved to ${scheduledAt} in your calendar — updated locally.`)
    }

    // Re-hash from the now-current local row, so the outgoing pass does not
    // immediately push the old time back over the user's change.
    const refreshed = database.getInterviewEvent(link.interview_id)
    database.saveCalendarLink({
      interviewId: link.interview_id, provider, externalId: remote.externalId,
      origin: link.origin, localHash: refreshed ? localHash(refreshed) : link.local_hash,
      remoteUpdatedAt: remote.updatedAt,
    })
  }

  if (result.cursor && result.cursor !== cfg.calendarSyncCursor) {
    configService.update({ calendarSyncCursor: result.cursor })
  }
  return { moved, removed }
}

// ─── Entry points ────────────────────────────────────────────────

async function syncNow({ force = false } = {}) {
  const cfg = configService.load()
  if (!cfg.calendarSyncEnabled || !cfg.calendarProvider) return { skipped: 'disabled' }
  if (!calendarAuth.isConnected()) return { skipped: 'not-connected' }
  if (syncing && !force) return { skipped: 'already-running' }

  syncing = true
  try {
    // Incoming first, for the same reason cloud sync pulls before pushing: apply
    // the edits made elsewhere before overwriting anything with the local copy.
    const pulled = await pullRemote(cfg.calendarProvider, cfg)
    const pushed = await pushLocal(cfg.calendarProvider, cfg)
    const removed = await pushDeletions(cfg.calendarProvider, cfg)

    lastError = null
    lastResult = { at: new Date().toISOString(), ...pulled, ...pushed, ...removed }
    configService.update({ lastCalendarSyncAt: lastResult.at })
    const touched = pushed.created + pushed.updated + removed.deleted + pulled.moved + pulled.removed
    if (touched > 0) {
      logger.append(
        `Calendar sync: ${pushed.created} created, ${pushed.updated} updated, `
        + `${removed.deleted} deleted, ${pulled.moved} moved from the calendar, ${pulled.removed} removed there.`
      )
    }
    return lastResult
  } catch (err) {
    lastError = err.message
    logger.append(`Calendar sync failed: ${err.message}`)
    return { error: err.message }
  } finally {
    syncing = false
  }
}

async function listCalendars() {
  const cfg = configService.load()
  if (!cfg.calendarProvider) return []
  return adapter(cfg.calendarProvider).listCalendars()
}

function getStatus() {
  const cfg = configService.load()
  const provider = cfg.calendarProvider || ''
  return {
    providers: calendarAuth.describeProviders(),
    provider,
    label: calendarAuth.PROVIDERS[provider]?.label || '',
    connected: calendarAuth.isConnected(),
    enabled: !!cfg.calendarSyncEnabled,
    calendarId: cfg.calendarId || '',
    syncing,
    lastSyncAt: cfg.lastCalendarSyncAt || null,
    lastResult,
    error: lastError,
    reminderMinutes: Number(cfg.calendarReminderMinutes) || 60,
    // How many interviews are currently mirrored, so the UI can say something
    // true rather than "connected" and nothing else.
    linkedCount: (() => { try { return database.getCalendarLinks(provider).length } catch { return 0 } })(),
  }
}

// Disconnecting leaves the events in the user's calendar: they are the user's
// data, and silently deleting a month of interviews because a token was revoked
// would be indefensible. The local links go, so reconnecting starts clean.
function disconnect() {
  const cfg = configService.load()
  const provider = cfg.calendarProvider
  if (provider) {
    for (const link of database.getCalendarLinks(provider)) database.deleteCalendarLink(link.id)
  }
  lastResult = null
  lastError = null
  return calendarAuth.disconnect()
}

module.exports = {
  syncNow, listCalendars, getStatus, disconnect,
  connect: calendarAuth.connect,
  // exported for tests
  localHash, toLocalSql, endOf,
}
