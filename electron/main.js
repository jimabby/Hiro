const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron')
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
const gmailAuth = require('./services/gmailAuth')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'public', 'logo.png')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
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

  // Open external links in system browser instead of Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const appUrl = isDev ? 'http://localhost:5173' : 'file://'
    if (!url.startsWith(appUrl)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
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
    title: 'Select File',
    filters: [
      { name: 'Document Files', extensions: ['pdf', 'docx', 'doc', 'txt'] },
    ],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return { canceled: true }

  const filePath = filePaths[0]
  const fs = require('fs')
  const pathMod = require('path')
  const fileName = pathMod.basename(filePath, pathMod.extname(filePath))
  const ext = filePath.split('.').pop().toLowerCase()

  const { CONFIG_DIR } = require('./services/config')
  const resumesDir = pathMod.join(CONFIG_DIR, 'resumes')
  if (!fs.existsSync(resumesDir)) fs.mkdirSync(resumesDir, { recursive: true })
  const fileId = Date.now().toString()

  try {
    let text = ''
    if (ext === 'txt') {
      text = fs.readFileSync(filePath, 'utf8')
    } else if (ext === 'pdf') {
      const { PDFParse } = require('pdf-parse')
      const { pathToFileURL } = require('url')
      const parser = new PDFParse({ url: pathToFileURL(filePath).toString() })
      const result = await parser.getText()
      // PDF fonts often use non-standard encoding — strip same artifacts as DOCX
      text = result.text
        .replace(/\r\n/g, '\n')
        .replace(/[^\x09\x0A\x20-\x7E\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '')
        .replace(/•(?!\s)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = require('mammoth')

      // Extract hyperlinks from HTML representation (Portfolio, GitHub, LinkedIn, etc.)
      const linkMap = new Map()
      try {
        const htmlResult = await mammoth.convertToHtml({ path: filePath })
        const linkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        let lm
        while ((lm = linkRegex.exec(htmlResult.value)) !== null) {
          const url = lm[1]
          const linkText = lm[2].replace(/<[^>]+>/g, '').trim()
          if (linkText && url && /^https?:\/\//.test(url)) {
            linkMap.set(linkText, url)
          }
        }
      } catch { /* link extraction is non-critical */ }

      const result = await mammoth.extractRawText({ path: filePath })
      // Some DOCX files use non-standard font encoding — mammoth extracts those as garbled
      // Latin Extended characters. Strip anything outside ASCII + common punctuation symbols.
      text = result.value
        .replace(/\r\n/g, '\n')
        .replace(/[^\x09\x0A\x20-\x7E\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '')
        .replace(/•(?!\s)/g, '')   // remove bullet-artifacts like •7B, •6W (no space after = artifact)
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      // Embed extracted URLs so PDF builder can create clickable links
      for (const [linkText, url] of linkMap) {
        text = text.replace(linkText, `${linkText} {{${url}}}`)
      }
    }

    // Copy original file so its format can be used during submission.
    // DOCX: tailored text will be injected into the original DOCX XML.
    // PDF: original PDF cannot have its text replaced; AI-tailored text will be
    //      rendered into a fresh styled PDF at submission time.
    let originalPath = null
    let originalExt = null
    if (ext === 'pdf' || ext === 'docx' || ext === 'doc') {
      originalPath = pathMod.join(resumesDir, `${fileId}.${ext}`)
      try { fs.copyFileSync(filePath, originalPath) } catch { originalPath = null }
      if (originalPath) originalExt = ext
    }

    return { success: true, text, fileName, originalPath, originalExt }
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
ipcMain.handle('resume:download', async (_, resumeText, suggestedName, format = 'pdf', type = 'resume') => {
  const ext = format === 'docx' ? 'docx' : 'pdf'
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: `Save as ${ext.toUpperCase()}`,
    defaultPath: `${suggestedName || 'resume'}.${ext}`,
    filters: ext === 'pdf'
      ? [{ name: 'PDF Document', extensions: ['pdf'] }]
      : [{ name: 'Word Document', extensions: ['docx'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  try {
    const fs = require('fs')
    if (ext === 'pdf') {
      if (type === 'coverLetter') {
        const { buildCoverLetterPDF } = require('./services/scraper/utils')
        const tmpPath = await buildCoverLetterPDF(resumeText)
        fs.copyFileSync(tmpPath, filePath)
      } else {
        const { buildResumePDF } = require('./services/scraper/utils')
        const candidateName = (resumeText || '').split('\n').find(l => l.trim())?.trim() || 'Resume'
        const tmpPath = await buildResumePDF(resumeText, candidateName)
        fs.copyFileSync(tmpPath, filePath)
      }
    } else {
      const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx')
      const { stripMarkdown } = require('./services/scraper/utils')
      const lines = stripMarkdown(resumeText).split('\n')
      const paragraphs = []
      let firstLineDone = false
      for (const line of lines) {
        if (!firstLineDone && !line.trim()) continue
        if (!firstLineDone) {
          paragraphs.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: line.trim(), bold: true, size: 32 })] }))
          firstLineDone = true
        } else if (line.trim() && /^[A-Z][A-Z\s\/&-]{2,}$/.test(line.trim())) {
          paragraphs.push(new Paragraph({ spacing: { before: 200, after: 60 }, children: [new TextRun({ text: line.trim(), bold: true, size: 22 })] }))
        } else {
          paragraphs.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }))
        }
      }
      const doc = new Document({ sections: [{ children: paragraphs }] })
      const buffer = await Packer.toBuffer(doc)
      fs.writeFileSync(filePath, buffer)
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Resume PDF base64 (in-app viewer) ──────────────────────
ipcMain.handle('resume:getPDFBase64', async (_, resumeText, originalPath, originalExt) => {
  try {
    const fs = require('fs')
    // If uploaded as PDF, show the original file directly
    if (originalPath && originalExt === 'pdf' && fs.existsSync(originalPath)) {
      const base64 = fs.readFileSync(originalPath).toString('base64')
      return { success: true, base64 }
    }
    const { buildResumePDF } = require('./services/scraper/utils')
    const candidateName = (resumeText || '').split('\n').find(l => l.trim())?.trim() || 'Resume'
    const tmpPath = await buildResumePDF(resumeText, candidateName)
    const base64 = fs.readFileSync(tmpPath).toString('base64')
    return { success: true, base64 }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Cover letter PDF base64 (plain text, no resume formatting) ─
ipcMain.handle('coverLetter:getPDFBase64', async (_, text) => {
  try {
    const { buildCoverLetterPDF } = require('./services/scraper/utils')
    const tmpPath = await buildCoverLetterPDF(text)
    const base64 = require('fs').readFileSync(tmpPath).toString('base64')
    return { success: true, base64 }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Resume preview — open DOCX in system app ──────────────
ipcMain.handle('resume:openDocx', async (_, resumeText, originalPath) => {
  try {
    const fs = require('fs')
    // If the original DOCX is available, open it directly — fastest and most accurate preview
    if (originalPath && fs.existsSync(originalPath)) {
      await shell.openPath(originalPath)
      return { success: true }
    }
    // No original — generate a styled DOCX from the resume text
    const { buildResumeDocx } = require('./services/scraper/utils')
    const filePath = await buildResumeDocx(resumeText)
    await shell.openPath(filePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Export CSV ─────────────────────────────────────────────
ipcMain.handle('db:exportCSV', async (_, filters) => {
  const apps = database.getApplications(filters || {})
  const header = ['ID', 'Job Title', 'Company', 'Platform', 'Salary', 'Match Score', 'Match Explanation', 'Status', 'Comment', 'Applied At', 'Job URL']
  const rows = apps.map(a => [
    a.id, a.job_title, a.company, a.platform, a.salary,
    a.match_score, a.match_explanation || '', a.status, a.comment || '',
    a.applied_at, a.job_url,
  ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','))
  const csv = [header.join(','), ...rows].join('\n')
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Applications',
    defaultPath: `hiro-applications-${new Date().toISOString().split('T')[0]}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  require('fs').writeFileSync(filePath, csv, 'utf8')
  return { success: true }
})

// ─── IPC: Timeline & Analytics data ──────────────────────────────
ipcMain.handle('db:getApplicationsByDate', () => database.getApplicationsByDate())
ipcMain.handle('db:getApplicationsPerDay', (_, days) => database.getApplicationsPerDay(days || 7))

// ─── IPC: AI features ────────────────────────────────────────────
ipcMain.handle('ai:interviewQuestions', async (_, jobDescription, resumeText) => {
  try {
    const cfg = configService.load()
    const questions = await aiAdapter.generateInterviewQuestions(cfg.aiProvider, cfg.aiApiKey, jobDescription, resumeText, cfg.geminiModel)
    return { success: true, questions }
  } catch (err) { return { success: false, error: err.message } }
})

ipcMain.handle('ai:keywordGap', async (_, jobDescription, resumeText) => {
  try {
    const cfg = configService.load()
    const result = await aiAdapter.analyzeKeywordGap(cfg.aiProvider, cfg.aiApiKey, jobDescription, resumeText, cfg.geminiModel)
    return { success: true, ...result }
  } catch (err) { return { success: false, error: err.message } }
})

ipcMain.handle('config:blacklistCompany', async (_, company) => {
  const cfg = configService.load()
  const list = Array.isArray(cfg.blacklistedCompanies) ? cfg.blacklistedCompanies : []
  if (!list.map(c => c.toLowerCase()).includes(company.toLowerCase())) {
    configService.save({ ...cfg, blacklistedCompanies: [...list, company] })
  }
  return { success: true }
})

ipcMain.handle('config:removeBlacklistCompany', async (_, company) => {
  const cfg = configService.load()
  const list = Array.isArray(cfg.blacklistedCompanies) ? cfg.blacklistedCompanies : []
  configService.save({ ...cfg, blacklistedCompanies: list.filter(c => c.toLowerCase() !== company.toLowerCase()) })
  return { success: true }
})

// ─── IPC: Screening cache management ────────────────────────────
ipcMain.handle('db:getCachedAnswers', () => database.getAllCachedAnswers())

ipcMain.handle('db:deleteCachedAnswer', (_, question) => database.deleteCachedAnswer(question))

ipcMain.handle('db:clearAllCachedAnswers', () => database.clearAllCachedAnswers())

// ─── IPC: Database ──────────────────────────────────────────────
ipcMain.handle('db:getApplications', (_, filters) => database.getApplications(filters))
ipcMain.handle('db:getApplication', (_, id) => database.getApplication(id))
ipcMain.handle('db:updateStatus', (_, id, status) => database.updateApplicationStatus(id, status))
ipcMain.handle('db:updateComment', (_, id, comment) => database.updateApplicationComment(id, comment))
ipcMain.handle('db:updateRecruiterEmail', (_, id, email) => database.updateRecruiterEmail(id, email))
ipcMain.handle('db:deleteApplication', (_, id) => database.deleteApplication(id))
ipcMain.handle('db:clearAllApplications', () => database.clearAllApplications())
ipcMain.handle('db:getAttentionJobs', () => database.getAttentionJobs())
ipcMain.handle('db:dismissAttention', (_, id) => database.dismissAttentionJob(id))
ipcMain.handle('db:deleteAttentionJob', (_, id) => database.deleteAttentionJob(id))
ipcMain.handle('db:clearAllAttentionJobs', () => database.clearAllAttentionJobs())
ipcMain.handle('db:getStats', () => database.getStats())

// ─── IPC: AI Apply from Needs Attention ─────────────────────────
ipcMain.handle('application:applySkipped', async (_, jobId) => {
  try {
    const cfg = { ...configService.load(), askQuestion: makeAskQuestion(mainWindow) }
    const result = await applicator.applySkippedJob(jobId, cfg, (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('skipped:apply-log', msg)
      }
    })
    return result
  } catch (err) {
    return { success: false, reason: err.message }
  }
})

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

// ─── IPC: Gmail Auth ─────────────────────────────────────────────
ipcMain.handle('gmail:status', () => ({
  loggedIn: gmailAuth.hasSession(),
  email: gmailAuth.getSavedEmail(),
}))

ipcMain.handle('gmail:login', async (_, email) => {
  try {
    const result = await gmailAuth.loginWithBrowser(email || '', (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gmail:status-update', msg)
      }
    })
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('gmail:logout', () => {
  gmailAuth.clearSession()
  return { success: true }
})

// ─── IPC: Inbox Check ────────────────────────────────────────────
ipcMain.handle('inbox:checkNow', async () => {
  try {
    const inbox = require('./services/inbox')
    const configService = require('./services/config')
    const result = await inbox.checkInbox()
    const cfg = configService.load()
    configService.save({ ...cfg, lastInboxCheck: new Date().toISOString() })
    return { success: true, checked: result.checked, updated: result.updated }
  } catch (err) {
    return { success: false, error: err.message }
  }
})
