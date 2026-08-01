const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron')
const path = require('path')

// Point Playwright at the Chromium bundled with the app. This MUST run before
// anything requires playwright — the module reads the variable at load time.
// Without it, a packaged build looks in a per-user cache directory that was
// never installed on the end user's machine, and every scrape failed with
// "Executable doesn't exist".
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const fs = require('fs')
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'browsers')
    : path.join(__dirname, '..', 'browsers')
  // Fall back to Playwright's own cache when the bundle is absent (a dev clone
  // that skipped the postinstall download), rather than pointing at nothing.
  if (fs.existsSync(bundled)) process.env.PLAYWRIGHT_BROWSERS_PATH = bundled
}

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
const configTransfer = require('./services/configTransfer')
const tray = require('./services/tray')
const updater = require('./services/updater')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow

// Two copies of Hiro means two schedulers, two mobile API servers (the second
// silently losing the port), and two processes rewriting the same SQLite file —
// sql.js persists by replacing the WHOLE file, so the loser's writes vanish
// without a trace. Refuse the second launch and surface the existing window.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

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
      // The preload only uses contextBridge + ipcRenderer, both of which are
      // available to sandboxed preloads — so the renderer can run in the OS
      // sandbox with no loss of function. Without this a renderer compromise
      // has the full privileges of the user account.
      sandbox: true,
      // Defence in depth: the renderer has no legitimate reason to reach the
      // Node integration in workers, or to load remote content over http.
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
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

  // Launch-on-login can start us hidden, and Settings has a "start minimised"
  // option — in both cases showing the window would defeat the point.
  const startHidden = process.argv.includes('--hidden') || configService.load().startMinimised
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show() })

  // Closing the window hides it instead of quitting, so the scheduler keeps
  // running. Only honoured when a tray icon actually exists — otherwise the
  // app would keep running with no way to reach it.
  mainWindow.on('close', (e) => {
    if (tray.isQuitting() || !tray.hasTray() || !configService.load().minimizeToTray) return
    e.preventDefault()
    mainWindow.hide()
  })

  // Open external links in system browser instead of Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  // Navigation is pinned to the ONE page this app is allowed to be. The old
  // check accepted any `file://` URL in production, so a single injected link
  // could navigate the privileged renderer to an arbitrary local file —
  // including one an attacker had just written to disk — and read it with the
  // preload bridge attached.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isEntryPointUrl(url)) return
    e.preventDefault()
    // Only hand genuine web URLs to the browser; never file:// or custom
    // schemes, which shell.openExternal would happily launch.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  // A redirect can land somewhere the initial URL check approved of; re-check.
  mainWindow.webContents.on('will-redirect', (e, url) => {
    if (!isEntryPointUrl(url)) e.preventDefault()
  })

  // Nothing in this app uses the camera, microphone, location or notifications
  // from the renderer, so every permission request is illegitimate by default.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)

  // Refuse to attach a <webview>; the tag is disabled above, this covers the
  // case where it is re-enabled by a future change.
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault())
}

// The single URL the main window may occupy. In dev that's the Vite server; in
// production it's the packaged entry file and nothing else. Compared as a
// resolved path so `..` traversal can't smuggle in another file.
const ENTRY_FILE = path.join(__dirname, '..', 'dist', 'index.html')

function isEntryPointUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { return false }

  if (isDev) {
    return parsed.origin === 'http://localhost:5173'
  }
  if (parsed.protocol !== 'file:') return false
  try {
    return path.resolve(decodeURIComponent(parsed.pathname)) === path.resolve(ENTRY_FILE)
  } catch { return false }
}

