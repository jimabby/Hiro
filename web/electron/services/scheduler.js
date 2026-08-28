const cron = require('node-cron')
const configService = require('./config')
const database = require('./database')
const emailService = require('./email')
const applicator = require('./applicator')
const webhooks = require('./webhooks')
const cloudSync = require('./cloudSync')
const push = require('./push')
const calendarSync = require('./calendarSync')
const logger = require('./logger')

let scanTask = null
let reportTask = null
let followUpTask = null
let inboxTask = null
let weeklyReportTask = null
let staleTask = null
let calendarTask = null
let pushTask = null
let contactTask = null
let backupDrillTask = null
let campaignTasks = []
let batchTimeouts = []
let running = false
let win = null
let batchSchedule = [] // today's planned batch times for UI
// Outcome of the most recent real scan, so the dashboard and the phone can tell
// a failed scan from one that simply found nothing. Without this, runScan's
// catch swallowed the error and lastScanAt was stamped either way.
let lastScanOutcome = null // { at, ok, error, source, blocked[] }
// Score distribution from the most recent test scan, kept in memory so the
// Analytics page can recommend a match threshold from real scored jobs.
let lastDryRun = null // { at, scores[], wouldApply, threshold }

function init(mainWindow) {
  win = mainWindow
  startTasks()
  // Catch up on the overnight sweep if the desktop wasn't running at 3:30am.
  runStaleSweep()
  runContactReminders()
  // Opening and integrity-checking seven databases can take noticeable time on
  // a large history. Let the window finish starting before doing that I/O.
  setImmediate(() => { runBackupDrillIfDue() })
  // Drain any scans queued (e.g. from the mobile app) while the desktop was off.
  drainQueue()
}

// Parse a stored "HH:MM" setting, falling back to the default when it's missing
// or malformed. A bad value (e.g. "9") would otherwise build a cron expression
// like "undefined 9 * * 1-5"; cron.schedule throws on that, and because
// startTasks is called from restart() the throw propagated into the
// config:save IPC handler — leaving EVERY scheduled task (report, follow-up,
// inbox) stopped until the next relaunch.
function parseTime(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (match) {
    const h = Number(match[1])
    const m = Number(match[2])
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return [h, m]
  }
  if (value) log(`Invalid time "${value}" in settings — falling back to ${fallback}.`)
  return fallback.split(':').map(Number)
}

// Snap an "every N hours" setting to an interval that actually divides the day.
//
// cron's `*/N` on the hour field steps from 0 and then stops at 23 — it does not
// wrap. So `*/5` fires at 00, 05, 10, 15, 20 and then waits four hours, not five,
// for the next midnight. Every N that isn't a divisor of 24 has a short night
// like that, which for the inbox check means the cadence the user chose is not
// the cadence they get, silently, once a day.
//
// Rounding to the nearest divisor keeps the promise the setting makes: an even
// spacing at approximately the requested interval.
//
// Ties break DOWNWARD — 5 becomes 4, not 6 — because the two directions are not
// equally wrong here. Checking the inbox more often than asked costs one extra
// IMAP connection; checking less often delays noticing that a recruiter replied.
const EVEN_HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24]

function evenHourInterval(value) {
  const requested = Math.min(24, Math.max(1, Number(value) || 2))
  if (EVEN_HOUR_INTERVALS.includes(requested)) return requested
  // Strict `<` keeps the earlier (smaller) candidate on a tie.
  const snapped = EVEN_HOUR_INTERVALS.reduce((best, n) =>
    Math.abs(n - requested) < Math.abs(best - requested) ? n : best)
  log(`Inbox check: every ${requested} hours does not divide evenly into a day `
    + `(cron would leave a short gap at midnight) — using every ${snapped} hours instead.`)
  return snapped
}

