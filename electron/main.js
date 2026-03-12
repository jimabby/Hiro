const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const configService = require('./services/config')
const database = require('./services/database')
const scheduler = require('./services/scheduler')
const emailService = require('./services/email')
const aiAdapter = require('./services/ai/index')
const linkedinSession = require('./services/linkedinSession')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => mainWindow.show())
}

app.whenReady().then(async () => {
  await database.init()
  createWindow()
  scheduler.init(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── IPC: Config ────────────────────────────────────────────────
ipcMain.handle('config:get', () => configService.load())

ipcMain.handle('config:save', (_, config) => {
  configService.save(config)
  scheduler.restart(mainWindow)
  return { success: true }
})

// ─── IPC: AI test ───────────────────────────────────────────────
ipcMain.handle('ai:test', async (_, provider, apiKey, geminiModel) => {
  try {
    await aiAdapter.testConnection(provider, apiKey, geminiModel)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Email test ────────────────────────────────────────────
ipcMain.handle('email:test', async (_, email, password) => {
  try {
    await emailService.testConnection(email, password)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Automation ────────────────────────────────────────────
ipcMain.handle('automation:start', () => {
  scheduler.runNow(mainWindow)
  return { success: true }
})

ipcMain.handle('automation:stop', () => {
  scheduler.cancelScan()
  return { success: true }
})

ipcMain.handle('automation:status', () => scheduler.getStatus())

// ─── IPC: LinkedIn ──────────────────────────────────────────────
ipcMain.handle('linkedin:status', () => ({ loggedIn: linkedinSession.hasCookies() }))

ipcMain.handle('linkedin:login', async () => {
  try {
    const result = await linkedinSession.loginWithBrowser((msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('linkedin:status-update', msg)
      }
    })
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('linkedin:logout', () => {
  linkedinSession.clearCookies()
  return { success: true }
})

// ─── IPC: Database ──────────────────────────────────────────────
ipcMain.handle('db:getApplications', (_, filters) => database.getApplications(filters))
ipcMain.handle('db:getApplication', (_, id) => database.getApplication(id))
ipcMain.handle('db:updateStatus', (_, id, status) => database.updateApplicationStatus(id, status))
ipcMain.handle('db:getAttentionJobs', () => database.getAttentionJobs())
ipcMain.handle('db:dismissAttention', (_, id) => database.dismissAttentionJob(id))
ipcMain.handle('db:getStats', () => database.getStats())
