const cron = require('node-cron')
const configService = require('./config')
const database = require('./database')
const emailService = require('./email')
const applicator = require('./applicator')
const webhooks = require('./webhooks')
const cloudSync = require('./cloudSync')
const logger = require('./logger')

let scanTask = null
let reportTask = null
let followUpTask = null
let inboxTask = null
let weeklyReportTask = null
let batchTimeouts = []
let running = false
let win = null
let batchSchedule = [] // today's planned batch times for UI
// Outcome of the most recent real scan, so the dashboard and the phone can tell
// a failed scan from one that simply found nothing. Without this, runScan's
// catch swallowed the error and lastScanAt was stamped either way.
let lastScanOutcome = null // { at, ok, error, source }
// Score distribution from the most recent test scan, kept in memory so the
// Analytics page can recommend a match threshold from real scored jobs.
let lastDryRun = null // { at, scores[], wouldApply, threshold }

function init(mainWindow) {
  win = mainWindow
  startTasks()
  // Drain any scans queued (e.g. from the mobile app) while the desktop was off.
  processQueue()
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

function startTasks() {
  const cfg = configService.load()
  if (!cfg.setupComplete) return

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
    inboxTask = cron.schedule('0 */2 * * 1-5', async () => { await runInboxCheck() })
  }

  if (cfg.enableWeeklyReport) {
    // Monday at 9am
    weeklyReportTask = cron.schedule('0 9 * * 1', async () => { await runWeeklyReport() })
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

  const interval = Math.floor(totalMinutes / numBatches)

  // Schedule a daily cron at start time to set up today's batches
  scanTask = cron.schedule(`${startM} ${startH} * * 1-5`, () => {
    scheduleTodayBatches(numBatches, interval, startMinutes, jitter, batchSize)
  })

  // Also schedule for today if we haven't passed start time
  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  if (nowMinutes < endMinutes && now.getDay() >= 1 && now.getDay() <= 5) {
    scheduleTodayBatches(numBatches, interval, startMinutes, jitter, batchSize)
  }
}

function scheduleTodayBatches(numBatches, interval, startMinutes, jitter, batchSize) {
  // Clear existing batch timeouts
  for (const t of batchTimeouts) clearTimeout(t)
  batchTimeouts = []
  batchSchedule = []

  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  for (let i = 0; i < numBatches; i++) {
    const baseMinutes = startMinutes + i * interval
    const jitterOffset = Math.floor(Math.random() * jitter * 2) - jitter
    const scheduledMinutes = Math.max(startMinutes, baseMinutes + jitterOffset)

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

  if (batchSchedule.length > 0) {
    log(`Smart schedule: ${batchSchedule.length} batches planned — ${batchSchedule.join(', ')}`)
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
  log(`Starting batch (${batchSize} apps max)...`)
  cloudSync.updateScanStatus(true).catch(() => {})

  try {
    await applicator.run({ ...cfg, askQuestion: makeAskQuestion(win), batchLimit: batchSize }, { log, notifyAttention })
  } catch (err) {
    batchError = err.message
    log(`Batch error: ${err.message}`)
  } finally {
    running = false
    lastScanOutcome = {
      at: new Date().toISOString(),
      ok: !batchError,
      error: batchError,
      source: 'batch',
    }
    cloudSync.updateScanStatus(false).catch(() => {})
    log(batchError ? `Batch failed: ${batchError}` : 'Batch complete.')
    notify({ type: 'scan-complete', error: batchError })
    webhooks.send('scan-complete', {
      message: batchError ? `Batch failed: ${batchError}` : `Batch of ${batchSize} complete`,
      ok: !batchError,
    }).catch(() => {})
    cloudSync.sync().catch(() => {})
    setImmediate(() => { processQueue() })
  }
}

function stop() {
  if (scanTask) { scanTask.stop(); scanTask = null }
  if (reportTask) { reportTask.stop(); reportTask = null }
  if (followUpTask) { followUpTask.stop(); followUpTask = null }
  if (inboxTask) { inboxTask.stop(); inboxTask = null }
  if (weeklyReportTask) { weeklyReportTask.stop(); weeklyReportTask = null }
  for (const t of batchTimeouts) clearTimeout(t)
  batchTimeouts = []
  batchSchedule = []
  applicator.cancel()
  running = false
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

function restart(mainWindow) {
  win = mainWindow
  stop()
  startTasks()
  // Settings may have just completed setup — drain any scans queued before it.
  processQueue()
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
  const req = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    keywords: (opts.keywords || '').trim(),
    location: (opts.location || '').trim(),
    source: opts.source || 'desktop',
  }
  configService.update(c => ({ ...c, pendingScans: [...(Array.isArray(c.pendingScans) ? c.pendingScans : []), req] }))
  log(`Scan request queued from ${req.source}${req.keywords ? ` (keywords: ${req.keywords})` : ''}`)
  processQueue()
  return req
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
  const result = await runScan({ keywords: req.keywords, location: req.location, fromQueue: true })

  // Only pop the request if the scan actually ran. If the desktop was busy or
  // setup isn't complete yet, the request stays queued and is retried after
  // the current scan finishes / setup completes (previously it was discarded).
  if (!result?.ran) return

  const after = configService.update(c => ({
    ...c,
    pendingScans: (c.pendingScans || []).filter(r => r.id !== req.id),
  }))
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
  log(dryRun ? 'Starting test scan (dry run — nothing will be submitted)...' : 'Starting job scan...')
  cloudSync.updateScanStatus(true).catch(() => {})

  try {
    const runCfg = { ...cfg, askQuestion: makeAskQuestion(win) }
    if (overrides.keywords) runCfg.jobKeywords = overrides.keywords
    if (overrides.location) runCfg.jobLocation = overrides.location
    if (dryRun) runCfg.dryRun = true
    const result = await applicator.run(runCfg, { log, notifyAttention })
    if (dryRun && result) lastDryRun = { at: new Date().toISOString(), ...result }
  } catch (err) {
    scanError = err.message
    log(`Scan error: ${err.message}`)
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
        source: overrides.fromQueue ? 'queue' : (overrides.source || 'desktop'),
      }
    }
    log(dryRun ? 'Test scan complete (dry run — nothing was submitted).' : 'Scan complete.')
    notify({ type: 'scan-complete', error: scanError })
    if (!dryRun) {
      try {
        const s = database.getStats()
        nativeNotify(
          scanError ? 'Scan failed' : 'Scan complete',
          scanError || `${s.totalToday} application${s.totalToday === 1 ? '' : 's'} today · ${s.attentionCount} need${s.attentionCount === 1 ? 's' : ''} attention`
        )
      } catch { /* stats are decorative here */ }
      webhooks.send('scan-complete', {
        message: scanError ? `Scan failed: ${scanError}` : 'Full scan complete',
        ok: !scanError,
      }).catch(() => {})
      cloudSync.sync().catch(() => {})
      // Drain scans queued (e.g. from the phone) while this scan was running.
      // Queue-initiated runs skip this: processQueue continues itself after
      // removing the finished request, and re-entering here would run it twice.
      if (!overrides.fromQueue) setImmediate(() => { processQueue() })
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

async function runFollowUp() {
  try {
    const cfg = configService.load()
    if (!cfg.enableFollowUp || !cfg.gmailAddress) return
    const aiAdapter = require('./ai/index')
    const jobs = database.getApplicationsForFollowUp(cfg.followUpDays || 7)
    for (const job of jobs) {
      if (!job.recruiter_email) {
        log(`Follow-up skipped for ${job.job_title} at ${job.company} — no recruiter email`)
        continue
      }
      const activeResume = (cfg.resumes || []).find(r => r.id === cfg.defaultResumeId)?.text || cfg.masterResume || ''
      const emailText = await aiAdapter.generateFollowUpEmail(
        cfg.aiProvider, cfg.aiApiKey, job.job_title, job.company, activeResume, cfg.geminiModel
      )
      await emailService.sendFollowUpEmail(job, emailText, cfg)
      database.markFollowUpSent(job.id)
      log(`Follow-up sent for ${job.job_title} at ${job.company}`)
    }
  } catch (err) {
    log(`Follow-up error: ${err.message}`)
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
        const when = item.interviewAt ? ` — interview detected for ${item.interviewAt}` : ''
        log(`Inbox: ${item.company} replied — status updated to ${item.newStatus}${when}`)
        notify({ type: 'inbox-reply', item })
        nativeNotify('Recruiter reply', `${item.company} replied — status updated to ${item.newStatus}${when}`)
        webhooks.send('inbox-reply', item).catch(() => {})
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

module.exports = { init, restart, stop, cancelScan, runNow, runDryRun, requestScan, processQueue, getScanInfo, getLastDryRun, runInboxCheck, getStatus, getBatchSchedule }