function startTasks() {
  const cfg = configService.load()
  if (!cfg.setupComplete) return

  for (const campaign of Array.isArray(cfg.campaigns) ? cfg.campaigns : []) {
    if (!campaign.enabled) continue
    try {
      const [h, m] = parseTime(campaign.scheduleTime, '09:00')
      campaignTasks.push(cron.schedule(`${m} ${h} * * 1-5`, () => requestScan({
        ...campaign,
        campaignId: campaign.id, source: `campaign:${campaign.name}`,
      })))
    } catch (err) {
      log(`Could not schedule campaign "${campaign.name}": ${err.message}`)
    }
  }

  // One bad task must not prevent the others from being scheduled.
  try {
    if (cfg.enableSmartScheduling) {
      // Smart scheduling: spread applications in batches across the day
      setupSmartSchedule(cfg)
    } else {
      // Standard: scan once daily at configured time Mon–Fri
      const [h, m] = parseTime(cfg.scheduledScanTime, '09:00')
      scanTask = cron.schedule(`${m} ${h} * * 1-5`, async () => { await runScan() })
    }
  } catch (err) {
    log(`Could not schedule the daily scan: ${err.message}`)
  }

  // Daily report at the configured time (default 6pm), Mon–Fri
  try {
    const [rh, rm] = parseTime(cfg.dailyReportTime, '18:00')
    reportTask = cron.schedule(`${rm} ${rh} * * 1-5`, async () => {
      await runDailyReport()
    })
  } catch (err) {
    log(`Could not schedule the daily report: ${err.message}`)
  }

  if (cfg.enableFollowUp && cfg.followUpDays > 0) {
    followUpTask = cron.schedule('0 10 * * 1-5', async () => { await runFollowUp() })
  }

  if (cfg.enableInboxCheck) {
    try {
      // Recruiter replies don't respect business hours — default to every day.
      const days = cfg.inboxCheckWeekdaysOnly ? '1-5' : '*'
      const every = evenHourInterval(cfg.inboxCheckHours)
      inboxTask = cron.schedule(`0 */${every} * * ${days}`, async () => { await runInboxCheck() })
    } catch (err) {
      log(`Could not schedule the inbox check: ${err.message}`)
    }
  }

  // Retire applications that never got a reply. Daily, early, so the dashboard
  // is already accurate by the time anyone looks at it.
  if (Number(cfg.staleAfterDays) > 0) {
    try {
      staleTask = cron.schedule('30 3 * * *', () => { runStaleSweep() })
    } catch (err) {
      log(`Could not schedule the stale-application sweep: ${err.message}`)
    }
  }

  if (cfg.enableWeeklyReport) {
    // Monday at 9am
    weeklyReportTask = cron.schedule('0 9 * * 1', async () => { await runWeeklyReport() })
  }

  // Two-way calendar sync. Every 15 minutes rather than on every change: the
  // incoming half is a poll, and an interview moved in Google Calendar is not
  // urgent to the minute — but it must not wait for the next scan either, or a
  // reschedule made at 9pm would be invisible until the following morning.
  if (cfg.calendarSyncEnabled && cfg.calendarProvider) {
    try {
      calendarTask = cron.schedule('*/15 * * * *', () => { calendarSync.syncNow().catch(() => {}) })
    } catch (err) {
      log(`Could not schedule calendar sync: ${err.message}`)
    }
  }

  // Clock-driven push notifications. cloudSync's own loop already runs these
  // every couple of minutes, but only while cloud sync is actively syncing —
  // this makes interview reminders independent of that.
  if (cfg.pushEnabled) {
    try {
      pushTask = cron.schedule('*/10 * * * *', () => { push.runDueChecks().catch(() => {}) })
    } catch (err) {
      log(`Could not schedule notification checks: ${err.message}`)
    }
  }

  if (cfg.enableContactReminders !== false) {
    try {
      contactTask = cron.schedule('0 9 * * *', () => { runContactReminders() })
    } catch (err) {
      log(`Could not schedule contact reminders: ${err.message}`)
    }
  }

  if (cfg.enableBackupDrills !== false) {
    try {
      backupDrillTask = cron.schedule('15 4 * * 0', () => { runBackupDrill() })
    } catch (err) {
      log(`Could not schedule backup recovery drill: ${err.message}`)
    }
  }
}

function setupSmartSchedule(cfg) {
  const batchSize = cfg.smartScheduleBatchSize || 3
  const jitter = cfg.smartScheduleJitter || 15
  const [startH, startM] = parseTime(cfg.smartScheduleStartTime, '09:00')
  const [endH, endM] = parseTime(cfg.smartScheduleEndTime, '17:00')

  // Calculate total daily limit across all platforms
  let totalLimit = 0
  if (cfg.enableSeek) totalLimit += cfg.dailyLimitSeek || 10
  if (cfg.enableIndeed) totalLimit += cfg.dailyLimitIndeed || 10
  if (cfg.enableLinkedIn) totalLimit += cfg.dailyLimitLinkedIn || 10
  const numBatches = Math.ceil(totalLimit / batchSize)

  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM
  const totalMinutes = endMinutes - startMinutes
  if (totalMinutes <= 0 || numBatches <= 0) return

  // The window cannot hold more batches than it has minutes. Past that point
  // `interval` floors to 0, every batch is planned for the same moment, and
  // because runBatch() refuses to start while another is running, all but the
  // first are silently dropped — a daily limit of 600 at a batch size of 1
  // produced 600 timers on 15 distinct times, all inside the first quarter
  // hour, and applied almost nothing.
  //
  // The daily limit is the volume the user asked for and the window is the
  // constraint they set, so neither is discarded: fewer, larger batches carry
  // the same total across the same span.
  const plannedBatches = Math.max(1, Math.min(numBatches, totalMinutes))
  const perBatch = plannedBatches === numBatches
    ? batchSize
    : Math.ceil(totalLimit / plannedBatches)
  if (plannedBatches !== numBatches) {
    log(`Smart schedule: ${numBatches} batches of ${batchSize} will not fit between `
      + `${cfg.smartScheduleStartTime || '09:00'} and ${cfg.smartScheduleEndTime || '17:00'}; `
      + `using ${plannedBatches} batches of ${perBatch} instead`)
  }

  const interval = Math.floor(totalMinutes / plannedBatches)

  // Jitter has to stay smaller than the gap it is perturbing. At ±15 minutes on
  // a 1-minute interval, batches overtake each other and pile onto the same
  // minute, which is the same collapse by another route. Half the interval is
  // the most that keeps every batch inside its own slot; the default 48-minute
  // interval is unaffected by this.
  const effectiveJitter = Math.max(0, Math.min(jitter, Math.floor(interval / 2)))

  // Schedule a daily cron at start time to set up today's batches
  scanTask = cron.schedule(`${startM} ${startH} * * 1-5`, () => {
    scheduleTodayBatches(plannedBatches, interval, startMinutes, effectiveJitter, perBatch, endMinutes)
  })

  // Also schedule for today if we haven't passed start time
  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  if (nowMinutes < endMinutes && now.getDay() >= 1 && now.getDay() <= 5) {
    scheduleTodayBatches(plannedBatches, interval, startMinutes, effectiveJitter, perBatch, endMinutes)
  }
}

