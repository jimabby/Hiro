// A smart-schedule batch is a real scan, and must be reported like one.
//
// runBatch never stamped lastScanAt, and the dashboard keyed its "Last scan
// failed" and "blocked" banners on it. For a user on a smart schedule that
// value stayed null forever, the banner's dismissal state also starts at null,
// and `null !== null` is false — so a failing batch was NEVER shown. Batches
// also skipped the OS notification and the phone push a failed scan sends.
//
// And the outcome lived only in memory, so a failure overnight vanished if the
// desktop restarted before anyone looked.

const { stub, service, createChecker } = require('./helpers')

let config = {
  setupComplete: true, pendingScans: [], lastScanAt: null,
  // What a previous run of the desktop left behind.
  lastScanOutcome: { at: '2026-10-01T03:00:00.000Z', ok: false, error: 'AI provider unreachable', blocked: [], source: 'batch' },
}
let nextResult = null
const pushes = []

stub({
  './config': {
    load: () => ({ ...config, scheduledScanTime: '09:00', dailyReportTime: '18:00' }),
    update: (patch) => {
      config = typeof patch === 'function' ? patch(config) : { ...config, ...patch }
      return config
    },
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': { getStats: () => ({ totalToday: 0, attentionCount: 0 }), recordCampaignRun: () => {} },
  './email': {},
  './applicator': {
    isBusy: () => false,
    cancel: () => {},
    run: async () => nextResult,
  },
  './webhooks': { send: async () => {} },
  './cloudSync': { updateScanStatus: async () => {}, sync: async () => {} },
  './push': { notifyScanFailed: async (payload) => { pushes.push(payload) }, runDueChecks: async () => {} },
  './calendarSync': { syncNow: async () => {} },
  './logger': { append: () => {} },
  './askQuestion': { makeAskQuestion: () => () => {} },
  'node-cron': { schedule: () => ({ stop: () => {} }) },
  electron: { Notification: { isSupported: () => false } },
})

const scheduler = service('scheduler.js')
const { check, done } = createChecker()

;(async () => {
  // ── The outcome survives a restart ──────────────────────────────
  const restored = scheduler.getScanInfo()
  check('a saved failure is reported after a restart', restored.lastScanError, 'AI provider unreachable')
  check('with the time it ended', restored.lastScanEndedAt, '2026-10-01T03:00:00.000Z')

  // ── A batch that is blocked ─────────────────────────────────────
  nextResult = { dryRun: false, cancelled: false, found: 4, applied: 0, held: 0,
    blocked: [{ platform: 'LinkedIn', kind: 'captcha', message: 'CAPTCHA' }], paused: [], scoringFailures: 0 }
  await scheduler.runBatch(3)
  const info = scheduler.getScanInfo()
  check('a batch stamps lastScanAt', typeof config.lastScanAt, 'string')
  check('the blocked platform is reported', info.lastScanBlocked.map(b => b.platform), ['LinkedIn'])
  check('the end time moved on, so a dismissed banner reappears', info.lastScanEndedAt !== '2026-10-01T03:00:00.000Z', true)
  check('the outcome is written to config', config.lastScanOutcome.source, 'batch')
  check('the phone is told the batch was blocked', pushes.length, 1)
  check('naming the platform', pushes[0].blocked[0].platform, 'LinkedIn')

  // ── A batch that is cancelled ───────────────────────────────────
  const stamped = config.lastScanAt
  nextResult = { dryRun: false, cancelled: true, found: 1, applied: 0, held: 0, blocked: [], paused: [], scoringFailures: 0 }
  await new Promise(r => setTimeout(r, 5))
  await scheduler.runBatch(3)
  check('a cancelled batch does not claim a sweep', config.lastScanAt, stamped)
  check('and is recorded as cancelled', scheduler.getScanInfo().lastScanCancelled, true)
  check('and pushes nothing', pushes.length, 1)

  // ── A clean batch ───────────────────────────────────────────────
  nextResult = { dryRun: false, cancelled: false, found: 2, applied: 2, held: 0, blocked: [], paused: [], scoringFailures: 0 }
  await scheduler.runBatch(3)
  check('a clean batch clears the failure', scheduler.getScanInfo().lastScanOk, true)
  check('and raises no alarm', pushes.length, 1)

  scheduler.stop()
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