// Blanket guard for every webContents the app ever creates, not just the main
// window — a future popup or devtools-spawned view would otherwise start with
// none of the restrictions applied above.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(async () => {
  await database.init()
  // Sweep rows orphaned by older versions, which deleted an application
  // without its interview prep / status history.
  database.pruneOrphanedRows()
  // Backfill the normalised salary columns for rows saved before they existed,
  // so salary filters and averages cover history rather than only new scans.
  database.backfillSalaryColumns()
  // Rotating daily backup: once on launch, then re-checked periodically so
  // long-running sessions still get one backup per day.
  database.maybeBackup()
  setInterval(() => database.maybeBackup(), 6 * 60 * 60 * 1000)
  // Usage rows are diagnostic; six months is plenty and keeps the file small.
  database.pruneAiUsage(180)
  createWindow()

  // Tray first: createWindow's close handler asks whether a tray exists.
  tray.init({
    getMainWindow: () => mainWindow,
    actions: {
      runScan: () => {
        const blocked = scanStartBlocker()
        if (blocked) { logger.append(`[tray] Scan not started — ${blocked}`); return }
        scheduler.runNow(mainWindow)
      },
      checkInbox: () => { scheduler.runInboxCheck().catch(() => {}) },
    },
  })

  const cfg = configService.load()
  // Reconcile the OS login item with the saved preference — the user may have
  // removed it outside the app, and a stale entry pointing at an old install
  // path is worse than none.
  if (cfg.launchOnLogin) tray.applyLoginItem(true, { startMinimised: cfg.startMinimised })

  scheduler.init(mainWindow)
  if (cfg.mobileApiEnabled) mobileApi.start()
  cloudSync.init().catch(() => {})
  updater.init({
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status)
    },
    busyCheck: () => scheduler.getStatus().running || applicator.isBusy(),
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else tray.showWindow()
  })
})

// With a tray icon the app deliberately outlives its window — that is the
// whole point of background operation. Without one (some Linux desktops, or
// the feature turned off) fall back to the conventional quit-on-close.
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (tray.hasTray() && configService.load().minimizeToTray && !tray.isQuitting()) return
  app.quit()
})

app.on('before-quit', () => {
  tray.beginQuit()
})

// Shut the background services down deliberately rather than letting the
// process die with a scan half-written: stop the cron tasks, cancel any
// in-flight apply, and close the LAN server so the port is released.
app.on('will-quit', () => {
  try { scheduler.stop() } catch { /* shutting down anyway */ }
  try { mobileApi.stop() } catch { /* shutting down anyway */ }
  try { tray.destroy() } catch { /* shutting down anyway */ }
})

// ─── IPC: Config ────────────────────────────────────────────────
ipcMain.handle('config:get', () => configService.load())

// Surfaced in Settings so a config file that failed to parse is reported
// rather than silently appearing as a factory reset.
ipcMain.handle('config:loadError', () => configService.getLoadError())

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
  // Keep the OS login item in step with the setting that claims to control it.
  if (merged.launchOnLogin !== current.launchOnLogin || merged.startMinimised !== current.startMinimised) {
    tray.applyLoginItem(merged.launchOnLogin, { startMinimised: merged.startMinimised })
  }
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

// Full scan state — including how the last scan ended, so a failed scan is
// distinguishable from one that simply found nothing.
ipcMain.handle('automation:scanInfo', () => scheduler.getScanInfo())

