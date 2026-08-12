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

done()
