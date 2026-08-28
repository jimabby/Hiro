// A malformed time in config.json must not take down task scheduling.
//
// Regression: cron expressions were built by string-splitting config values, so
// a value like "9" produced "undefined 9 * * 1-5". cron.schedule throws on
// that, and because startTasks() is called from restart() the throw propagated
// into the config:save IPC handler — leaving the daily report, follow-up and
// inbox tasks stopped until the next relaunch.

const { stub, service, createChecker } = require('./helpers')

const scheduled = []
let cfg = { setupComplete: true, pendingScans: [], scheduledScanTime: '9', dailyReportTime: '18:00' }

stub({
  './config': { load: () => cfg, update: () => cfg, CONFIG_DIR: '/tmp/hiro-test' },
  './database': { getStats: () => ({ totalToday: 0, attentionCount: 0 }) },
  './email': {},
  './applicator': { isBusy: () => false, cancel: () => {}, run: async () => ({}) },
  './webhooks': { send: async () => {} },
  './cloudSync': { updateScanStatus: async () => {}, sync: async () => {} },
  './logger': { append: () => {} },
  './askQuestion': { makeAskQuestion: () => () => {} },
  'node-cron': {
    schedule: (expr) => {
      // node-cron rejects non-numeric fields; mimic that so a bad expression surfaces.
      if (/undefined|NaN/.test(expr)) throw new Error(`invalid cron expression: ${expr}`)
      scheduled.push(expr)
      return { stop: () => {} }
    },
  },
})

const scheduler = service('scheduler.js')
const { check, done } = createChecker()

scheduler.restart(null)
check('bad scan time falls back to 09:00', scheduled.includes('0 9 * * 1-5'), true)
check('daily report still scheduled despite bad scan time', scheduled.includes('0 18 * * 1-5'), true)

scheduled.length = 0
cfg = { ...cfg, scheduledScanTime: 'not-a-time', dailyReportTime: '25:99' }
let threw = null
try { scheduler.restart(null) } catch (e) { threw = e.message }
check('garbage times do not throw', threw, null)
check('core and safety tasks still scheduled', scheduled.length, 4)
check('contact reminders are scheduled daily', scheduled.includes('0 9 * * *'), true)
check('backup recovery drill is scheduled weekly', scheduled.includes('15 4 * * 0'), true)

// ─── The inbox cadence has to divide the day ─────────────────────
//
// cron's `*/N` on the hour field steps from 0 and stops at 23 — it does not
// wrap. `*/5` therefore fires at 00, 05, 10, 15, 20 and then waits FOUR hours
// for the next midnight, not five. Every N that is not a divisor of 24 has a
// short night like that, so the cadence the user set is silently not the
// cadence they get, once a day, forever.
check('a divisor is used as given', scheduler.evenHourInterval(2), 2)
check('another divisor is used as given', scheduler.evenHourInterval(6), 6)
// Ties break downward: checking more often than asked costs an IMAP connection,
// checking less often delays noticing a reply.
check('a tie snaps downward', scheduler.evenHourInterval(5), 4)
check('7 is also a tie, so also snaps down', scheduler.evenHourInterval(7), 6)
check('9 snaps to 8', scheduler.evenHourInterval(9), 8)
check('a missing value takes the default', scheduler.evenHourInterval(undefined), 2)
check('zero is clamped up to one', scheduler.evenHourInterval(0), 2)
check('a negative is clamped to the minimum', scheduler.evenHourInterval(-3), 1)
check('above a day is clamped to a day', scheduler.evenHourInterval(99), 24)
check('garbage takes the default', scheduler.evenHourInterval('nonsense'), 2)

// And the expression it actually builds is a whole-day divisor.
scheduled.length = 0
cfg = { ...cfg, scheduledScanTime: '09:00', dailyReportTime: '18:00', enableInboxCheck: true, inboxCheckHours: 5 }
scheduler.restart(null)
check('the inbox cron uses an even interval', scheduled.includes('0 */4 * * *'), true)
check('and never an uneven one', scheduled.includes('0 */5 * * *'), false)

done()