function scheduleTodayBatches(numBatches, interval, startMinutes, jitter, batchSize, endMinutes) {
  // Clear existing batch timeouts
  for (const t of batchTimeouts) clearTimeout(t)
  batchTimeouts = []
  batchSchedule = []

  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  for (let i = 0; i < numBatches; i++) {
    const baseMinutes = startMinutes + i * interval
    const jitterOffset = jitter > 0 ? Math.floor(Math.random() * jitter * 2) - jitter : 0
    // Clamped at BOTH ends. Only the lower bound was enforced, so jitter on the
    // last batch pushed it past the finish time the user configured — a
    // 09:00–09:30 window scheduled its final batch at 09:41.
    let scheduledMinutes = Math.max(startMinutes, baseMinutes + jitterOffset)
    if (endMinutes != null) scheduledMinutes = Math.min(endMinutes, scheduledMinutes)

    if (scheduledMinutes <= nowMinutes) continue // skip batches in the past

    const delayMs = (scheduledMinutes - nowMinutes) * 60 * 1000
    const h = Math.floor(scheduledMinutes / 60)
    const m = scheduledMinutes % 60
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    batchSchedule.push(timeStr)

    const timeout = setTimeout(async () => {
      await runBatch(batchSize)
    }, delayMs)
    batchTimeouts.push(timeout)
  }

  // Jitter can reorder adjacent batches, so the planned times are not
  // necessarily generated in order — and a schedule printed out of sequence
  // reads as a bug in the scheduler rather than as jitter doing its job.
  batchSchedule.sort()

  if (batchSchedule.length > 0) {
    // The full list is unreadable once there are dozens of them, and the log is
    // size-capped — say how many and where they run, then the first few.
    const preview = batchSchedule.length > 12
      ? `${batchSchedule.slice(0, 12).join(', ')}, …`
      : batchSchedule.join(', ')
    log(`Smart schedule: ${batchSchedule.length} batches of ${batchSize} planned `
      + `between ${batchSchedule[0]} and ${batchSchedule[batchSchedule.length - 1]} — ${preview}`)
  }
}

const { makeAskQuestion } = require('./askQuestion')

