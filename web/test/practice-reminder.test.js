// The daily practice reminder (scheduler.runPracticeReminder): sent on the
// desktop and to the phone once a day, only when it is switched on and there is
// something left to practise.

const { stub, service, createChecker } = require('./helpers')

let settings = { enabled: true, time: '19:00' }
let text = 'Keep your 3-day streak: 8 cards waiting, about 5 minutes.'
const claimed = new Set()
const pushes = []

stub({
  './config': { load: () => ({ setupComplete: true, pendingScans: [] }), update: () => ({}), CONFIG_DIR: '/tmp/hiro-test' },
  './database': {
    claimPushKey: (key) => { if (claimed.has(key)) return false; claimed.add(key); return true },
    getStats: () => ({}),
  },
  './push': { send: async (msg) => { pushes.push(msg); return { sent: 1 } } },
  './practice': {
    reminderSettings: () => settings,
    reminderText: () => text,
  },
  './logger': { append: () => {} },
})

const scheduler = service('scheduler')
const { check, done } = createChecker()

;(async () => {
  const now = new Date(2026, 10, 24, 19, 0)
  const first = await scheduler.runPracticeReminder({ now })
  check('the reminder is sent', [first.success, first.sent], [true, true])
  check('the desktop shows it once for the day', claimed.has('practice-desktop:2026-11-24'), true)
  check('the phone is sent the same text', pushes.map(p => [p.kind, p.dedupeKey, p.body]), [['practice', 'practice:2026-11-24', text]])
  check('a tap opens the Practice tab', pushes[0].data, { screen: 'practice' })

  await scheduler.runPracticeReminder({ now })
  check('the desktop does not repeat it the same day', [...claimed].filter(k => k.startsWith('practice-desktop:')).length, 1)

  text = null
  check('nothing to practise means no reminder', (await scheduler.runPracticeReminder({ now: new Date(2026, 10, 25, 19, 0) })).sent, false)

  text = 'Something'
  settings = { enabled: false, time: '19:00' }
  const before = pushes.length
  check('switched off means no reminder', (await scheduler.runPracticeReminder({ now: new Date(2026, 10, 26, 19, 0) })).sent, false)
  check('and nothing is pushed', pushes.length, before)

  done()
})().catch(err => { console.error(err); process.exit(1) })
