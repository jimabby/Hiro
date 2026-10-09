// "When are you free for a chat?" — answered from the calendar.
//
// A recruiter asking for availability is the most time-sensitive email in a
// job search, and answering it meant switching to a calendar, finding gaps,
// converting them to words and typing them out. Calendar sync already has the
// access; this reads busy time, finds free slots inside working hours, and
// drafts the reply.
//
// The reply is built from a template, not by a model. The times in it are the
// whole point of the email, and a model rewording "Tuesday 14 October, 10:00"
// is a model that can also change it. What is offered is exactly what was
// checked against the calendar.
//
// Nothing is sent. The draft is copied or opened in the user's mail app.

const database = require('./database')
const configService = require('./config')

const DAY_MS = 86400000

function parseHm(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''))
  if (!m) return fallback
  return Number(m[1]) * 60 + Number(m[2])
}

// interview_events.scheduled_at is local "YYYY-MM-DD HH:MM:SS".
function parseLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''))
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
}

// Free slots of `durationMin`, inside working hours on working days, clear of
// every busy interval by `bufferMin` either side. Spread across days — at most
// `perDay` a day, preferring one morning and one afternoon — because a list of
// five consecutive half-hours on Tuesday is not a choice. Pure.
function findSlots({
  busy = [], now = new Date(), days = 7, workStart = 9 * 60, workEnd = 17 * 60,
  workDays = [1, 2, 3, 4, 5], durationMin = 45, bufferMin = 15, stepMin = 30,
  minNoticeHours = 18, maxSlots = 5, perDay = 2,
} = {}) {
  const earliest = now.getTime() + minNoticeHours * 3600000
  const blocks = busy
    .map(b => ({ start: new Date(b.start).getTime() - bufferMin * 60000, end: new Date(b.end).getTime() + bufferMin * 60000 }))
    .filter(b => !isNaN(b.start) && !isNaN(b.end))
  const clear = (s, e) => !blocks.some(b => s < b.end && e > b.start)

  const slots = []
  for (let d = 0; d <= days && slots.length < maxSlots; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d)
    if (!workDays.includes(day.getDay())) continue
    const free = []
    for (let m = workStart; m + durationMin <= workEnd; m += stepMin) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60)
      const end = new Date(start.getTime() + durationMin * 60000)
      if (start.getTime() < earliest) continue
      if (clear(start.getTime(), end.getTime())) free.push({ start, end })
    }
    if (!free.length) continue
    const morning = free.find(f => f.start.getHours() < 12)
    const afternoon = free.find(f => f.start.getHours() >= 13)
    const picks = [morning, afternoon].filter(Boolean)
    if (!picks.length) picks.push(free[0])
    for (const p of picks.slice(0, perDay)) {
      if (slots.length < maxSlots) slots.push(p)
    }
  }
  return slots
}

function timeZoneLabel(date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName')
    return part?.value || Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return ''
  }
}

function describeSlot({ start, end }) {
  const date = start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const t = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${date}, ${t(start)}–${t(end)}`
}

// The reply. Plain, short, and every time in it is one that was checked.
function draftEmail({ slots, jobTitle, company, contactName = '', senderName = '', tz = timeZoneLabel() }) {
  const greeting = contactName ? `Hi ${contactName.split(/\s+/)[0]},` : 'Hi,'
  const lines = [
    greeting,
    '',
    `Thank you for getting in touch about the ${jobTitle} role${company ? ` at ${company}` : ''} — I'd be glad to talk.`,
    '',
    `I'm available at any of these times (${tz}):`,
    ...slots.map(s => `- ${describeSlot(s)}`),
    '',
    'If none of those suit, let me know a few times that work for you and I will do my best to fit in.',
    '',
    'Kind regards,',
    senderName || '',
  ]
  return lines.join('\n').trim()
}

// Everything for one application: slots, the draft, and what it was checked
// against. `getBusy` is calendarSync.getBusy, injected so tests need no network.
async function propose(applicationId, { now = new Date(), getBusy, cfg = configService.load() } = {}) {
  const app = database.getApplication(applicationId)
  if (!app) throw new Error('Application not found.')
  const days = Number(cfg.availabilityDays) || 7
  const to = new Date(now.getTime() + (days + 1) * DAY_MS)

  // Hiro's own interviews are always busy, connected calendar or not.
  const busy = database.getUpcomingInterviews(200)
    .map(e => ({ start: parseLocal(e.scheduled_at), hasTime: !!e.has_time }))
    .filter(e => e.start && e.hasTime)
    .map(e => ({ start: e.start, end: new Date(e.start.getTime() + 60 * 60000) }))

  let calendarChecked = false
  let calendarError = null
  if (getBusy) {
    try {
      const remote = await getBusy(now, to)
      if (remote) { busy.push(...remote); calendarChecked = true }
    } catch (err) {
      calendarError = err.message
    }
  }

  const slots = findSlots({
    busy, now, days,
    workStart: parseHm(cfg.availabilityStart, 9 * 60),
    workEnd: parseHm(cfg.availabilityEnd, 17 * 60),
    durationMin: Number(cfg.availabilityDurationMin) || 45,
  })

  const { contactFor } = require('./contactDetails')
  const replies = database.getRecruiterReplies(applicationId, 1) || []
  const lastReply = replies[0] || null
  const contactName = (/^"?([^"<@]+?)"?\s*</.exec(lastReply?.from_address || '') || [])[1] || ''
  const email = draftEmail({
    slots, jobTitle: app.job_title, company: app.company,
    contactName, senderName: contactFor(cfg).fullName,
  })
  return {
    slots: slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString(), label: describeSlot(s) })),
    email,
    subject: lastReply?.subject ? (/^re:/i.test(lastReply.subject) ? lastReply.subject : `Re: ${lastReply.subject}`) : `${app.job_title} — availability`,
    to: app.recruiter_email || '',
    calendarChecked,
    calendarError,
  }
}

module.exports = { propose, findSlots, draftEmail, describeSlot }