async function runBatch(batchSize) {
  // Same busy window as runScan — a manual apply holds applicator's flag
  // without setting `running`.
  if (running || applicator.isBusy()) return
  // Checked BEFORE the try: inside it, the early return still fell through to
  // the finally, which fired the scan-complete webhook, a desktop notification
  // and a cloud sync for a batch that never ran.
  const cfg = configService.load()
  if (!cfg.setupComplete) {
    log('Setup not complete. Skipping batch.')
    return
  }

  running = true
  let batchError = null
  let batchBlocked = []
  let batchPaused = []
  // Held drafts and scoring failures happen in a batch exactly as they do in a
  // full scan, but runBatch never recorded them — so on a smart schedule the
  // dashboard and the phone reported "batch complete" for a run whose entire
  // output was drafts waiting for approval, or one that scored nothing at all
  // because the AI was down.
  let batchHeld = 0
  let batchScoringFailures = 0
  log(`Starting batch (${batchSize} apps max)...`)
  cloudSync.updateScanStatus(true).catch(() => {})

  try {
    const result = await applicator.run({ ...cfg, askQuestion: makeAskQuestion(win), batchLimit: batchSize }, { log, notifyAttention })
    if (result?.blocked?.length) batchBlocked = result.blocked
    if (result?.paused?.length) batchPaused = result.paused
    batchHeld = result?.held || 0
    batchScoringFailures = result?.scoringFailures || 0
    if (result?.budgetStopped) batchError = 'AI monthly budget reached — batch stopped early'
  } catch (err) {
    batchError = describeError(err)
    log(`Batch error: ${batchError}`)
  } finally {
    running = false
    lastScanOutcome = {
      at: new Date().toISOString(),
      ok: !batchError,
      error: batchError,
      blocked: batchBlocked,
      paused: batchPaused,
      held: batchHeld,
      scoringFailures: batchScoringFailures,
      source: 'batch',
    }
    cloudSync.updateScanStatus(false).catch(() => {})
    log(batchError ? `Batch failed: ${batchError}` : 'Batch complete.')
    notify({ type: 'scan-complete', error: batchError, blocked: batchBlocked, paused: batchPaused, held: batchHeld, scoringFailures: batchScoringFailures })
    webhooks.send('scan-complete', {
      message: batchError
        ? `Batch failed: ${batchError}`
        : (batchBlocked.length ? `Batch complete, but blocked on: ${batchBlocked.map(b => b.platform).join(', ')}` : `Batch of ${batchSize} complete`),
      ok: !batchError,
      blocked: batchBlocked,
      paused: batchPaused,
    }).catch(() => {})
    cloudSync.sync().catch(() => {})
    setImmediate(drainQueue)
  }
}

// Tear down the cron tasks. `abortRun` also cancels an in-flight scan and
// clears the running flag — correct on app shutdown, but NOT on restart():
// restart() runs on every Settings save, so cancelling there meant editing any
// unrelated setting silently killed a scan mid-submission and left getScanInfo
// reporting idle while the applicator was still unwinding.
// node-cron 4 keeps every scheduled task in a module-level registry, and
// stop() only pauses it — the entry stays. restart() runs on every Settings
// save, so stopping without destroying leaked one task per save for the life
// of the process. destroy() deregisters it; stop() is the fallback for the
// older API.
function disposeTask(task) {
  if (!task) return null
  try {
    if (typeof task.destroy === 'function') task.destroy()
    else task.stop()
  } catch { /* already torn down */ }
  return null
}

function stop({ abortRun = true } = {}) {
  scanTask = disposeTask(scanTask)
  reportTask = disposeTask(reportTask)
  followUpTask = disposeTask(followUpTask)
  inboxTask = disposeTask(inboxTask)
  weeklyReportTask = disposeTask(weeklyReportTask)
  staleTask = disposeTask(staleTask)
  calendarTask = disposeTask(calendarTask)
  pushTask = disposeTask(pushTask)
  contactTask = disposeTask(contactTask)
  backupDrillTask = disposeTask(backupDrillTask)
  campaignTasks.forEach(disposeTask)
  campaignTasks = []
  for (const t of batchTimeouts) clearTimeout(t)
  batchTimeouts = []
  batchSchedule = []
  if (abortRun) {
    applicator.cancel()
    running = false
  }
}

function cancelScan() {
  if (!running) return // nothing to cancel (e.g. the phone raced a finished scan)
  applicator.cancel()
  running = false
  lastScanOutcome = { at: new Date().toISOString(), ok: false, error: 'Cancelled by user', source: 'cancel' }
  log('Scan cancelled by user.')
  notify({ type: 'scan-complete' })
  cloudSync.updateScanStatus(false).catch(() => {})
}

// Re-read the schedule after a settings change. Deliberately leaves a running
// scan alone: the user changed a preference, they didn't ask to abort the work
// in progress. Smart-schedule batches for today are rebuilt by startTasks().
function restart(mainWindow) {
  win = mainWindow
  stop({ abortRun: false })
  startTasks()
  // Settings may have just completed setup — drain any scans queued before it.
  drainQueue()
}

async function runNow(mainWindow) {
  win = mainWindow
  await runScan()
}

// Test scan: scores and tailors every found job but never submits or writes to
// the database. Useful for tuning the match threshold safely.
async function runDryRun(mainWindow) {
  win = mainWindow
  await runScan({ dryRun: true })
}

// Queue a scan request (e.g. from the mobile companion app). The request is
// persisted to config so it survives a desktop restart, then run as soon as the
// desktop is idle. `opts` may carry { keywords, location } to override the
// saved search for this run, and `source` for logging.
function requestScan(opts = {}) {
  const requestedSalary = Number(opts.salaryMin)
  const req = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    keywords: (opts.keywords || '').trim(),
    location: (opts.location || '').trim(),
    source: opts.source || 'desktop',
    campaignId: opts.campaignId || null,
    salaryMin: Number.isFinite(requestedSalary) ? Math.min(10000000, Math.max(0, requestedSalary)) : 0,
    resumeId: opts.resumeId || '',
    reviewBeforeSubmit: opts.reviewBeforeSubmit !== false,
  }
  configService.update(c => ({ ...c, pendingScans: [...(Array.isArray(c.pendingScans) ? c.pendingScans : []), req] }))
  log(`Scan request queued from ${req.source}${req.keywords ? ` (keywords: ${req.keywords})` : ''}`)
  drainQueue()
  return req
}

