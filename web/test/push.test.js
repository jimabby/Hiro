// Push notifications: the dedupe ledger, the per-kind switches, and the
// clock-driven reminders.
//
// The property that matters most is "send once". Every reminder here is
// recomputed on a two-minute sync loop and again on a ten-minute cron, so
// anything that is true because of the clock would arrive dozens of times an hour
// without a ledger — and the ledger has to survive a restart, which is why it is
// a SQLite table rather than a Set.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-push-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

// Config is a stub so the per-kind switches can be flipped between assertions.
let config = {}
const setConfig = (patch) => { config = { ...config, ...patch } }

// Every request Expo would have received, and the canned reply.
const sent = []
let expoReply = (messages) => messages.map(() => ({ status: 'ok' }))
let expoThrow = null

global.fetch = async (url, options) => {
  const messages = JSON.parse(options.body)
  sent.push({ url, messages })
  if (expoThrow) throw new Error(expoThrow)
  return { ok: true, status: 200, json: async () => ({ data: expoReply(messages) }) }
}

// Devices the desktop would find registered on the account.
let targets = [{ deviceId: 'phone-1', token: 'ExponentPushToken[aaa]' }]
const cleared = []

stub({
  './config': { CONFIG_DIR: TMP, load: () => config, update: (p) => setConfig(p) },
  './cloudSync': {
    getPushTargets: async () => targets,
    clearPushToken: async (id) => { cleared.push(id) },
  },
  './logger': { append: () => {} },
})

const db = service('database')
const push = service('push')
const { check, done } = createChecker()

let seq = 0
function addApplication(extra = {}) {
  seq++
  db.insertApplication({
    job_title: extra.job_title || `Role ${seq}`,
    company: extra.company || `Company ${seq}`,
    platform: 'Seek',
    salary: '',
    job_url: `https://example.com/job/${seq}`,
    job_description: '',
    match_score: 90,
    match_explanation: '',
    tailored_resume: '',
    screening_qa: [],
    status: extra.status || 'applied',
    closing_date: extra.closing_date || null,
  })
  return seq
}

