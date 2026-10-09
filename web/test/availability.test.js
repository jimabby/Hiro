// Proposing interview times: free slots found against the calendar, and a reply
// whose times are exactly the ones checked.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-availability-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

const config = { masterResume: 'Jane Doe\njane@x.dev' }
stub({
  './config': { CONFIG_DIR: TMP, load: () => ({ ...config }), update: () => config },
  './logger': { append: () => {} },
})

const db = service('database')
const { findSlots, draftEmail, propose } = service('availability')
const { check, done } = createChecker()

// Monday 6 October 2025, 08:00 local — a fixed week to reason about.
const monday = new Date(2025, 9, 6, 8, 0)
const at = (d, h, m = 0) => new Date(2025, 9, d, h, m)

async function main() {
  // ─── Finding slots ─────────────────────────────────────────────
  const slots = findSlots({ now: monday })
  check('no slot inside the minimum notice', slots.every(s => s.start.getTime() >= monday.getTime() + 18 * 3600000), true)
  check('five slots offered', slots.length, 5)
  check('never more than two a day', Math.max(...Object.values(slots.reduce((a, s) => { const k = s.start.toDateString(); a[k] = (a[k] || 0) + 1; return a }, {}))), 2)
  check('a morning and an afternoon on the first day', slots.slice(0, 2).map(s => s.start.getHours() < 12), [true, false])
  check('nothing on a weekend', slots.some(s => [0, 6].includes(s.start.getDay())), false)
  check('inside working hours', slots.every(s => s.start.getHours() >= 9 && s.end.getHours() * 60 + s.end.getMinutes() <= 17 * 60), true)

  const busy = [{ start: at(7, 8, 0), end: at(7, 12, 0) }]
  const withBusy = findSlots({ now: monday, busy })
  const tuesdayMorning = withBusy.find(s => s.start.getDate() === 7 && s.start.getHours() < 12)
  check('a busy morning is not offered', tuesdayMorning, undefined)
  check('the buffer keeps a gap after a meeting', withBusy.filter(s => s.start.getDate() === 7).every(s => s.start >= at(7, 12, 15)), true)

  const allBusy = findSlots({ now: monday, busy: [{ start: at(6, 0), end: at(20, 0) }] })
  check('a full calendar offers nothing rather than overlap', allBusy.length, 0)

  // ─── The reply ─────────────────────────────────────────────────
  const email = draftEmail({ slots: slots.slice(0, 2), jobTitle: 'Data Engineer', company: 'Acme', contactName: 'Priya Shah', senderName: 'Jane Doe', tz: 'AEDT' })
  check('greets the sender by first name', email.startsWith('Hi Priya,'), true)
  check('names the role', email.includes('Data Engineer role at Acme'), true)
  check('states the time zone', email.includes('(AEDT)'), true)
  check('lists each slot', email.split('\n').filter(l => l.startsWith('- ')).length, 2)
  check('signs off with the name', email.trim().endsWith('Jane Doe'), true)

  // ─── End to end, against Hiro's own interviews and a calendar ───
  await db.init()
  db.insertApplication({ job_title: 'Data Engineer', company: 'Acme', platform: 'Seek', job_url: 'u1', status: 'interview', match_score: 80 })
  db.insertApplication({ job_title: 'Other', company: 'Globex', platform: 'Seek', job_url: 'u2', status: 'interview', match_score: 80 })
  const [acme, globex] = ['Acme', 'Globex'].map(c => db.getApplications().find(a => a.company === c))
  const realNow = new Date(); realNow.setHours(8, 0, 0, 0)
  const tomorrow = new Date(realNow); tomorrow.setDate(tomorrow.getDate() + 1)
  while ([0, 6].includes(tomorrow.getDay())) tomorrow.setDate(tomorrow.getDate() + 1)
  const ymd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  db.addInterviewEvent({ applicationId: globex.id, scheduledAt: `${ymd} 09:00:00`, hasTime: true })
  db.saveRecruiterReply({ applicationId: acme.id, uid: 1, from: '"Priya Shah" <priya@acme.com>', subject: 'Next steps', body: 'When are you free?', classifiedAs: 'interview', receivedAt: new Date().toISOString() })

  const noCal = await propose(acme.id, { now: realNow, cfg: config })
  check('without a calendar it still proposes', noCal.slots.length > 0, true)
  check('…and says the calendar was not checked', noCal.calendarChecked, false)
  // The interview runs 09:00–10:00; with the 15-minute buffer nothing may
  // overlap 08:45–10:15 that day.
  const blockStart = new Date(tomorrow); blockStart.setHours(8, 45, 0, 0)
  const blockEnd = new Date(tomorrow); blockEnd.setHours(10, 15, 0, 0)
  check('Hiro\'s own interview is treated as busy', noCal.slots.some(s => new Date(s.start) < blockEnd && new Date(s.end) > blockStart), false)
  check('the subject replies to their email', noCal.subject, 'Re: Next steps')

  const withCal = await propose(acme.id, { now: realNow, cfg: config, getBusy: async () => [] })
  check('a connected calendar is reported as checked', withCal.calendarChecked, true)
  const failing = await propose(acme.id, { now: realNow, cfg: config, getBusy: async () => { throw new Error('token expired') } })
  check('a calendar error is reported, not thrown', failing.calendarError, 'token expired')
  check('every slot in the email is a slot that was checked', failing.slots.every(s => failing.email.includes(s.label)), true)

  done()
}

main().catch(err => { console.error(err.stack); process.exitCode = 1 })
