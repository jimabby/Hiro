const cron = require('node-cron')
const configService = require('./config')
const database = require('./database')
const emailService = require('./email')
const applicator = require('./applicator')

let scanTask = null
let reportTask = null
let followUpTask = null
let inboxTask = null
let running = false
let win = null

function init(mainWindow) {
  win = mainWindow
  startTasks()
}

function startTasks() {
  const cfg = configService.load()
  if (!cfg.setupComplete) return

  // Scan once daily at configured time Mon–Fri
  const [h, m] = (cfg.scheduledScanTime || '09:00').split(':').map(Number)
  scanTask = cron.schedule(`${m} ${h} * * 1-5`, async () => { await runScan() })

  // Daily report at 6pm
  reportTask = cron.schedule('0 18 * * 1-5', async () => {
    await runDailyReport()
  })

  if (cfg.enableFollowUp && cfg.followUpDays > 0) {
    followUpTask = cron.schedule('0 10 * * 1-5', async () => { await runFollowUp() })
  }

  if (cfg.enableInboxCheck) {
    // Check inbox every 2 hours on weekdays
    inboxTask = cron.schedule('0 */2 * * 1-5', async () => { await runInboxCheck() })
  }
}

function stop() {
  if (scanTask) { scanTask.stop(); scanTask = null }
  if (reportTask) { reportTask.stop(); reportTask = null }
  if (followUpTask) { followUpTask.stop(); followUpTask = null }
  if (inboxTask) { inboxTask.stop(); inboxTask = null }
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

async function runScan() {
  if (running) return
  running = true
  log('Starting job scan...')

  try {
    const cfg = configService.load()
    if (!cfg.setupComplete) {
      log('Setup not complete. Skipping scan.')
      return
    }
    const { ipcMain } = require('electron')
    const askQuestion = (question) => new Promise((resolve) => {
      if (!win || win.isDestroyed()) return resolve('')
      win.webContents.send('question:ask', question)
      const timeout = setTimeout(() => resolve(''), 5 * 60 * 1000)
      ipcMain.once('question:answer', (_, answer) => { clearTimeout(timeout); resolve(answer || '') })
    })
    await applicator.run({ ...cfg, askQuestion }, { log, notifyAttention })
  } catch (err) {
    log(`Scan error: ${err.message}`)
  } finally {
    running = false
    log('Scan complete.')
    notify({ type: 'scan-complete' })
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

module.exports = { init, restart, stop, cancelScan, runNow, runInboxCheck, getStatus }
