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
const mobileApi = require('./services/mobileApi')
const cloudSync = require('./services/cloudSync')
const logger = require('./services/logger')

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
  // Rotating daily backup: once on launch, then re-checked periodically so
  // long-running sessions still get one backup per day.
  database.maybeBackup()
  setInterval(() => database.maybeBackup(), 6 * 60 * 60 * 1000)
  createWindow()
  scheduler.init(mainWindow)
  if (configService.load().mobileApiEnabled) mobileApi.start()
  cloudSync.init().catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── IPC: Config ────────────────────────────────────────────────
ipcMain.handle('config:get', () => configService.load())

// Keys owned by background services (scheduler, cloud sync, mobile API,
// inbox). The renderer's form is a snapshot from page load — saving it
// verbatim would clobber anything these services wrote since.
const RUNTIME_CONFIG_KEYS = [
  'pendingScans', 'lastScanAt', 'lastInboxCheck', 'lastCloudSyncAt',
  'cloudSyncEnabled', 'supabaseEmail', 'supabaseRefreshToken',
  'mobileApiEnabled', 'mobileApiToken',
]

ipcMain.handle('config:save', (_, config) => {
  const current = configService.load()
  const merged = { ...config }
  for (const key of RUNTIME_CONFIG_KEYS) merged[key] = current[key]
  configService.save(merged)
  scheduler.restart(mainWindow)
  return { success: true }
})

// ─── IPC: Cloud sync ────────────────────────────────────────────
ipcMain.handle('cloud:status', () => cloudSync.getStatus())

