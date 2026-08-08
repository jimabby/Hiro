// Push notifications to paired phones.
//
// The desktop is the only thing that knows a recruiter replied, that an
// interview is tomorrow, or that a scan was blocked — but it is also the thing
// that might be closed, asleep, or in another room. Everything Hiro learns while
// the user is away was previously only visible by opening the app.
//
// Delivery path, with no Hiro server anywhere in it:
//
//   phone registers an Expo push token  →  devices.push_token (Supabase)
//   desktop reads the tokens            →  POST exp.host/--/api/v2/push/send
//   Expo forwards to APNs / FCM         →  phone
//
// Two properties this design has to have, and how:
//
//   Send once. Every notification carries a dedupe key, recorded in the local
//   `push_log` table BEFORE the request goes out. A reminder that fires on a
//   two-minute sync loop must not arrive thirty times an hour, and the ledger
//   has to survive a restart, so it lives in SQLite rather than memory.
//
//   Fail quietly. A notification is a courtesy. Nothing here may throw into a
//   scan, an inbox check or a sync — the caller's work matters more than the
//   ping about it.

const configService = require('./config')
const database = require('./database')
const logger = require('./logger')

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const TIMEOUT_MS = 15000
// Expo's documented ceiling per request.
const MAX_PER_REQUEST = 100

// Kinds map onto the per-kind switches in config.pushKinds. Keeping the mapping
// in one place stops a new kind from silently defaulting to "always send".
const KIND_SETTING = {
  reply: 'reply',
  interview: 'interview',
  expiring: 'expiring',
  'scan-failed': 'scanFailed',
  review: 'review',
  'new-device': 'newDevice',
  'follow-up': 'followUp',
}

function isEnabled(kind) {
  const cfg = configService.load()
  if (!cfg.pushEnabled) return false
  const key = KIND_SETTING[kind]
  if (!key) return false
  // Absent means on: a config written by an older build has no entry for a kind
  // added later, and silently disabling it would look like a broken feature.
  return cfg.pushKinds?.[key] !== false
}

// Tokens are registered by the phone into the shared `devices` table, so they
// come from cloudSync rather than local config. Required lazily: cloudSync
// requires this module for its own notifications.
async function getTargets() {
  try {
    const cloudSync = require('./cloudSync')
    return await cloudSync.getPushTargets()
  } catch {
    return []
  }
}

// An Expo token that no longer maps to an installed app comes back as
// DeviceNotRegistered. Leaving it in place means every later send wastes a slot
// and reports a failure forever, so clear it at the source.
async function dropDeadToken(deviceId) {
  try {
    const cloudSync = require('./cloudSync')
    await cloudSync.clearPushToken(deviceId)
    logger.append(`[push] Cleared a push token that is no longer registered (device ${deviceId})`)
  } catch { /* best-effort */ }
}

async function postToExpo(messages) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Expo compresses responses by default; being explicit keeps the
        // response shape predictable across runtimes.
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    })
    if (!res.ok) throw new Error(`Expo push returned HTTP ${res.status}`)
    const body = await res.json()
    return Array.isArray(body?.data) ? body.data : []
  } finally {
    clearTimeout(timer)
  }
}

