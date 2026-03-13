const cron = require('node-cron')
const configService = require('./config')
const database = require('./database')
const emailService = require('./email')
const applicator = require('./applicator')

let scanTask = null
let reportTask = null
let running = false
let win = null

function init(mainWindow) {
  win = mainWindow
  startTasks()
}

function startTasks() {
  const cfg = configService.load()
  if (!cfg.setupComplete) return

  // Scan every hour 9am–5pm Mon–Fri
  scanTask = cron.schedule('0 9-17 * * 1-5', async () => {
    await runScan()
  })

  // Daily report at 6pm
  reportTask = cron.schedule('0 18 * * 1-5', async () => {
    await runDailyReport()
  })
}

function stop() {
  if (scanTask) { scanTask.stop(); scanTask = null }
  if (reportTask) { reportTask.stop(); reportTask = null }
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

module.exports = { init, restart, stop, cancelScan, runNow, getStatus }