// Every caller of processQueue is fire-and-forget — a cron tick, a finished
// scan, a phone request. An unhandled rejection from any of them terminates the
// Electron main process, so the queue must never reject at its callers.
function drainQueue() {
  processQueue().catch(err => log(`Scan queue error: ${describeError(err)}`))
}

// Run queued scan requests one at a time until the queue is empty.
async function processQueue() {
  // Bail early while a manual apply holds the applicator — runScan would
  // refuse anyway, and the request stays queued for when it's free.
  if (running || applicator.isBusy()) return
  const cfg = configService.load()
  const pending = Array.isArray(cfg.pendingScans) ? cfg.pendingScans : []
  if (pending.length === 0) return

  const req = pending[0]
  const result = await runScan({ ...req, fromQueue: true })

  // Only pop the request if the scan actually ran. If the desktop was busy or
  // setup isn't complete yet, the request stays queued and is retried after
  // the current scan finishes / setup completes (previously it was discarded).
  if (!result?.ran) return

  // A failure to write config here (disk full, permissions) must not leave the
  // request at the head of the queue to be re-run forever, nor propagate out of
  // a fire-and-forget caller. Report it and stop draining; the next tick
  // retries.
  let after
  try {
    after = configService.update(c => ({
      ...c,
      pendingScans: (c.pendingScans || []).filter(r => r.id !== req.id),
    }))
  } catch (err) {
    log(`Could not clear the finished scan request from the queue: ${describeError(err)}`)
    return
  }
  if ((after.pendingScans || []).length > 0) await processQueue()
}