// Send one notification to every registered phone.
//
// `dedupeKey` identifies the EVENT, not the send: 'interview:41:24h' is the
// 24-hour reminder for interview 41 and may only ever be sent once, however many
// times the check that produces it runs.
async function send({ kind, dedupeKey, title, body, data = {} }) {
  try {
    if (!isEnabled(kind)) return { sent: 0, reason: 'disabled' }
    if (!dedupeKey) throw new Error('a dedupe key is required')
    // Claim the key first. Claiming after a successful send would double-send
    // whenever the response is lost, which is the common failure on a laptop
    // that just woke up.
    if (!database.claimPushKey(dedupeKey, kind, title, body)) {
      return { sent: 0, reason: 'already-sent' }
    }

    const targets = await getTargets()
    if (targets.length === 0) {
      // The key stays claimed: there is no phone to tell, and telling it later
      // about a reply from last Tuesday is worse than not telling it.
      return { sent: 0, reason: 'no-devices' }
    }

    let sent = 0
    for (let i = 0; i < targets.length; i += MAX_PER_REQUEST) {
      const chunk = targets.slice(i, i + MAX_PER_REQUEST)
      const tickets = await postToExpo(chunk.map(t => ({
        to: t.token,
        title,
        body,
        sound: 'default',
        // Opens the right screen when the notification is tapped.
        data: { kind, ...data },
        // Group by kind so five expiring-application notices collapse into one
        // stack on Android rather than five separate cards.
        channelId: 'default',
        categoryId: kind,
        priority: kind === 'interview' ? 'high' : 'default',
      })))

      tickets.forEach((ticket, n) => {
        if (ticket?.status === 'ok') { sent++; return }
        const detail = ticket?.details?.error
        if (detail === 'DeviceNotRegistered') dropDeadToken(chunk[n].deviceId)
        else logger.append(`[push] ${title}: ${ticket?.message || detail || 'unknown error'}`)
      })
    }

    logger.append(`[push] ${kind}: "${title}" → ${sent}/${targets.length} device(s)`)
    return { sent, reason: null }
  } catch (err) {
    logger.append(`[push] Could not send "${title}": ${err.message}`)
    return { sent: 0, reason: err.message }
  }
}

// ─── Event notifications ─────────────────────────────────────────
// Called from the code that discovers the event, so the notification and the
// thing it is about cannot drift apart.

function notifyReply(app, classification) {
  const label = { interview: 'wants to interview you', offer: 'made an offer', rejected: 'passed' }[classification]
  return send({
    kind: 'reply',
    // Per application AND per classification: a company that first schedules an
    // interview and later makes an offer is two events worth hearing about.
    dedupeKey: `reply:${app.id}:${classification || 'unclassified'}`,
    title: `${app.company} replied`,
    body: label ? `${app.company} ${label} — ${app.job_title}` : `New reply about ${app.job_title}`,
    data: { applicationId: app.id },
  })
}

function notifyScanFailed({ error, blocked = [] }) {
  const what = blocked.length
    ? `Blocked on ${blocked.map(b => b.platform).join(', ')}`
    : (error || 'The scan did not complete')
  return send({
    kind: 'scan-failed',
    // One per day per failure reason: a scheduler retrying every hour must not
    // send an hourly notification, but tomorrow's failure is news again.
    dedupeKey: `scan-failed:${localDate()}:${(blocked.map(b => b.platform).join(',') || error || '').slice(0, 60)}`,
    title: 'Scan did not complete',
    body: what,
  })
}

function notifyNewDevice(device) {
  return send({
    kind: 'new-device',
    dedupeKey: `new-device:${device.device_id}`,
    title: 'New device signed in',
    body: `${device.name || 'A device'} (${device.platform || device.kind || 'unknown'}) is now syncing with your Hiro account.`,
    data: { deviceId: device.device_id },
  })
}

// ─── Scheduled checks ────────────────────────────────────────────
// These have no triggering event — they are true because of the clock — so they
// are recomputed on a timer and rely entirely on the dedupe ledger.

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatWhen(scheduledAt, hasTime) {
  const d = parseLocal(scheduledAt)
  if (!d) return scheduledAt
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  if (!hasTime) return date
  return `${date} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

// interview_events.scheduled_at is stored as local "YYYY-MM-DD HH:MM:SS". `new
// Date(string)` parses that as UTC in some runtimes and local in others, which
// would shift every reminder by the timezone offset.
function parseLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''))
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
}

async function checkInterviewReminders(cfg) {
  const hoursAhead = Array.isArray(cfg.interviewReminderHoursAhead)
    ? cfg.interviewReminderHoursAhead
    : [24, 2]
  const now = Date.now()
  for (const ev of database.getUpcomingInterviews(50)) {
    const when = parseLocal(ev.scheduled_at)
    if (!when) continue
    const hoursUntil = (when.getTime() - now) / 3600000
    if (hoursUntil < 0) continue
    // Fire the tightest window that has been entered. Sorting ascending means a
    // desktop that was off all day sends the 2-hour reminder rather than the
    // stale 24-hour one — and the dedupe key covers the window, so the 24-hour
    // reminder for the same interview will never arrive afterwards.
    const windows = [...hoursAhead].map(Number).filter(n => n > 0).sort((a, b) => a - b)
    const hit = windows.find(w => hoursUntil <= w)
    if (hit == null) continue
    await send({
      kind: 'interview',
      dedupeKey: `interview:${ev.id}:${hit}h:${ev.scheduled_at}`,
      title: hit <= 3 ? `Interview in ${Math.max(1, Math.round(hoursUntil))}h` : 'Interview tomorrow',
      body: `${ev.job_title || 'Interview'} at ${ev.company || 'unknown company'} — ${formatWhen(ev.scheduled_at, ev.has_time)}`,
      data: { applicationId: ev.application_id, interviewId: ev.id },
    })
  }
}

