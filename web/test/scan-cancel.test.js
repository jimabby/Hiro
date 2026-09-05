// Cancelling a scan must be recorded as a cancellation.
//
// Regression: applicator.run() honours cancel() by RETURNING summary() rather
// than throwing, and that summary carried no cancelled flag. cancelScan() wrote
// {ok: false, 'Cancelled by user'} and announced — then the still-unwinding
// runScan reached its own finally, saw scanError === null, and OVERWROTE the
// outcome with ok: true. It stamped lastScanAt as though a full scan had run,
// fired a second scan-complete event, raised an OS notification saying "Scan
// complete — N applications today", and posted a webhook claiming success.
//
// The user pressed Stop and got two green "Scan complete" toasts.
//
// The control is reachable from the desktop (main.js) and from the phone
// (mobileApi.js), where the README advertises it as a remote Cancel button, and
// it had no coverage at all — it appeared in the test tree only as a stub.

const { stub, service, createChecker, tick } = require('./helpers')

let config = { setupComplete: true, pendingScans: [], lastScanAt: null }
let cancelledFlag = false
let releaseRun = null
const notifications = []
const webhookCalls = []
const syncCalls = []

stub({
  './config': {
    load: () => ({ ...config, scheduledScanTime: '09:00', dailyReportTime: '18:00' }),
    update: (patch) => {
      config = typeof patch === 'function' ? patch(config) : { ...config, ...patch }
      return config
    },
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': { getStats: () => ({ totalToday: 7, attentionCount: 0 }), recordCampaignRun: () => {} },
  './email': {},
  './applicator': {
    isBusy: () => false,
    cancel: () => { cancelledFlag = true },
    // Mirrors the real contract: run() resolves with a summary that carries the
    // cancelled flag, it does not reject.
    run: async () => {
      await new Promise(r => { releaseRun = r })
      return { dryRun: false, cancelled: cancelledFlag, found: 3, applied: 1, held: 2, blocked: [], paused: [], scoringFailures: 0 }
    },
  },
  './webhooks': { send: async (type, payload) => { webhookCalls.push({ type, payload }) } },
  './cloudSync': { updateScanStatus: async () => {}, sync: async () => { syncCalls.push('sync') } },
  './push': { notifyScanFailed: async () => {}, runDueChecks: async () => {} },
  './calendarSync': { syncNow: async () => {} },
  './logger': { append: () => {} },
  './askQuestion': { makeAskQuestion: () => () => {} },
  'node-cron': { schedule: () => ({ stop: () => {} }) },
  electron: { Notification: { isSupported: () => false } },
})

const scheduler = service('scheduler.js')
const { check, done } = createChecker()

// The scheduler pushes renderer events through a BrowserWindow-shaped object.
const fakeWindow = {
  isDestroyed: () => false,
  isFocused: () => false,
  webContents: { send: (channel, data) => notifications.push({ channel, data }) },
}

;(async () => {
  scheduler.restart(fakeWindow)

  // ── A scan the user stops partway ───────────────────────────────────
  const scanPromise = scheduler.runNow(fakeWindow)
  await tick()
  check('scan is running', scheduler.getStatus().running, true)

  scheduler.cancelScan()
  check('applicator was asked to stop', cancelledFlag, true)
  // The spinner clears immediately; the run is still unwinding behind it.
  check('running clears at once', scheduler.getStatus().running, false)

  // cancelScan must NOT announce on its own behalf — the run that is ending
  // owns the message. Two scan-complete events was the visible symptom.
  const duringUnwind = notifications.filter(n => n.data?.type === 'scan-complete').length
  check('cancel does not announce ahead of the run', duringUnwind, 0)

  releaseRun()
  await scanPromise
  await tick(30)

  const scanEvents = notifications.filter(n => n.data?.type === 'scan-complete')
  check('exactly one scan-complete event', scanEvents.length, 1)
  check('the event says it was cancelled', scanEvents[0].data.cancelled, true)
  check('the event carries no error', scanEvents[0].data.error, null)

  const info = scheduler.getScanInfo()
  check('outcome is not ok', info.lastScanOk, false)
  check('outcome is flagged cancelled', info.lastScanCancelled, true)
  check('a cancel is not reported as a fault', info.lastScanError, null)
  // The market was never swept, so claiming it was would let the smart schedule
  // skip the next real run and make the dashboard's "last scan" a lie.
  check('lastScanAt is not stamped by a cancelled run', config.lastScanAt, null)
  check('the abort has its own timestamp', typeof info.lastScanEndedAt, 'string')

  // Nothing is announced to anywhere the user is not looking.
  check('no webhook for a cancelled scan', webhookCalls.length, 0)
  // Bookkeeping still runs: the run may have submitted before it was stopped.
  check('cloud sync still runs', syncCalls.length > 0, true)

  // ── A scan that finishes normally is unaffected ─────────────────────
  cancelledFlag = false
  notifications.length = 0
  webhookCalls.length = 0

  const secondScan = scheduler.runNow(fakeWindow)
  await tick()
  releaseRun()
  await secondScan
  await tick(30)

  const done2 = scheduler.getScanInfo()
  check('a completed scan is ok', done2.lastScanOk, true)
  check('a completed scan is not flagged cancelled', done2.lastScanCancelled, false)
  check('a completed scan stamps lastScanAt', typeof config.lastScanAt, 'string')
  check('a completed scan posts its webhook', webhookCalls.length, 1)
  check('the webhook reports success', webhookCalls[0].payload.ok, true)

  // ── Cancelling does not skip to the next queued scan ────────────────
  // "Cancel scan" means stop scanning. Draining on through the queue would
  // start a fresh scan seconds after the user pressed stop, which looks exactly
  // like the cancel having failed.
  cancelledFlag = false
  config = { ...config, pendingScans: [{ id: 'a', source: 'mobile' }, { id: 'b', source: 'mobile' }] }

  const queued = scheduler.processQueue()
  await tick()
  scheduler.cancelScan()
  releaseRun()
  await queued
  await tick(30)

  const left = config.pendingScans.map(r => r.id)
  check('the cancelled request is consumed, not retried forever', left.includes('a'), false)
  check('the ones behind it stay queued', left, ['b'])
  check('and no second scan was started', scheduler.getStatus().running, false)

  scheduler.stop()
  done()
})()