// Score distribution from the most recent test scan, plus a recommended
// threshold derived from it.
ipcMain.handle('automation:thresholdAdvice', () => {
  const dry = scheduler.getLastDryRun()
  if (!dry?.scores?.length) return { available: false }
  const scores = dry.scores.map(s => s.score).sort((a, b) => a - b)
  const at = (t) => scores.filter(s => s >= t).length
  // Recommend the highest threshold that still clears a useful number of jobs:
  // aim for roughly the top third of what the scan actually found, so the bar
  // stays selective without starving the daily limit.
  const target = Math.max(1, Math.ceil(scores.length / 3))
  let recommended = 0
  for (let t = 95; t >= 40; t -= 5) {
    if (at(t) >= target) { recommended = t; break }
  }
  return {
    available: true,
    at: dry.at,
    total: scores.length,
    currentThreshold: dry.threshold,
    wouldApply: dry.wouldApply,
    recommended: recommended || dry.threshold,
    median: scores[Math.floor(scores.length / 2)],
    max: scores[scores.length - 1],
    // What each candidate threshold would have yielded on this scan.
    curve: [50, 60, 70, 75, 80, 85, 90].map(t => ({ threshold: t, count: at(t) })),
    scores: dry.scores,
  }
})

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
// `originalPath` arrives from the renderer, so it is untrusted input even
// though the UI only ever sends a path it was handed back by resume:importFile.
// Imported originals always live in CONFIG_DIR/resumes — anything else is
// either a bug or an attempt to read (or launch) an unrelated file, since these
// handlers otherwise hand back arbitrary file contents and call shell.openPath
// on whatever they are given.
function resolveResumeOriginal(originalPath, allowedExts) {
  if (!originalPath || typeof originalPath !== 'string') return null
  const pathMod = require('path')
  const fs = require('fs')
  const resumesDir = pathMod.resolve(configService.CONFIG_DIR, 'resumes')
  const resolved = pathMod.resolve(originalPath)
  // `dir + sep` prefix, not startsWith(dir): "…/resumes-evil" must not pass.
  if (resolved !== resumesDir && !resolved.startsWith(resumesDir + pathMod.sep)) return null
  if (!allowedExts.includes(pathMod.extname(resolved).slice(1).toLowerCase())) return null
  if (!fs.existsSync(resolved)) return null
  return resolved
}