async function runScan(overrides = {}) {
  // `running` alone is not enough: a manual apply from Needs Attention holds
  // applicator's own busy flag without ever setting `running`, and cancelScan
  // clears `running` while the applicator is still unwinding mid-submission.
  // In both windows applicator.run() would throw "already in progress" — and
  // because that throw was reported as a completed scan, processQueue popped
  // and discarded the phone's queued request.
  if (running || applicator.isBusy()) return { ran: false, reason: 'busy' }
  const cfg = configService.load()
  if (!cfg.setupComplete) {
    log('Setup not complete. Skipping scan.')
    return { ran: false, reason: 'setup' }
  }
  running = true
  const dryRun = !!overrides.dryRun
  let scanError = null
  let scanBlocked = []
  // Platforms automation health paused. Reported, but never through the failure
  // channel — see the note on `paused` in applicator.js.
  let scanPaused = []
  // Surfaced on the dashboard and the phone: a scan that drafted ten
  // applications for review, or that couldn't score anything because the AI
  // was down, must not look like a scan that simply found nothing.
  let scanHeld = 0
  let scanScoringFailures = 0
  let runResult = null
  const campaignStartedAt = new Date().toISOString()
  log(dryRun ? 'Starting test scan (dry run — nothing will be submitted)...' : 'Starting job scan...')
  cloudSync.updateScanStatus(true).catch(() => {})

  try {
    const runCfg = { ...cfg, askQuestion: makeAskQuestion(win) }
    if (overrides.keywords) runCfg.jobKeywords = overrides.keywords
    if (overrides.location) runCfg.jobLocation = overrides.location
    if (overrides.salaryMin) runCfg.salaryMin = overrides.salaryMin
    if (overrides.resumeId) runCfg.defaultResumeId = overrides.resumeId
    if (overrides.campaignId) {
      runCfg.reviewBeforeSubmit = overrides.reviewBeforeSubmit !== false
      runCfg.campaignId = overrides.campaignId
      runCfg.campaignName = String(overrides.source || '').replace(/^campaign:/, '') || 'Campaign'
    }
    if (dryRun) runCfg.dryRun = true
    const result = await applicator.run(runCfg, { log, notifyAttention })
    runResult = result
    if (result?.blocked?.length) scanBlocked = result.blocked
    if (result?.paused?.length) scanPaused = result.paused
    scanHeld = result?.held || 0
    scanScoringFailures = result?.scoringFailures || 0
    // A scan that stopped on the budget cap is not a success, but it isn't a
    // crash either — say which it was rather than reporting "Scan complete".
    if (result?.budgetStopped) scanError = 'AI monthly budget reached — scan stopped early'
    if (dryRun && result) lastDryRun = { at: new Date().toISOString(), ...result }
  } catch (err) {
    // NOT err.message. sql.js throws bare strings, so a database refusal
    // ("Wrong API use : tried to bind a value of an unknown type") arrived here
    // as `undefined` — which is how a bug that silently dropped every ATS-board
    // match managed to report itself as "Scan error: undefined" for months.
    scanError = describeError(err)
    log(`Scan error: ${scanError}`)
  } finally {
    running = false
    cloudSync.updateScanStatus(false).catch(() => {})
    // A dry run changes nothing — don't touch lastScanAt, sync, or the queue.
    if (!dryRun) {
      try {
        configService.update({ lastScanAt: new Date().toISOString() })
      } catch {}
      // Record how the scan actually ended, so a failure is distinguishable
      // from a scan that simply found nothing (previously both looked alike).
      lastScanOutcome = {
        at: new Date().toISOString(),
        ok: !scanError,
        error: scanError,
        blocked: scanBlocked,
        paused: scanPaused,
        held: scanHeld,
        scoringFailures: scanScoringFailures,
        source: overrides.fromQueue ? 'queue' : (overrides.source || 'desktop'),
      }
      if (overrides.campaignId) {
        try {
          database.recordCampaignRun({
            campaignId: overrides.campaignId,
            campaignName: String(overrides.source || '').replace(/^campaign:/, ''),
            startedAt: campaignStartedAt, found: runResult?.found,
            applied: runResult?.applied, held: runResult?.held,
            scoringFailures: runResult?.scoringFailures,
            ok: !scanError, error: scanError,
          })
        } catch (err) { log(`Could not record campaign analytics: ${describeError(err)}`) }
      }
    }
    log(dryRun ? 'Test scan complete (dry run — nothing was submitted).' : 'Scan complete.')
    notify({ type: 'scan-complete', error: scanError, blocked: scanBlocked, paused: scanPaused, held: scanHeld, scoringFailures: scanScoringFailures })
    if (!dryRun) {
      try {
        const s = database.getStats()
        // A block is the one outcome the user has to act on, so it takes
        // priority over the routine "N applications today" summary.
        const blockNote = scanBlocked.length
          ? `Blocked on ${scanBlocked.map(b => b.platform).join(', ')}`
          : null
        // A paused platform is worth mentioning but never worth alarming about:
        // it rides along on the ordinary summary rather than changing the title.
        const pauseNote = scanPaused.length
          ? ` · ${scanPaused.map(p => p.platform).join(', ')} paused by automation health`
          : ''
        nativeNotify(
          scanError ? 'Scan failed' : (blockNote ? 'Scan partially blocked' : 'Scan complete'),
          scanError || blockNote
            || `${s.totalToday} application${s.totalToday === 1 ? '' : 's'} today · ${s.attentionCount} need${s.attentionCount === 1 ? 's' : ''} attention${pauseNote}`
        )
      } catch { /* stats are decorative here */ }
      webhooks.send('scan-complete', {
        message: scanError
          ? `Scan failed: ${scanError}`
          : (scanBlocked.length ? `Scan complete, but blocked on: ${scanBlocked.map(b => b.platform).join(', ')}` : 'Full scan complete'),
        ok: !scanError,
        blocked: scanBlocked,
        paused: scanPaused,
      }).catch(() => {})
      // A scan that failed or was blocked is the one scan outcome the user has
      // to act on, and the one they will not notice from a minimised window.
      if (scanError || scanBlocked.length) {
        push.notifyScanFailed({ error: scanError, blocked: scanBlocked }).catch(() => {})
      }
      // A scan can create interviews (an inbox-detected time) and definitely
      // creates review-queue work; push both to the calendar and the phone now
      // rather than waiting up to two minutes for the sync timer.
      calendarSync.syncNow().catch(() => {})
      cloudSync.sync().catch(() => {})
      // Drain scans queued (e.g. from the phone) while this scan was running.
      // Queue-initiated runs skip this: processQueue continues itself after
      // removing the finished request, and re-entering here would run it twice.
      if (!overrides.fromQueue) setImmediate(drainQueue)
    }
  }
  // `ran` means the scan flow executed, error or not — a failed scan must not
  // be retried forever by the queue. The error travels alongside it.
  return { ran: true, ok: !scanError, error: scanError }
}

function getScanInfo() {
  const cfg = configService.load()
  return {
    running,
    // A manual apply blocks scans just as a running scan does; the phone needs
    // to know that so a queued request isn't reported as inexplicably stalled.
    busy: running || applicator.isBusy(),
    queued: (cfg.pendingScans || []).length,
    lastScanAt: cfg.lastScanAt || null,
    lastScanOk: lastScanOutcome ? lastScanOutcome.ok : null,
    lastScanError: lastScanOutcome?.error || null,
    // Platforms that refused to serve results on the last scan. Non-empty here
    // means missing results, not absent results.
    lastScanBlocked: lastScanOutcome?.blocked || [],
    // Platforms Hiro paused itself. Also missing results, but by choice — the UI
    // presents these as information rather than as something to act on.
    lastScanPaused: lastScanOutcome?.paused || [],
    batchSchedule,
  }
}