ipcMain.handle('cloud:signIn', async (_, email, password) => {
  try {
    return { success: true, status: await cloudSync.signIn(email, password) }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('cloud:signOut', async () => ({ success: true, status: await cloudSync.signOut() }))

ipcMain.handle('cloud:syncNow', async () => {
  try {
    return { success: true, status: await cloudSync.sync() }
  } catch (err) {
    return { success: false, error: err.message }
  }
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
// Report un-startable states up front so the renderer can reset its spinner
// (a fire-and-forget start that silently no-ops leaves "Scanning…" stuck).
function scanStartBlocker() {
  if (scheduler.getStatus().running || applicator.isBusy()) return 'A scan or apply is already running.'
  if (!configService.load().setupComplete) return 'Complete setup before running a scan.'
  return null
}

ipcMain.handle('automation:start', () => {
  const blocked = scanStartBlocker()
  if (blocked) return { success: false, error: blocked }
  scheduler.runNow(mainWindow)
  return { success: true }
})

ipcMain.handle('automation:stop', () => {
  scheduler.cancelScan()
  return { success: true }
})

// Test scan — scores/tailors every found job but never submits or saves.
ipcMain.handle('automation:dryRun', () => {
  const blocked = scanStartBlocker()
  if (blocked) return { success: false, error: blocked }
  scheduler.runDryRun(mainWindow)
  return { success: true }
})

ipcMain.handle('automation:status', () => scheduler.getStatus())

// ─── IPC: Activity log (persistent) ─────────────────────────────
ipcMain.handle('logs:getRecent', () => logger.tail(500))
ipcMain.handle('logs:clear', () => logger.clear())
ipcMain.handle('logs:openFile', async () => {
  try {
    await shell.openPath(logger.getPath())
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

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
// Shared with the scheduler; routes answers by question id so two concurrent
// apply flows can never consume each other's answers.
const { makeAskQuestion } = require('./services/askQuestion')

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
      // characters. Aggressively strip anything that isn't printable ASCII or common typographic symbols.
      text = result.value
        .replace(/\r\n/g, '\n')
        // Remove bullet/symbol artifacts attached to words (e.g. "•7B", "•6W")
        .replace(/•(?=[A-Za-z0-9])/g, '')
        // Strip non-ASCII except allowed typographic characters
        .replace(/[^\x09\x0A\x20-\x7E\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '')
        // Clean up remaining isolated bullets with no content
        .replace(/•(?!\s)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      // Embed extracted URLs so PDF builder can create clickable links
      for (const [linkText, url] of linkMap) {
        text = text.replace(linkText, `${linkText} {{${url}}}`)
      }

      // Auto-save extracted links to config (won't overwrite user-entered values)
      if (linkMap.size > 0) {
        try {
          const cfg = configService.load()
          const pl = cfg.personalLinks || {}
          let changed = false
          for (const [linkText, url] of linkMap) {
            const lt = linkText.toLowerCase()
            if (lt.includes('portfolio') && !pl.portfolio) { pl.portfolio = url; changed = true }
            else if ((lt.includes('github') || lt.includes('git')) && !pl.github) { pl.github = url; changed = true }
            else if (lt.includes('linkedin') && !pl.linkedin) { pl.linkedin = url; changed = true }
          }
          if (changed) configService.update({ personalLinks: pl })
        } catch { /* non-critical */ }
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
        const cfg = configService.load()
        const tmpPath = await buildResumePDF(resumeText, candidateName, cfg.personalLinks)
        fs.copyFileSync(tmpPath, filePath)
      }
    } else {
      const { buildResumeDocx } = require('./services/scraper/utils')
      const tmpPath = await buildResumeDocx(resumeText)
      fs.copyFileSync(tmpPath, filePath)
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
    const cfg = configService.load()
    const tmpPath = await buildResumePDF(resumeText, candidateName, cfg.personalLinks)
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
  configService.update(cfg => {
    const list = Array.isArray(cfg.blacklistedCompanies) ? cfg.blacklistedCompanies : []
    if (list.map(c => c.toLowerCase()).includes(company.toLowerCase())) return cfg
    return { ...cfg, blacklistedCompanies: [...list, company] }
  })
  return { success: true }
})

ipcMain.handle('config:removeBlacklistCompany', async (_, company) => {
  configService.update(cfg => {
    const list = Array.isArray(cfg.blacklistedCompanies) ? cfg.blacklistedCompanies : []
    return { ...cfg, blacklistedCompanies: list.filter(c => c.toLowerCase() !== company.toLowerCase()) }
  })
  return { success: true }
})

// ─── IPC: Screening cache management ────────────────────────────
ipcMain.handle('db:getCachedAnswers', () => database.getAllCachedAnswers())

ipcMain.handle('db:deleteCachedAnswer', (_, question) => database.deleteCachedAnswer(question))

ipcMain.handle('db:clearAllCachedAnswers', () => database.clearAllCachedAnswers())

ipcMain.handle('db:updateCachedAnswer', (_, question, answer) => {
  database.saveCachedAnswer(question, answer)
  return { success: true }
})

ipcMain.handle('db:getStorageInfo', () => database.getStorageInfo())

// ─── IPC: Status history & backups ───────────────────────────────
ipcMain.handle('db:getStatusHistory', (_, applicationId) => database.getStatusHistory(applicationId))
ipcMain.handle('db:backupNow', () => {
  try { return database.backupNow() } catch (err) { return { success: false, error: err.message } }
})
ipcMain.handle('db:listBackups', () => database.listBackups())
ipcMain.handle('db:restoreBackup', (_, name) => {
  try { return database.restoreBackup(name) } catch (err) { return { success: false, error: err.message } }
})

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
      logger.append(`[skipped-apply] ${msg}`)
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
      logger.append(`[attention-apply] ${msg}`)
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

// ─── IPC: Interview Prep ─────────────────────────────────────────
ipcMain.handle('ai:interviewFollowUp', async (_, question, userAnswer, jobDescription) => {
  try {
    const cfg = configService.load()
    const text = await aiAdapter.generateFollowUpQuestion(cfg.aiProvider, cfg.aiApiKey, question, userAnswer, jobDescription, cfg.geminiModel)
    return { success: true, question: text }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('db:saveInterviewPrep', (_, applicationId, questions) => {
  database.saveInterviewPrep(applicationId, questions)
  return { success: true }
})

ipcMain.handle('db:getInterviewPrep', (_, applicationId) => {
  return database.getInterviewPrep(applicationId)
})

// ─── IPC: Analytics Export ───────────────────────────────────────
ipcMain.handle('analytics:exportPDF', async () => {
  try {
    const { buildAnalyticsReportPDF } = require('./services/scraper/utils')
    const data = database.getWeeklyReportData()
    const tmpPath = await buildAnalyticsReportPDF(data)
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `hiro-analytics-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (!filePath) return { success: false, reason: 'cancelled' }
    require('fs').copyFileSync(tmpPath, filePath)
    return { success: true, filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('analytics:getWeeklyData', () => {
  return database.getWeeklyReportData()
})

// ─── IPC: Webhooks ──────────────────────────────────────────────
ipcMain.handle('webhook:test', async (_, provider, url) => {
  try {
    const webhooks = require('./services/webhooks')
    const ok = await webhooks.test(provider, url)
    return { success: ok }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Smart Scheduling ──────────────────────────────────────
ipcMain.handle('scheduler:getBatchSchedule', () => {
  return scheduler.getBatchSchedule()
})

// ─── IPC: Mobile Companion API ───────────────────────────────────
ipcMain.handle('mobile:getInfo', () => mobileApi.getInfo())

ipcMain.handle('mobile:setEnabled', (_, enabled) => {
  configService.update({ mobileApiEnabled: !!enabled })
  return enabled ? mobileApi.start() : mobileApi.stop()
})

ipcMain.handle('mobile:regenerateToken', () => {
  mobileApi.regenerateToken()
  return mobileApi.getInfo()
})

// ─── IPC: Inbox Check ────────────────────────────────────────────
ipcMain.handle('inbox:checkNow', async () => {
  try {
    const inbox = require('./services/inbox')
    const result = await inbox.checkInbox()
    configService.update({ lastInboxCheck: new Date().toISOString() })
    return { success: true, checked: result.checked, updated: result.updated }
  } catch (err) {
    return { success: false, error: err.message }
  }
})