ipcMain.handle('resume:getPDFBase64', async (_, resumeText, originalPath, originalExt) => {
  try {
    const fs = require('fs')
    // If uploaded as PDF, show the original file directly
    const safePdf = originalExt === 'pdf' ? resolveResumeOriginal(originalPath, ['pdf']) : null
    if (safePdf) {
      const base64 = fs.readFileSync(safePdf).toString('base64')
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
    // If the original DOCX is available, open it directly — fastest and most
    // accurate preview. Restricted to imported originals: shell.openPath hands
    // the file to the OS handler, so an unchecked path here is arbitrary
    // program execution, not just an arbitrary read.
    const safeDoc = resolveResumeOriginal(originalPath, ['docx', 'doc'])
    if (safeDoc) {
      await shell.openPath(safeDoc)
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
  const header = [
    'ID', 'Job Title', 'Company', 'Platform', 'Salary', 'Salary Min (annual)', 'Salary Max (annual)',
    'Match Score', 'Match Explanation', 'Status', 'Comment', 'Applied At', 'Closing Date', 'Job URL',
  ]
  const rows = apps.map(a => [
    a.id, a.job_title, a.company, a.platform, a.salary,
    a.salary_min ?? '', a.salary_max ?? '',
    a.match_score, a.match_explanation || '', a.status, a.comment || '',
    a.applied_at, a.closing_date || '', a.job_url,
    // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
    // Job titles and AI-written explanations are untrusted text, so prefix a
    // quote to keep them inert on open.
  ].map(v => {
    const str = String(v ?? '')
    const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str
    return `"${safe.replace(/"/g, '""')}"`
  }).join(','))
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

// ─── IPC: Interview schedule ─────────────────────────────────────
ipcMain.handle('db:getUpcomingInterviews', (_, limit) => database.getUpcomingInterviews(limit || 25))
ipcMain.handle('db:getInterviewEvents', (_, applicationId) => database.getInterviewEvents(applicationId))
ipcMain.handle('db:addInterviewEvent', (_, payload) => {
  try {
    if (!payload?.applicationId || !payload?.scheduledAt) {
      return { success: false, error: 'An application and a date are required.' }
    }
    return database.addInterviewEvent({ ...payload, source: 'manual' })
  } catch (err) {
    return { success: false, error: err.message }
  }
})
ipcMain.handle('db:deleteInterviewEvent', (_, id) => {
  try { return database.deleteInterviewEvent(id) } catch (err) { return { success: false, error: err.message } }
})

// ─── IPC: Interview calendar export (.ics) ───────────────────────
// Pass an eventId to export one interview, or omit it for every upcoming one.
ipcMain.handle('calendar:exportICS', async (_, eventId) => {
  try {
    const { buildCalendar } = require('./services/calendar')
    const events = eventId != null
      ? [database.getInterviewEvent(eventId)].filter(Boolean)
      : database.getUpcomingInterviews(200)
    if (events.length === 0) {
      return { success: false, error: 'No upcoming interviews to export.' }
    }
    const { ics, count } = buildCalendar(events)
    if (count === 0) return { success: false, error: 'No interview had a usable date.' }

    const single = events.length === 1 ? events[0] : null
    const slug = (s) => String(s || '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'interview'
    const defaultPath = single
      ? `hiro-interview-${slug(single.company)}.ics`
      : `hiro-interviews-${new Date().toISOString().slice(0, 10)}.ics`

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Interviews',
      defaultPath,
      filters: [{ name: 'Calendar', extensions: ['ics'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    require('fs').writeFileSync(filePath, ics, 'utf8')
    return { success: true, count, filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Salary analytics ───────────────────────────────────────
ipcMain.handle('analytics:salaryStats', () => database.getSalaryStats())

// ─── IPC: Stale-application sweep (manual trigger) ───────────────
ipcMain.handle('db:sweepStale', () => {
  try { return { success: true, ...scheduler.runStaleSweep() } } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Closing date ───────────────────────────────────────────
ipcMain.handle('db:updateClosingDate', (_, id, closingDate) => {
  try { return database.updateClosingDate(id, closingDate) } catch (err) { return { success: false, error: err.message } }
})

// ─── IPC: Score-band conversion ──────────────────────────────────
ipcMain.handle('analytics:scoreBandConversion', () => database.getScoreBandConversion())

// ─── IPC: Config export / import ─────────────────────────────────
ipcMain.handle('config:export', async (_, passphrase, includeSecrets) => {
  try {
    const bundle = configTransfer.exportBundle(passphrase, { includeSecrets: !!includeSecrets })
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Hiro Settings',
      defaultPath: `hiro-settings-${new Date().toISOString().slice(0, 10)}.hirocfg`,
      filters: [{ name: 'Hiro Config Backup', extensions: ['hirocfg'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    require('fs').writeFileSync(filePath, bundle, 'utf8')
    return { success: true, filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// Held between inspect and confirm so the passphrase is only entered once and
// the decrypted payload never round-trips through the renderer.
let pendingConfigImport = null

// Decrypt and describe a bundle without applying it, so the renderer can show
// the user what they're about to overwrite.
ipcMain.handle('config:inspectImport', async (_, passphrase) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Hiro Settings',
      filters: [{ name: 'Hiro Config Backup', extensions: ['hirocfg', 'json'] }],
      properties: ['openFile'],
    })
    if (canceled || !filePaths.length) return { canceled: true }
    const raw = require('fs').readFileSync(filePaths[0], 'utf8')
    const info = configTransfer.inspectBundle(raw, passphrase)
    pendingConfigImport = info.payload
    return { success: true, createdAt: info.createdAt, includesSecrets: info.includesSecrets, summary: info.summary }
  } catch (err) {
    pendingConfigImport = null
    return { success: false, error: err.message }
  }
})

ipcMain.handle('config:applyImport', () => {
  if (!pendingConfigImport) return { success: false, error: 'Nothing staged — choose a file first.' }
  try {
    const result = configTransfer.applyBundle(pendingConfigImport)
    pendingConfigImport = null
    scheduler.restart(mainWindow)
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

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
// The list view gets slim rows — SELECT * shipped every job description,
// tailored resume and cover letter across IPC on each dashboard load.
ipcMain.handle('db:getApplications', (_, filters) => database.getApplicationsList(filters))
ipcMain.handle('db:getApplicationsFull', (_, filters) => database.getApplications(filters))
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
  } finally {
    scheduler.processQueue().catch(() => {})
  }
})

ipcMain.handle('attention:apply', async (_, jobId) => {
  try {
    const cfg = { ...configService.load(), askQuestion: makeAskQuestion(mainWindow) }
    const result = await applicator.applyAttentionJob(jobId, cfg, attentionLog)
    return result
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    // A manual apply blocks queued scans (it holds the applicator's busy flag).
    // Drain the queue now that it's free, or a scan the phone requested
    // mid-apply would sit until the next scheduled run.
    scheduler.processQueue().catch(() => {})
  }
})

// Retry several Needs Attention jobs in one pass.
ipcMain.handle('attention:applyMany', async (_, jobIds) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return { success: false, reason: 'No jobs selected' }
  }
  try {
    const cfg = { ...configService.load(), askQuestion: makeAskQuestion(mainWindow) }
    return await applicator.applyAttentionJobs(jobIds, cfg, attentionLog)
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    scheduler.processQueue().catch(() => {})
  }
})

function attentionLog(msg) {
  logger.append(`[attention-apply] ${msg}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('attention:log', msg)
  }
}

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
  const result = gmailAuth.clearSession()
  // Inbox check and follow-up are switched off by clearSession — restart so the
  // cron tasks actually stop instead of firing against cleared credentials.
  scheduler.restart(mainWindow)
  return result
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

// ─── IPC: Review queue (review-before-submit) ────────────────────
ipcMain.handle('review:list', () => database.getHeldApplications())

ipcMain.handle('review:approve', async (_, id) => {
  try {
    const cfg = { ...configService.load(), askQuestion: makeAskQuestion(mainWindow) }
    return await applicator.approveHeldApplication(id, cfg, reviewLog)
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    scheduler.processQueue().catch(() => {})
  }
})

ipcMain.handle('review:approveMany', async (_, ids) => {
  if (!Array.isArray(ids) || ids.length === 0) return { success: false, reason: 'No applications selected' }
  try {
    const cfg = { ...configService.load(), askQuestion: makeAskQuestion(mainWindow) }
    return await applicator.approveHeldApplications(ids, cfg, reviewLog)
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    scheduler.processQueue().catch(() => {})
  }
})

ipcMain.handle('review:reject', (_, id) => {
  try { return database.rejectHeldApplication(id) } catch (err) { return { success: false, error: err.message } }
})

function reviewLog(msg) {
  logger.append(`[review] ${msg}`)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('review:log', msg)
}

// ─── IPC: AI usage & cost ────────────────────────────────────────
ipcMain.handle('ai:usage', () => database.getAiUsageSummary())
ipcMain.handle('ai:clearUsage', () => database.clearAiUsage())

// ─── IPC: Resume conversion analytics ────────────────────────────
ipcMain.handle('analytics:resumeConversion', () => database.getResumeConversion())

// ─── IPC: ATS job boards ─────────────────────────────────────────
// Validate a board before saving it, so a typo in the slug is caught here
// rather than as an empty scan three days later.
ipcMain.handle('ats:testBoard', async (_, provider, slug) => {
  try {
    const ats = require('./services/scraper/ats')
    const jobs = await ats.scrape({
      atsBoards: [{ provider, slug, label: slug }],
      jobKeywords: '', jobLocation: '',
    })
    return { success: true, count: jobs.length, sample: jobs.slice(0, 3).map(j => j.job_title) }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC: Updates ────────────────────────────────────────────────
ipcMain.handle('update:status', () => updater.getStatus())
ipcMain.handle('update:check', () => updater.check())
ipcMain.handle('update:download', () => updater.download())
ipcMain.handle('update:install', () => updater.installNow())

// ─── IPC: Background operation ───────────────────────────────────
ipcMain.handle('tray:status', () => ({
  hasTray: tray.hasTray(),
  ...tray.getLoginItem(),
}))

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
