// The database halves of the November features, against a real (temporary)
// database: thank-you tasks after an interview, the counts behind weekly goals,
// and the job descriptions the skills-gap report reads.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-weekly-'))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
stub({ './config': { CONFIG_DIR: tmp, load: () => ({}), update: () => ({}) } })

const db = service('database')
const hub = service('featureHub')
const goals = service('weeklyGoals')
const { check, done } = createChecker()

const pad = n => String(n).padStart(2, '0')
const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000)

;(async () => {
  await db.init()
  const longText = 'We are hiring. '.repeat(20)
  const add = (url, extra = {}) => db.insertApplication({
    job_title: 'Engineer', company: 'Example', platform: 'Seek', job_url: url, job_description: longText, status: 'interview', ...extra,
  }).id

  // ── Thank-you notes ─────────────────────────────────────────────
  const a = add('https://example.com/a')
  const b = add('https://example.com/b')
  const c = add('https://example.com/c', { status: 'rejected' })
  db.addInterviewEvent({ applicationId: a, scheduledAt: local(hoursAgo(3)), hasTime: true })
  const past = db.getInterviewEvents(a)[0].id
  db.addInterviewEvent({ applicationId: b, scheduledAt: local(new Date(Date.now() + 48 * 3600 * 1000)), hasTime: true })
  db.addInterviewEvent({ applicationId: c, scheduledAt: local(hoursAgo(5)), hasTime: true })
  db.addInterviewEvent({ applicationId: b, scheduledAt: local(hoursAgo(24 * 10)), hasTime: true })

  const due = db.getThankYouDue()
  check('a finished interview wants a thank-you', due.map(e => e.application_id), [a])
  check('the task is in the inbox', hub.taskInbox().filter(t => t.kind === 'thank-you').map(t => t.interviewId), [past])
  const task = hub.taskInbox().find(t => t.kind === 'thank-you')
  check('due the day after the interview', task.due > local(hoursAgo(3)).slice(0, 10), true)
  hub.completeInboxTask(task)
  check('marking it sent clears it', hub.taskInbox().some(t => t.kind === 'thank-you'), false)
  let refused = null
  try { db.completeThankYou(999999) } catch (e) { refused = e.message }
  check('a deleted interview says so', /no longer exists/.test(refused || ''), true)

  // A date-only interview has not "happened" until its day is over.
  const today = new Date()
  const d = add('https://example.com/d')
  db.addInterviewEvent({ applicationId: d, scheduledAt: `${local(today).slice(0, 10)} 00:00:00`, hasTime: false })
  check('a date-only interview today is not yet due', db.getThankYouDue().some(e => e.application_id === d), false)

  // ── Weekly activity ─────────────────────────────────────────────
  const since = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  add('https://example.com/held', { status: 'held' })
  const sent = add('https://example.com/sent', { status: 'applied' })
  db.setNextAction(sent, { date: local(today).slice(0, 10), note: 'Chase' })
  db.completeNextAction(sent)
  db.saveContact({ email: 'sam@example.com', company: 'Example', name: 'Sam' })
  const contact = db.getContacts().find(x => x.email === 'sam@example.com')
  db.completeContactReminder(contact.id)
  const activity = db.getWeeklyActivity(since)
  // a, b, d (interview), c (rejected — it was still sent) and the applied one.
  check('held drafts are not applications sent', activity.applications, 5)
  check('a completed follow-up counts', activity.followUps, 1)
  check('a contact reached out to counts', activity.contacts, 1)
  check('nothing counts from the future', db.getWeeklyActivity('2999-01-01 00:00:00'), { applications: 0, followUps: 0, contacts: 0 })
  const progress = goals.progress({ cfg: { weeklyGoals: { followUps: 1 } } })
  check('goals read the real counts', progress.goals[0].state, 'done')

  // ── Recent descriptions ─────────────────────────────────────────
  db.insertAttentionJob({ job_title: 'Analyst', company: 'Other', platform: 'ATS', job_url: 'https://example.com/att', job_description: 'Python and SQL. '.repeat(20) })
  db.insertApplication({ job_title: 'Short', company: 'Tiny', platform: 'Seek', job_url: 'https://example.com/short', job_description: 'too short', status: 'applied' })
  const recent = db.getRecentJobDescriptions(30)
  check('Needs Attention ads are read too', recent.some(r => r.company === 'Other'), true)
  check('an ad with no real description is not', recent.some(r => r.company === 'Tiny'), false)
  check('one row per advert', recent.length, new Set(recent.map(r => r.description_hash || r.company)).size)

  done()
})()