// Summary of the most recent test scan, used to recommend a match threshold.
function getLastDryRun() {
  return lastDryRun
}

async function runDailyReport() {
  try {
    const stats = database.getStats()
    await emailService.sendDailyReport(stats)
    log('Daily report sent.')
  } catch (err) {
    log(`Daily report error: ${err.message}`)
  }
}

async function runWeeklyReport() {
  try {
    const reportData = database.getWeeklyReportData()
    webhooks.send('weekly-report', reportData).catch(() => {})
    log('Weekly report sent.')
  } catch (err) {
    log(`Weekly report error: ${err.message}`)
  }
}

// One try per job, not one for the whole loop: a single AI or SMTP failure
// used to abort the run, so every remaining application that day was skipped
// silently and only one error appeared in the log.
async function runFollowUp() {
  let cfg
  try {
    cfg = configService.load()
    if (!cfg.enableFollowUp || !cfg.gmailAddress) return
  } catch (err) {
    log(`Follow-up error: ${err.message}`)
    return
  }

  const aiAdapter = require('./ai/index')
  let jobs = []
  try {
    jobs = database.getApplicationsForFollowUp(cfg.followUpDays || 7)
  } catch (err) {
    log(`Follow-up error: could not load applications — ${err.message}`)
    return
  }

  let sent = 0
  let drafted = 0
  let noAddress = 0
  let failed = 0
  for (const job of jobs) {
    // The address may have arrived since the application was saved — from the
    // ad itself, or from a recruiter reply the inbox check has since read.
    const recipient = job.recruiter_email || recruiterEmailFor(job, cfg)
    if (!recipient) {
      noAddress++
      continue
    }
    try {
      const activeResume = (cfg.resumes || []).find(r => r.id === (job.resume_id || cfg.defaultResumeId))?.text
        || cfg.masterResume || ''
      const emailText = await aiAdapter.generateFollowUpEmail(
        cfg.aiProvider, cfg.aiApiKey, job.job_title, job.company, activeResume, cfg.geminiModel
      )
      if (cfg.reviewFollowUpEmails) {
        database.saveFollowUpDraft({
          applicationId: job.id,
          recipient,
          subject: `Follow-up: ${job.job_title} at ${job.company}`,
          body: emailText,
        })
        drafted++
        log(`Follow-up drafted for review: ${job.job_title} at ${job.company}`)
        continue
      }
      await emailService.sendFollowUpEmail({ ...job, recruiter_email: recipient }, emailText, cfg)
      database.markFollowUpSent(job.id)
      sent++
      log(`Follow-up sent for ${job.job_title} at ${job.company}`)
    } catch (err) {
      failed++
      log(`Follow-up failed for ${job.job_title} at ${job.company}: ${err.message}`)
    }
  }

  if (jobs.length > 0) {
    const parts = [`${sent} sent`]
    if (drafted) parts.push(`${drafted} waiting for review`)
    if (failed) parts.push(`${failed} failed`)
    if (noAddress) parts.push(`${noAddress} had no recruiter address`)
    log(`Follow-up pass complete: ${parts.join(', ')}.`)
  }
}

// Last-chance address lookup for a job whose recruiter_email is still blank:
// re-read the stored job description. The scan already tries this at apply
// time, but applications saved before extraction existed have never been
// through it, and the description is right there on the row.
function recruiterEmailFor(job, cfg) {
  if (!cfg.extractRecruiterEmail) return ''
  try {
    const { extractRecruiterEmail } = require('./contactExtractor')
    const found = extractRecruiterEmail(job.job_description || '', { company: job.company })
    if (found) {
      database.updateRecruiterEmail(job.id, found)
      log(`Found a contact address for ${job.company} in the job ad: ${found}`)
    }
    return found || ''
  } catch {
    return ''
  }
}

// Move applications that never got a reply to 'no_response'. Also runs once on
// launch (via init) so a desktop that's only open during the day still catches up.
function runStaleSweep() {
  try {
    const cfg = configService.load()
    const days = Number(cfg.staleAfterDays)
    if (!Number.isFinite(days) || days <= 0) return { updated: 0 }
    const result = database.markStaleApplications(days)
    if (result.updated > 0) {
      log(`Marked ${result.updated} application${result.updated === 1 ? '' : 's'} as No Response (no reply after ${days} days)`)
      cloudSync.sync().catch(() => {})
    }
    return result
  } catch (err) {
    log(`Stale sweep error: ${err.message}`)
    return { updated: 0 }
  }
}

