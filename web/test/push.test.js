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

  // …and it stays quiet when the queue GROWS inside that window. The held count
  // used to be part of the dedupe key, which quietly undid the rate limit it was
  // sitting inside: every new draft minted a fresh key, so a scan drafting ten
  // applications one at a time sent ten notifications where one was allowed.
  addApplication({ status: 'held', company: 'Second Draft Co' })
  addApplication({ status: 'held', company: 'Third Draft Co' })
  sent.length = 0
  await push.runDueChecks()
  check('a growing review queue does not re-notify inside the window',
    sent.flatMap(s => s.messages).filter(m => /waiting for review/.test(m.title)).length, 0)

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

  // ── Offer deadlines ──────────────────────────────────────────
  // The only externally-imposed deadline in Hiro: miss a respond_by and the
  // offer is gone. It was also the only due-date sweep with no notification at
  // all, on a page whose entire design is built around hoisting whichever
  // deadline expires first.
  sent.length = 0
  targets = [{ deviceId: 'phone-1', token: 'ExponentPushToken[aaa]' }]
  setConfig({ pushEnabled: true, pushKinds: {} })

  const soon = addApplication({ company: 'Northwind', job_title: 'Staff Engineer', status: 'offer' })
  const later = addApplication({ company: 'Contoso', job_title: 'Principal', status: 'offer' })
  const undated = addApplication({ company: 'Fabrikam', job_title: 'Lead', status: 'offer' })
  db.saveOffer(soon, { baseSalary: 180000, bonus: 20000, currency: 'AUD', respondBy: localDate(2), decision: 'considering' })
  db.saveOffer(later, { baseSalary: 150000, respondBy: localDate(40), decision: 'considering' })
  db.saveOffer(undated, { baseSalary: 140000, decision: 'considering' })

  await push.checkOfferDeadlines()
  check('only the offer inside a window is announced', sent.length, 1)
  check('the notification names the employer', /Northwind/.test(sent[0].messages[0].title), true)
  check('and says how long is left', /2 days to respond/.test(sent[0].messages[0].title), true)
  check('the body carries the deadline', /respond by/.test(sent[0].messages[0].body), true)
  check('and the money, so it is decidable from the lock screen', /200k AUD/.test(sent[0].messages[0].body), true)
  // The offer board is what the reader wants, not the job advert behind it.
  check('it routes to the offers tab', sent[0].messages[0].data.tab, 'offers')

  // Runs on a two-minute sync loop, so "send once" is the property that matters.
  sent.length = 0
  await push.checkOfferDeadlines()
  await push.checkOfferDeadlines()
  check('the same deadline is not repeated', sent.length, 0)

  // A deadline that has already passed is a fact, not a reminder, and not one
  // the user can act on any more.
  sent.length = 0
  const gone = addApplication({ company: 'Tailspin', status: 'offer' })
  db.saveOffer(gone, { baseSalary: 100000, respondBy: localDate(-3), decision: 'considering' })
  await push.checkOfferDeadlines()
  check('an expired deadline is not announced', sent.length, 0)

  // A decision already taken has no deadline left to warn about.
  sent.length = 0
  const settled = addApplication({ company: 'Litware', status: 'offer' })
  db.saveOffer(settled, { baseSalary: 170000, respondBy: localDate(1), decision: 'accepted' })
  await push.checkOfferDeadlines()
  check('a settled offer is not announced', sent.length, 0)

  // Each window is its own event, so an offer warned about at seven days is
  // warned about again when it reaches three.
  sent.length = 0
  const walking = addApplication({ company: 'Adventure Works', status: 'offer' })
  db.saveOffer(walking, { baseSalary: 160000, respondBy: localDate(6), decision: 'considering' })
  await push.checkOfferDeadlines()
  check('the seven-day window fires', sent.length, 1)
  db.saveOffer(walking, { baseSalary: 160000, respondBy: localDate(3), decision: 'considering' })
  await push.checkOfferDeadlines()
  check('the three-day window fires as well', sent.length, 2)
  check('and it is more urgent', /3 days/.test(sent[1].messages[0].title), true)

  // The per-kind switch has to reach it. A kind missing from KIND_SETTING is
  // silently never sent, which is the failure this check exists to catch.
  sent.length = 0
  setConfig({ pushEnabled: true, pushKinds: { offerDeadline: false } })
  const muted = addApplication({ company: 'Proseware', status: 'offer' })
  db.saveOffer(muted, { baseSalary: 120000, respondBy: localDate(1), decision: 'considering' })
  await push.checkOfferDeadlines()
  check('switching the kind off silences it', sent.length, 0)
  setConfig({ pushEnabled: true, pushKinds: {} })
  await push.checkOfferDeadlines()
  check('and switching it back on lets it through', sent.length, 1)

  // An advertised band must never be presented as an offer figure.
  sent.length = 0
  const advertised = addApplication({ company: 'Wingtip', status: 'offer' })
  db.saveOffer(advertised, { respondBy: localDate(1), decision: 'considering' })
  await push.checkOfferDeadlines()
  check('an offer with no figure entered still warns', sent.length, 1)
  check('and quotes no total it does not have', /total/.test(sent[0].messages[0].body), false)

  check('a round thousand reads as k', push.formatMoney(200000, 'AUD'), '200k AUD')
  check('a small figure is not abbreviated', push.formatMoney(850, ''), '850')
  check('a non-number is passed through rather than guessed at', push.formatMoney('negotiable', ''), 'negotiable')

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
