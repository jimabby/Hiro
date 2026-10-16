// A scan queued from the phone must survive the desktop being busy.
//
// Regression: runScan reported {ran: true} even when applicator.run() threw
// "already in progress", so processQueue popped and discarded the request. A
// manual apply from Needs Attention holds applicator's busy flag WITHOUT
// setting the scheduler's `running`, so the phone's scan vanished silently.

const { stub, service, createChecker, tick } = require('./helpers')

let pending = []
let cloudScanResults = {}
let applicatorBusy = false
let applicatorRunCalls = 0
let runImpl = async () => ({ dryRun: false, applied: 0 })

stub({
  './config': {
    load: () => ({ setupComplete: true, pendingScans: pending, cloudScanResults, scheduledScanTime: '09:00', dailyReportTime: '18:00' }),
    update: (patch) => {
      const cfg = { setupComplete: true, pendingScans: pending, cloudScanResults }
      const next = typeof patch === 'function' ? patch(cfg) : { ...cfg, ...patch }
      if (next.pendingScans) pending = next.pendingScans
      if (next.cloudScanResults) cloudScanResults = next.cloudScanResults
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

  applicatorBusy = true
  scheduler.requestScan({ source: 'cloud', cloudCommandId: 'u:one' })
  scheduler.requestScan({ source: 'cloud', cloudCommandId: 'u:one' })
  check('cloud delivery is idempotent before execution', pending.length, 1)
  check('durable queue reports accepted', scheduler.cloudCommandStatus('u:one').status, 'accepted')
  applicatorBusy = false
  runImpl = async () => ({ applied: 0 })
  await scheduler.processQueue()
  check('cloud outcome persists after queue removal', scheduler.cloudCommandStatus('u:one').status, 'completed')
  scheduler.requestScan({ source: 'cloud', cloudCommandId: 'u:one' })
  check('redelivery of completed scan never runs again', pending.length, 0)
  const callsBeforeCrash = applicatorRunCalls
  pending = [{ id: 'crashed', cloudCommandId: 'u:crashed' }]
  cloudScanResults['u:crashed'] = { status: 'running', error: '' }
  await scheduler.processQueue()
  check('interrupted scan is not silently repeated', applicatorRunCalls, callsBeforeCrash)
  check('interrupted scan has an actionable failure', scheduler.cloudCommandStatus('u:crashed').status, 'failed')
  pending = [{ id: 'other-account', cloudCommandId: 'other:one', cloudAccount: 'https://other:account' }]
  await scheduler.processQueue()
  check('signed-out or other-account cloud request is held', pending.length, 1)
  check('other-account request is never executed', applicatorRunCalls, callsBeforeCrash)
  done()
})()