async function checkExpiring(cfg) {
  const days = Number(cfg.closingSoonDays) || 0
  if (days <= 0) return
  for (const job of database.getClosingSoon(days)) {
    await send({
      kind: 'expiring',
      // Per listing per closing date: a date the user corrects is a new event.
      dedupeKey: `expiring:${job.source}:${job.id}:${job.closing_date}`,
      title: 'Application closing soon',
      body: `${job.job_title} at ${job.company} closes ${job.closing_date}${job.source === 'attention' ? ' — still needs a manual application' : ' — still waiting for your approval'}`,
      data: { applicationId: job.source === 'application' ? job.id : null, attentionId: job.source === 'attention' ? job.id : null },
    })
  }
}

async function checkReviewQueue(cfg) {
  const held = database.getStats().heldCount
  if (held <= 0) return
  const everyHours = Math.max(1, Number(cfg.reviewReminderHours) || 24)
  // A queue that stays non-empty should be mentioned periodically, not once and
  // never again — bucketing the clock is what turns "send once" into "send at
  // most this often".
  const bucket = Math.floor(Date.now() / (everyHours * 3600000))
  await send({
    kind: 'review',
    dedupeKey: `review:${bucket}:${held}`,
    title: `${held} draft${held === 1 ? '' : 's'} waiting for review`,
    body: held === 1
      ? 'One application is drafted and waiting for your approval.'
      : `${held} applications are drafted and waiting for your approval.`,
  })
}

async function checkFollowUps() {
  for (const app of database.getDueNextActions()) {
    await send({
      kind: 'follow-up',
      dedupeKey: `follow-up:${app.id}:${app.next_action_at}`,
      title: 'Follow-up due',
      body: `${app.next_action_note || 'Follow up'} — ${app.job_title} at ${app.company}`,
      data: { applicationId: app.id },
    })
  }
}

// One pass over everything that is true because of the clock. Called from the
// scheduler; safe to call as often as you like thanks to the dedupe ledger.
async function runDueChecks() {
  try {
    const cfg = configService.load()
    if (!cfg.pushEnabled) return
    await checkInterviewReminders(cfg)
    await checkExpiring(cfg)
    await checkReviewQueue(cfg)
    await checkFollowUps()
  } catch (err) {
    logger.append(`[push] Scheduled checks failed: ${err.message}`)
  }
}

// Prove the whole path works — token registry, Expo, APNs/FCM — without waiting
// for a real event. Bypasses the ledger, since the point is to send it again.
async function sendTest() {
  const targets = await getTargets()
  if (targets.length === 0) {
    return { success: false, reason: 'No phone has registered for notifications yet. Sign in on the phone and enable notifications there.' }
  }
  try {
    const tickets = await postToExpo(targets.map(t => ({
      to: t.token,
      title: 'Hiro test notification',
      body: 'Push notifications are working.',
      sound: 'default',
      data: { kind: 'test' },
    })))
    const ok = tickets.filter(t => t?.status === 'ok').length
    const failures = tickets.filter(t => t?.status !== 'ok').map(t => t?.details?.error || t?.message).filter(Boolean)
    if (ok === 0) {
      return { success: false, reason: failures[0] || 'Expo accepted the request but delivered nothing.' }
    }
    return { success: true, sent: ok, total: targets.length, failures }
  } catch (err) {
    return { success: false, reason: err.message }
  }
}

module.exports = {
  send, sendTest, runDueChecks,
  notifyReply, notifyScanFailed, notifyNewDevice,
  // exported for tests
  parseLocal, isEnabled,
}
