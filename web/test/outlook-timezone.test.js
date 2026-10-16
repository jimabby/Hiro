// Outlook (Microsoft Graph) event times.
//
// Graph returns `start.dateTime` with no zone suffix and names the zone
// separately in `start.timeZone` — UTC unless a `Prefer: outlook.timezone`
// header asks for another. The adapter dropped `timeZone` and toLocalSql read
// the bare value as LOCAL time, so in Sydney an interview at 2pm came back from
// Outlook as 3am. Pinned here in a zone far from UTC so the offset shows.

process.env.TZ = 'Australia/Sydney'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-outlook-tz-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { calendarProvider: 'outlook', calendarSyncEnabled: true, calendarSyncCursor: '' }
const requests = []
let deltaItems = []

global.fetch = async (url, options = {}) => {
  requests.push({ url, method: options.method || 'GET', headers: options.headers || {} })
  const payload = /calendarView\/delta/.test(url) ? { value: deltaItems, '@odata.deltaLink': 'delta-1' }
    : /\/calendars$/.test(url) ? { value: [{ id: 'cal', name: 'Calendar', isDefaultCalendar: true }] }
      : {}
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

stub({
  './config': { CONFIG_DIR: TMP, load: () => config, update: (p) => { config = { ...config, ...p }; return config } },
  './logger': { append: () => {} },
  './calendarAuth': {
    getAccessToken: async () => 'token',
    isConnected: () => true,
    describeProviders: () => [{ id: 'outlook', label: 'Outlook' }],
    disconnect: () => ({ success: true }),
    PROVIDERS: { outlook: { label: 'Outlook' } },
  },
})

const calendarSync = service('calendarSync')
const { check, done } = createChecker()

;(async () => {
  const { graphInstant, toLocalSql } = calendarSync

  // 03:00 UTC on 20 Oct 2026 is 14:00 in Sydney (AEDT, UTC+11).
  const utc = { dateTime: '2026-10-20T03:00:00.0000000', timeZone: 'UTC' }
  check('a UTC time from Graph becomes an instant', graphInstant(utc), '2026-10-20T03:00:00.000Z')
  check('and lands at the right local wall time', toLocalSql(graphInstant(utc), true), '2026-10-20 14:00:00')
  check('the old path shifted it by the offset', toLocalSql(utc.dateTime, true) === '2026-10-20 14:00:00', false)

  // A named IANA zone (an event created elsewhere) is honoured too.
  const ny = { dateTime: '2026-10-20T09:00:00', timeZone: 'America/New_York' }
  check('an IANA zone is converted', graphInstant(ny), '2026-10-20T13:00:00.000Z')
  check('a value that already has an offset is kept', graphInstant({ dateTime: '2026-10-20T03:00:00Z', timeZone: 'UTC' }), '2026-10-20T03:00:00Z')
  check('a Windows zone name falls back to UTC', graphInstant({ dateTime: '2026-10-20T03:00:00', timeZone: 'Pacific Standard Time' }), '2026-10-20T03:00:00.000Z')
  check('nothing in, nothing out', graphInstant({}), null)

  // Graph is asked for UTC explicitly on every call.
  await calendarSync.listCalendars?.().catch(() => {})
  const graphCalls = requests.filter(r => r.url.startsWith('https://graph.microsoft.com'))
  check('Graph was called', graphCalls.length > 0, true)
  check('Graph requests carry Prefer: outlook.timezone="UTC"', graphCalls.every(r => r.headers.Prefer === 'outlook.timezone="UTC"'), true)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
