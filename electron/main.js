const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const configService = require('./services/config')
const database = require('./services/database')
const scheduler = require('./services/scheduler')
const emailService = require('./services/email')
const aiAdapter = require('./services/ai/index')
const linkedinSession = require('./services/linkedinSession')
const seekSession = require('./services/seekSession')
const indeedSession = require('./services/indeedSession')
const applicator = require('./services/applicator')

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

// ─── Screening question helper ───────────────────────────────────
function makeAskQuestion(win) {
  return (question) => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve('')
    win.webContents.send('question:ask', question)
    const timeout = setTimeout(() => resolve(''), 5 * 60 * 1000) // 5 min timeout
    ipcMain.once('question:answer', (_, answer) => {
      clearTimeout(timeout)
      resolve(answer || '')
    })
  })
}

// ─── IPC: Screening answer from user ────────────────────────────
// (Renderer sends this via ipcRenderer.send — not invoke)

// ─── IPC: Seek ───────────────────────────────────────────────────
ipcMain.handle('seek:status', () => ({ loggedIn: seekSession.hasCookies() }))

ipcMain.handle('seek:login', async () => {
  try {
    const result = await seekSession.loginWithBrowser((msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('seek:status-update', msg)
      }
    })
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('seek:logout', () => {
  seekSession.clearCookies()
  return { success: true }
})

// ─── IPC: Indeed ─────────────────────────────────────────────────
ipcMain.handle('indeed:status', () => ({ loggedIn: indeedSession.hasCookies() }))

ipcMain.handle('indeed:login', async () => {
  try {
    const result = await indeedSession.loginWithBrowser((msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('indeed:status-update', msg)
      }
    })
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('indeed:logout', () => {
  indeedSession.clearCookies()
  return { success: true }
})

// ─── IPC: Resume file import ────────────────────────────────────
ipcMain.handle('resume:importFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Resume File',
    filters: [
      { name: 'Resume Files', extensions: ['pdf', 'docx', 'doc', 'txt'] },
    ],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return { canceled: true }

  const filePath = filePaths[0]
  const fileName = require('path').basename(filePath, require('path').extname(filePath))
  const ext = filePath.split('.').pop().toLowerCase()
  const fs = require('fs')

  try {
    let text = ''
    if (ext === 'txt') {
      text = fs.readFileSync(filePath, 'utf8')
    } else if (ext === 'pdf') {
      const { PDFParse } = require('pdf-parse')
      const { pathToFileURL } = require('url')
      const parser = new PDFParse({ url: pathToFileURL(filePath).toString() })
      const result = await parser.getText()
      text = result.text
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = require('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      text = result.value
    }
    return { success: true, text, fileName }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Resume AI improve ─────────────────────────────────────
ipcMain.handle('resume:improve', async (_, resumeText) => {
  try {
    const cfg = configService.load()
    const improved = await aiAdapter.improveResume(cfg.aiProvider, cfg.aiApiKey, resumeText, cfg.geminiModel)
    return { success: true, text: improved }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Resume download ────────────────────────────────────────
ipcMain.handle('resume:download', async (_, resumeText, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Resume',
    defaultPath: `${suggestedName || 'resume'}.docx`,
    filters: [{ name: 'Word Document', extensions: ['docx'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  try {
    const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx')
    function stripMd(text) {
      return (text || '')
        .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1')
        .replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1')
        .replace(/^#{1,6}\s+/gm, '').replace(/^\*\s+/gm, '- ')
        .replace(/^-{3,}\s*$/gm, '').trim()
    }
    const lines = stripMd(resumeText).split('\n')
    const paragraphs = []
    let firstLineDone = false
    for (const line of lines) {
      if (!firstLineDone && !line.trim()) continue
      if (!firstLineDone) {
        paragraphs.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: line.trim(), bold: true, size: 32 })],
        }))
        firstLineDone = true
      } else if (line.trim() && /^[A-Z][A-Z\s\/&-]{2,}$/.test(line.trim())) {
        paragraphs.push(new Paragraph({
          spacing: { before: 200, after: 60 },
          children: [new TextRun({ text: line.trim(), bold: true, size: 22 })],
        }))
      } else {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: line, size: 22 })],
        }))
      }
    }
    const doc = new Document({ sections: [{ children: paragraphs }] })
    const buffer = await Packer.toBuffer(doc)
    require('fs').writeFileSync(filePath, buffer)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Database ──────────────────────────────────────────────
ipcMain.handle('db:getApplications', (_, filters) => database.getApplications(filters))
ipcMain.handle('db:getApplication', (_, id) => database.getApplication(id))
ipcMain.handle('db:updateStatus', (_, id, status) => database.updateApplicationStatus(id, status))
ipcMain.handle('db:updateComment', (_, id, comment) => database.updateApplicationComment(id, comment))
ipcMain.handle('db:deleteApplication', (_, id) => database.deleteApplication(id))
ipcMain.handle('db:clearAllApplications', () => database.clearAllApplications())
ipcMain.handle('db:getAttentionJobs', () => database.getAttentionJobs())
ipcMain.handle('db:dismissAttention', (_, id) => database.dismissAttentionJob(id))
ipcMain.handle('db:deleteAttentionJob', (_, id) => database.deleteAttentionJob(id))
ipcMain.handle('db:clearAllAttentionJobs', () => database.clearAllAttentionJobs())
ipcMain.handle('db:getStats', () => database.getStats())

// ─── IPC: AI Apply from Needs Attention ─────────────────────────
ipcMain.handle('attention:apply', async (_, jobId) => {
  try {
    const cfg = { ...configService.load(), askQuestion: makeAskQuestion(mainWindow) }
    const result = await applicator.applyAttentionJob(jobId, cfg, (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('attention:log', msg)
      }
    })
    return result
  } catch (err) {
    return { success: false, reason: err.message }
  }
})