// Local "YYYY-MM-DD HH:MM:SS", which is how interview_events stores a time.
function localSql(hoursFromNow) {
  const d = new Date(Date.now() + hoursFromNow * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`
}

function localDate(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function main() {
  await db.init()
  setConfig({ pushEnabled: true, pushKinds: {} })

  // ── Disabled means nothing leaves the machine ─────────────────
  setConfig({ pushEnabled: false })
  let res = await push.send({ kind: 'reply', dedupeKey: 'off:1', title: 'x', body: 'y' })
  check('nothing is sent while push is disabled', [res.sent, res.reason], [0, 'disabled'])
  check('no request was made', sent.length, 0)
  // And the key must NOT have been claimed, or enabling notifications later would
  // silently swallow the first event of every kind.
  setConfig({ pushEnabled: true })
  res = await push.send({ kind: 'reply', dedupeKey: 'off:1', title: 'x', body: 'y' })
  check('a key refused while disabled is still available', res.sent, 1)

  // ── Send once ─────────────────────────────────────────────────
  sent.length = 0
  res = await push.send({ kind: 'reply', dedupeKey: 'once:1', title: 'First', body: 'b' })
  check('the first send goes out', res.sent, 1)
  res = await push.send({ kind: 'reply', dedupeKey: 'once:1', title: 'First', body: 'b' })
  check('the same event is not sent twice', [res.sent, res.reason], [0, 'already-sent'])
  check('only one request reached Expo', sent.length, 1)

  // The ledger is a table, so it survives a restart. Re-init and try again.
  await db.init()
  res = await push.send({ kind: 'reply', dedupeKey: 'once:1', title: 'First', body: 'b' })
  check('the ledger survives a restart', res.reason, 'already-sent')

  // ── Per-kind switches ─────────────────────────────────────────
  setConfig({ pushKinds: { scanFailed: false } })
  res = await push.send({ kind: 'scan-failed', dedupeKey: 'kind:1', title: 'x', body: 'y' })
  check('a switched-off kind is not sent', res.reason, 'disabled')
  // Absent means ON: a config written before a kind existed must not read as
  // "the user switched this off".
  setConfig({ pushKinds: { scanFailed: false } })
  res = await push.send({ kind: 'interview', dedupeKey: 'kind:2', title: 'x', body: 'y' })
  check('a kind with no entry defaults to on', res.sent, 1)
  setConfig({ pushKinds: {} })

  // An unknown kind must fail closed rather than bypass the switches entirely.
  res = await push.send({ kind: 'invented', dedupeKey: 'kind:3', title: 'x', body: 'y' })
  check('an unrecognised kind is refused', res.reason, 'disabled')

  // ── No phones registered ──────────────────────────────────────
  targets = []
  res = await push.send({ kind: 'reply', dedupeKey: 'nodev:1', title: 'x', body: 'y' })
  check('nothing is sent with no registered phone', [res.sent, res.reason], [0, 'no-devices'])
  targets = [{ deviceId: 'phone-1', token: 'ExponentPushToken[aaa]' }]

  // ── A dead token is cleared at the source ─────────────────────
  expoReply = () => [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]
  res = await push.send({ kind: 'reply', dedupeKey: 'dead:1', title: 'x', body: 'y' })
  check('a failed delivery is not counted as sent', res.sent, 0)
  check('an unregistered token is cleared', cleared, ['phone-1'])
  expoReply = (messages) => messages.map(() => ({ status: 'ok' }))

  // ── A transport failure must not throw into the caller ────────
  expoThrow = 'network is down'
  res = await push.send({ kind: 'reply', dedupeKey: 'boom:1', title: 'x', body: 'y' })
  check('a transport failure is reported, not thrown', [res.sent, res.reason], [0, 'network is down'])
  expoThrow = null

  // ── Payload shape ─────────────────────────────────────────────
  sent.length = 0
  await push.send({
    kind: 'interview', dedupeKey: 'shape:1', title: 'Interview tomorrow',
    body: 'Acme at 2pm', data: { applicationId: 7 },
  })
  const msg = sent[0].messages[0]
  check('addressed to the registered token', msg.to, 'ExponentPushToken[aaa]')
  check('carries the title and body', [msg.title, msg.body], ['Interview tomorrow', 'Acme at 2pm'])
  // The kind rides in the payload so a tap can open the right screen.
  check('carries the kind and the target', [msg.data.kind, msg.data.applicationId], ['interview', 7])
  // An interview is time-critical; everything else can wait for the next window.
  check('interviews are sent at high priority', msg.priority, 'high')

  // ── Batching ──────────────────────────────────────────────────
  // Expo caps a request at 100 messages.
  targets = Array.from({ length: 150 }, (_, i) => ({ deviceId: `d${i}`, token: `t${i}` }))
  sent.length = 0
  res = await push.send({ kind: 'reply', dedupeKey: 'batch:1', title: 'x', body: 'y' })
  check('150 devices are split across two requests', sent.length, 2)
  check('the first request carries 100 messages', sent[0].messages.length, 100)
  check('every device was reached', res.sent, 150)
  targets = [{ deviceId: 'phone-1', token: 'ExponentPushToken[aaa]' }]

  // ── Interview reminders ───────────────────────────────────────
  const appId = addApplication({ status: 'interview', company: 'Acme' })
  db.addInterviewEvent({ applicationId: appId, scheduledAt: localSql(20), hasTime: true, source: 'inbox' })
  setConfig({ interviewReminderHoursAhead: [24, 2] })

  sent.length = 0
  await push.runDueChecks()
  check('an interview 20 hours out triggers the 24-hour reminder', sent.length, 1)

  // The point of the ledger: running the checks again on the next sync must be
  // silent.
  sent.length = 0
  await push.runDueChecks()
  check('re-running the checks sends nothing', sent.length, 0)

  // An interview further out than every window is not yet news.
  const farId = addApplication({ status: 'interview', company: 'Later Ltd' })
  db.addInterviewEvent({ applicationId: farId, scheduledAt: localSql(24 * 10), hasTime: true })
  sent.length = 0
  await push.runDueChecks()
  check('an interview ten days out is not announced', sent.length, 0)

  // ── Closing dates ─────────────────────────────────────────────
  // Only rows that were never submitted: a deadline on an application already
  // sent is not something the user can act on.
  setConfig({ closingSoonDays: 3, reviewReminderHours: 24 })
  // The held row also puts something in the review queue, so this one pass
  // exercises both checks — which is the realistic shape anyway.
  addApplication({ status: 'held', closing_date: localDate(2), company: 'Soon Co' })
  addApplication({ status: 'applied', closing_date: localDate(2), company: 'Already Sent Co' })
  sent.length = 0
  await push.runDueChecks()
  const messages = sent.flatMap(s => s.messages)
  const closingBodies = messages.map(m => m.body).join('\n')
  check('a held row closing soon is announced', /Soon Co/.test(closingBodies), true)
  check('an already-submitted row is not', /Already Sent Co/.test(closingBodies), false)

  // ── Review queue ──────────────────────────────────────────────
  // Bucketed so a queue that stays non-empty is mentioned periodically rather
  // than once and never again — but not more than once per configured window.
  check('the review queue is announced',
    messages.filter(m => /waiting for review/.test(m.title)).length, 1)
  sent.length = 0
  await push.runDueChecks()
  check('the review queue is not announced again in the same window', sent.length, 0)

  // ── Follow-ups ────────────────────────────────────────────────
  const dueId = addApplication({ status: 'applied', company: 'Chase Me Ltd' })
  db.setNextAction(dueId, { date: localDate(-1), note: 'Chase the recruiter' })
  sent.length = 0
  await push.runDueChecks()
  const followUp = sent.flatMap(s => s.messages).find(m => m.title === 'Follow-up due')
  check('an overdue follow-up is announced', !!followUp, true)
  check('the note is the notification body', /Chase the recruiter/.test(followUp?.body || ''), true)

  // ── Event helpers ─────────────────────────────────────────────
  sent.length = 0
  await push.notifyReply({ id: 42, company: 'Globex', job_title: 'Engineer' }, 'interview')
  check('a reply notification names the company', sent[0].messages[0].title, 'Globex replied')
  // A company that first schedules an interview and later makes an offer is two
  // events worth hearing about, so the classification is part of the key.
  sent.length = 0
  await push.notifyReply({ id: 42, company: 'Globex', job_title: 'Engineer' }, 'interview')
  check('the same reply classification is not repeated', sent.length, 0)
  await push.notifyReply({ id: 42, company: 'Globex', job_title: 'Engineer' }, 'offer')
  check('a later offer from the same company is announced', sent.length, 1)

  // Two blocks on the same day are one notification; a different reason is not.
  sent.length = 0
  await push.notifyScanFailed({ blocked: [{ platform: 'Seek' }] })
  await push.notifyScanFailed({ blocked: [{ platform: 'Seek' }] })
  check('a repeated block is announced once a day', sent.length, 1)
  await push.notifyScanFailed({ blocked: [{ platform: 'Indeed' }] })
  check('a block on a different platform is a new event', sent.length, 2)

  // ── The test notification bypasses the ledger ─────────────────
  // Its whole purpose is to be sent again, on demand.
  sent.length = 0
  let test = await push.sendTest()
  check('the test notification is sent', [test.success, test.sent], [true, 1])
  test = await push.sendTest()
  check('the test notification can be sent repeatedly', test.success, true)
  targets = []
  test = await push.sendTest()
  check('the test says so when no phone is registered', test.success, false)
  check('and explains what to do', /Sign in on the phone/.test(test.reason), true)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
