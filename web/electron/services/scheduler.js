const cron = require('node-cron')
const configService = require('./config')
const database = require('./database')
const emailService = require('./email')
const applicator = require('./applicator')
const webhooks = require('./webhooks')
const cloudSync = require('./cloudSync')

let scanTask = null
let reportTask = null
let followUpTask = null
let inboxTask = null
let weeklyReportTask = null
let batchTimeouts = []
let running = false
let win = null
let batchSchedule = [] // today's planned batch times for UI

function init(mainWindow) {
  win = mainWindow
  startTasks()
  // Drain any scans queued (e.g. from the mobile app) while the desktop was off.
  processQueue()
}

function startTasks() {
  const cfg = configService.load()
  if (!cfg.setupComplete) return

  if (cfg.enableSmartScheduling) {
    // Smart scheduling: spread applications in batches across the day
    setupSmartSchedule(cfg)
  } else {
    // Standard: scan once daily at configured time Mon–Fri
    const [h, m] = (cfg.scheduledScanTime || '09:00').split(':').map(Number)
    scanTask = cron.schedule(`${m} ${h} * * 1-5`, async () => { await runScan() })
  }

  // Daily report at 6pm
  reportTask = cron.schedule('0 18 * * 1-5', async () => {
    await runDailyReport()
  })

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
  const [startH, startM] = (cfg.smartScheduleStartTime || '09:00').split(':').map(Number)
  const [endH, endM] = (cfg.smartScheduleEndTime || '17:00').split(':').map(Number)

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

// Ask the user a screening question via the renderer. On timeout the
// listener must be removed, or it would consume the next question's answer.
function makeAskQuestion() {
  return (question) => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve('')
    const { ipcMain } = require('electron')
    win.webContents.send('question:ask', question)
    const handler = (_, answer) => { clearTimeout(timeout); resolve(answer || '') }
    const timeout = setTimeout(() => {
      ipcMain.removeListener('question:answer', handler)
      resolve('')
    }, 5 * 60 * 1000)
    ipcMain.once('question:answer', handler)
  })
}

async function runBatch(batchSize) {
  if (running) return
  running = true
  log(`Starting batch (${batchSize} apps max)...`)

  try {
    const cfg = configService.load()
    if (!cfg.setupComplete) return
    await applicator.run({ ...cfg, askQuestion: makeAskQuestion(), batchLimit: batchSize }, { log, notifyAttention })
  } catch (err) {
    log(`Batch error: ${err.message}`)
  } finally {
    running = false
    log('Batch complete.')
    notify({ type: 'scan-complete' })
    webhooks.send('scan-complete', { message: `Batch of ${batchSize} complete` }).catch(() => {})
    cloudSync.sync().catch(() => {})
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
  applicator.cancel()
  running = false
  log('Scan cancelled by user.')
  notify({ type: 'scan-complete' })
}

function restart(mainWindow) {
  win = mainWindow
  stop()
  startTasks()
}

async function runNow(mainWindow) {
  win = mainWindow
  await runScan()
}

// Queue a scan request (e.g. from the mobile companion app). The request is
// persisted to config so it survives a desktop restart, then run as soon as the
// desktop is idle. `opts` may carry { keywords, location } to override the
// saved search for this run, and `source` for logging.
function requestScan(opts = {}) {
  const cfg = configService.load()
  const req = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    keywords: (opts.keywords || '').trim(),
    location: (opts.location || '').trim(),
    source: opts.source || 'desktop',
  }
  const pending = Array.isArray(cfg.pendingScans) ? cfg.pendingScans : []
  pending.push(req)
  configService.save({ ...cfg, pendingScans: pending })
  log(`Scan request queued from ${req.source}${req.keywords ? ` (keywords: ${req.keywords})` : ''}`)
  processQueue()
  return req
}

// Run queued scan requests one at a time until the queue is empty.
async function processQueue() {
  if (running) return
  const cfg = configService.load()
  const pending = Array.isArray(cfg.pendingScans) ? cfg.pendingScans : []
  if (pending.length === 0) return

  const req = pending[0]
  await runScan({ keywords: req.keywords, location: req.location })

  // Remove the processed request (reload in case config changed during the run).
  const after = configService.load()
  after.pendingScans = (after.pendingScans || []).filter(r => r.id !== req.id)
  configService.save(after)

  if ((after.pendingScans || []).length > 0) processQueue()
}

async function runScan(overrides = {}) {
  if (running) return
  running = true
  log('Starting job scan...')

  try {
    const cfg = configService.load()
    if (!cfg.setupComplete) {
      log('Setup not complete. Skipping scan.')
      return
    }
    const runCfg = { ...cfg, askQuestion: makeAskQuestion() }
    if (overrides.keywords) runCfg.jobKeywords = overrides.keywords
    if (overrides.location) runCfg.jobLocation = overrides.location
    await applicator.run(runCfg, { log, notifyAttention })
  } catch (err) {
    log(`Scan error: ${err.message}`)
  } finally {
    running = false
    try {
      const c = configService.load()
      configService.save({ ...c, lastScanAt: new Date().toISOString() })
    } catch {}
    log('Scan complete.')
    notify({ type: 'scan-complete' })
    webhooks.send('scan-complete', { message: 'Full scan complete' }).catch(() => {})
    cloudSync.sync().catch(() => {})
  }
}

function getScanInfo() {
  const cfg = configService.load()
  return {
    running,
    queued: (cfg.pendingScans || []).length,
    lastScanAt: cfg.lastScanAt || null,
    batchSchedule,
  }
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
    configService.save({ ...cfg, lastInboxCheck: new Date().toISOString() })
    if (result.updated.length > 0) {
      for (const item of result.updated) {
        log(`Inbox: ${item.company} replied — status updated to ${item.newStatus}`)
        notify({ type: 'inbox-reply', item })
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
  emailService.sendNewJobAlert(job).catch(() => {})
  webhooks.send('attention', job).catch(() => {})
}

function log(msg) {
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

module.exports = { init, restart, stop, cancelScan, runNow, requestScan, processQueue, getScanInfo, runInboxCheck, getStatus, getBatchSchedule }
