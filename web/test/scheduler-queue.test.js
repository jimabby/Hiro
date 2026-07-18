// A scan queued from the phone must survive the desktop being busy.
//
// Regression: runScan reported {ran: true} even when applicator.run() threw
// "already in progress", so processQueue popped and discarded the request. A
// manual apply from Needs Attention holds applicator's busy flag WITHOUT
// setting the scheduler's `running`, so the phone's scan vanished silently.

const { stub, service, createChecker, tick } = require('./helpers')

let pending = []
let applicatorBusy = false
let applicatorRunCalls = 0
let runImpl = async () => ({ dryRun: false, applied: 0 })

stub({
  './config': {
    load: () => ({ setupComplete: true, pendingScans: pending, scheduledScanTime: '09:00', dailyReportTime: '18:00' }),
    update: (patch) => {
      const cfg = { setupComplete: true, pendingScans: pending }
      const next = typeof patch === 'function' ? patch(cfg) : { ...cfg, ...patch }
      if (next.pendingScans) pending = next.pendingScans
      return next
    },
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': { getStats: () => ({ totalToday: 0, attentionCount: 0 }) },
  './email': {},
  './applicator': {
    isBusy: () => applicatorBusy,
    cancel: () => {},
    run: async () => {
      applicatorRunCalls++
      if (applicatorBusy) throw new Error('Another scan or apply is already in progress')
      return runImpl()
    },
  },
  './webhooks': { send: async () => {} },
  './cloudSync': { updateScanStatus: async () => {}, sync: async () => {} },
  './logger': { append: () => {} },
  './askQuestion': { makeAskQuestion: () => () => {} },
  'node-cron': { schedule: () => ({ stop: () => {} }) },
})

const scheduler = service('scheduler.js')
const { check, done } = createChecker()

;(async () => {
  // A manual apply is in progress when the phone queues a scan.
  applicatorBusy = true
  scheduler.requestScan({ keywords: 'react', source: 'mobile' })
  await tick()

  check('request stays queued while applicator busy', pending.length, 1)
  check('applicator.run not invoked while busy', applicatorRunCalls, 0)

  // The manual apply finishes and the queue drains.
  applicatorBusy = false
  await scheduler.processQueue()
  await tick()

  check('request consumed once applicator free', pending.length, 0)
  check('applicator.run invoked exactly once', applicatorRunCalls, 1)

  // A scan that blows up reports the failure instead of looking successful.
  runImpl = async () => { throw new Error('scrape exploded') }
  scheduler.requestScan({ source: 'mobile' })
  await tick(30)

  const info = scheduler.getScanInfo()
  check('failed scan surfaces error', info.lastScanError, 'scrape exploded')
  check('failed scan marked not-ok', info.lastScanOk, false)
  check('failed request not retried forever', pending.length, 0)

  done()
})()
