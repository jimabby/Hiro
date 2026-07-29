// Auto-update via electron-updater.
//
// Without this there is no route to ship a fix to an installed copy — every
// user stays on whatever build they first downloaded. Deliberately not silent:
// download happens on the user's say-so, and an update is never installed out
// from under a running scan.

const configService = require('./config')

let autoUpdater = null
try {
  ({ autoUpdater } = require('electron-updater'))
} catch {
  // Dependency not installed — the app runs fine, update checks report as
  // unavailable rather than crashing on launch.
}

let state = {
  available: !!autoUpdater,
  checking: false,
  updateAvailable: false,
  downloading: false,
  downloaded: false,
  version: null,
  releaseNotes: null,
  progress: 0,
  error: null,
  lastCheckedAt: null,
}

let notify = () => {}
let isBusy = () => false

function getStatus() {
  const { app } = require('electron')
  return { ...state, currentVersion: app.getVersion() }
}

function push() {
  try { notify(getStatus()) } catch { /* renderer may be gone */ }
}

function init({ onStatus, busyCheck } = {}) {
  if (!autoUpdater) return
  notify = onStatus || notify
  isBusy = busyCheck || isBusy

  // Downloading is opt-in per check; installing is always explicit. An update
  // that restarts the app mid-scan would abandon a half-submitted application.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    state = { ...state, checking: false, downloading: false, error: err?.message || String(err) }
    push()
  })
  autoUpdater.on('update-available', (info) => {
    state = {
      ...state,
      checking: false,
      updateAvailable: true,
      version: info?.version || null,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      error: null,
    }
    push()
  })
  autoUpdater.on('update-not-available', () => {
    state = { ...state, checking: false, updateAvailable: false, error: null }
    push()
  })
  autoUpdater.on('download-progress', (p) => {
    state = { ...state, downloading: true, progress: Math.round(p?.percent || 0) }
    push()
  })
  autoUpdater.on('update-downloaded', (info) => {
    state = {
      ...state,
      downloading: false,
      downloaded: true,
      progress: 100,
      version: info?.version || state.version,
    }
    push()
  })

  const cfg = configService.load()
  if (cfg.autoCheckUpdates !== false) {
    // Once shortly after launch, then daily. Checking is a HEAD request for a
    // manifest — cheap enough that a daily cadence costs nothing.
    setTimeout(() => { check().catch(() => {}) }, 30_000).unref?.()
    setInterval(() => { check().catch(() => {}) }, 24 * 60 * 60 * 1000).unref?.()
  }
}

async function check() {
  const { app } = require('electron')
  if (!autoUpdater) return { ...getStatus(), error: 'Updates are not available in this build.' }
  if (!app.isPackaged) {
    state = { ...state, checking: false, error: null, lastCheckedAt: new Date().toISOString() }
    return { ...getStatus(), available: false, error: 'Updates apply to the installed app only.' }
  }
  state = { ...state, checking: true, error: null }
  push()
  try {
    await autoUpdater.checkForUpdates()
    state = { ...state, lastCheckedAt: new Date().toISOString() }
  } catch (err) {
    state = { ...state, checking: false, error: err.message }
  }
  push()
  return getStatus()
}

async function download() {
  if (!autoUpdater) return { success: false, error: 'Updates are not available in this build.' }
  if (!state.updateAvailable) return { success: false, error: 'No update to download.' }
  state = { ...state, downloading: true, progress: 0, error: null }
  push()
  try {
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (err) {
    state = { ...state, downloading: false, error: err.message }
    push()
    return { success: false, error: err.message }
  }
}

// Restart into the new version. Refuses while a scan or apply is running —
// quitting mid-submission would leave an application half-sent with no record
// of whether it went through.
function installNow() {
  if (!autoUpdater) return { success: false, error: 'Updates are not available in this build.' }
  if (!state.downloaded) return { success: false, error: 'Download the update first.' }
  if (isBusy()) {
    return { success: false, error: 'A scan or apply is running — wait for it to finish, or cancel it, before restarting.' }
  }
  setImmediate(() => {
    try {
      require('./tray').beginQuit()
    } catch { /* tray may not be initialised */ }
    autoUpdater.quitAndInstall(false, true)
  })
  return { success: true }
}

module.exports = { init, check, download, installNow, getStatus }