async function runInboxCheck() {
  try {
    const cfg = configService.load()
    if (!cfg.enableInboxCheck || !cfg.gmailAddress || !cfg.gmailAppPassword) return
    const inbox = require('./inbox')
    log('Checking inbox for replies...')
    const result = await inbox.checkInbox()
    configService.update({ lastInboxCheck: new Date().toISOString() })
    if (result.updated.length > 0) {
      for (const item of result.updated) {
        // Name the sender's zone when they gave one. "interview detected for
        // 2026-03-12 04:00" is alarming and unhelpful on its own; "…(they wrote
        // 2:00 PM AEDT)" is the sentence that lets the user check it.
        const when = item.interviewAt
          ? ` — interview detected for ${item.interviewAt}${item.interviewZone ? ` (they wrote ${item.interviewZone})` : ''}`
          : ''
        log(`Inbox: ${item.company} replied — status updated to ${item.newStatus}${when}`)
        notify({ type: 'inbox-reply', item })
        nativeNotify('Recruiter reply', `${item.company} replied — status updated to ${item.newStatus}${when}`)
        webhooks.send('inbox-reply', item).catch(() => {})
        // The phone is the point of this one: a reply that arrives while the
        // desktop is minimised in another room is exactly what the user wants
        // to know about immediately.
        push.notifyReply(item, item.newStatus).catch(() => {})
      }
    } else {
      log(`Inbox checked: ${result.checked} emails scanned, no new replies.`)
    }
    return result
  } catch (err) {
    log(`Inbox check error: ${err.message}`)
  }
}

function notifyAttention(job) {
  notify({ type: 'attention', job })
  nativeNotify('Job needs attention', `${job.job_title} at ${job.company} (${job.match_score ?? '—'}% match)`)
  emailService.sendNewJobAlert(job).catch(() => {})
  webhooks.send('attention', job).catch(() => {})
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function runContactReminders() {
  try {
    const today = localDate()
    const due = database.getDueContacts(today)
    for (const contact of due) {
      const title = `Follow up with ${contact.name || contact.email}`
      const body = [contact.company, contact.role, contact.notes].filter(Boolean).join(' · ').slice(0, 300)
      if (!database.claimPushKey(`contact:${contact.id}:${today}`, 'contact-reminder', title, body)) continue
      notify({ type: 'contact-reminder', contact })
      nativeNotify(title, body || `Contact reminder due ${contact.next_action_at}`)
    }
    return { success: true, due: due.length }
  } catch (err) {
    log(`Contact reminder check failed: ${describeError(err)}`)
    return { success: false, error: describeError(err) }
  }
}

function runBackupDrill() {
  try {
    database.maybeBackup()
    const report = database.drillBackups()
    if (report.success) log(`Backup recovery drill passed for ${report.checked} backup(s).`)
    else {
      log(`Backup recovery drill failed: ${report.error || `${report.failed} backup(s) could not be restored`}`)
      nativeNotify('Backup recovery drill failed', report.error || `${report.failed} backup(s) could not be restored.`)
    }
    notify({ type: 'backup-drill', report })
    return report
  } catch (err) {
    log(`Backup recovery drill failed: ${describeError(err)}`)
    return { success: false, error: describeError(err) }
  }
}

function runBackupDrillIfDue() {
  const last = database.getBackupDrillStatus()
  if (!last?.checkedAt || Date.now() - new Date(last.checkedAt).getTime() >= 7 * 86400000) return runBackupDrill()
  return { success: true, skipped: true, last }
}

// OS-level notification for events that matter while Hiro runs in the
// background. Skipped when the window is focused (the in-app toast already
// covers that) or when disabled in Settings.
function nativeNotify(title, body) {
  try {
    const cfg = configService.load()
    if (cfg.enableDesktopNotifications === false) return
    if (win && !win.isDestroyed() && win.isFocused()) return
    const { Notification } = require('electron')
    if (!Notification.isSupported()) return
    new Notification({ title, body }).show()
  } catch { /* notifications are best-effort */ }
}

// Anything can be thrown in JavaScript, and the things that actually get thrown
// in this codebase include bare strings from sql.js. A log line reading
// "undefined" is worse than no log line, because it looks like a missing value
// rather than a swallowed error.
function describeError(err) {
  if (err instanceof Error) return err.message || String(err)
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

function log(msg) {
  logger.append(msg) // persist for after-the-fact diagnosis
  if (win && !win.isDestroyed()) {
    win.webContents.send('automation:log', `[${new Date().toLocaleTimeString()}] ${msg}`)
  }
}

function notify(data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('notification', data)
  }
}

function getStatus() {
  return { running, tasksActive: !!scanTask }
}

function getBatchSchedule() {
  return batchSchedule
}

module.exports = { init, restart, stop, cancelScan, runNow, runDryRun, requestScan, processQueue, getScanInfo, getLastDryRun, runInboxCheck, runFollowUp, runStaleSweep, runContactReminders, runBackupDrill, runBackupDrillIfDue, getStatus, getBatchSchedule, runBatch,
  // exported for tests
  evenHourInterval }
