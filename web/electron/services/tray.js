// System tray, background operation, and launch-on-login.
//
// Every scheduled feature in this app — the daily scan, inbox checks,
// follow-ups, the stale sweep, cloud sync — only runs while the process is
// alive. But `window-all-closed` quit the app on Windows and Linux, so closing
// the window stopped all of it. "Applies to jobs while you sleep" required
// leaving a window open all night, which nobody does.
//
// With this, closing the window hides it to the tray and the schedulers keep
// running. Quit is an explicit choice from the tray menu or Cmd/Ctrl+Q.

const path = require('path')
const { app, Tray, Menu, nativeImage } = require('electron')

let tray = null
let getWindow = () => null
let quitting = false

// Distinguishes "the user closed the window" (hide) from "the app is really
// shutting down" (let the window close). Read by the close handler in main.
function isQuitting() {
  return quitting
}

function beginQuit() {
  quitting = true
}

function trayIcon() {
  // The tray wants a small icon; the 256px app logo renders as a blurry blob
  // at 16px on Windows, so resize rather than hand it the full-size image.
  const file = path.join(__dirname, '..', '..', 'public', 'icon-256.png')
  try {
    const img = nativeImage.createFromPath(file)
    if (img.isEmpty()) return undefined
    return img.resize({ width: 16, height: 16 })
  } catch {
    return undefined
  }
}

function showWindow() {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function buildMenu(actions) {
  return Menu.buildFromTemplate([
    { label: 'Open Hiro', click: showWindow },
    { type: 'separator' },
    {
      label: 'Run scan now',
      click: () => { actions.runScan?.() },
    },
    {
      label: 'Check inbox now',
      click: () => { actions.checkInbox?.() },
    },
    { type: 'separator' },
    {
      label: 'Quit Hiro',
      click: () => {
        beginQuit()
        app.quit()
      },
    },
  ])
}

function init({ getMainWindow, actions = {} }) {
  getWindow = getMainWindow
  if (tray) return tray
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip('Hiro — job applications running in the background')
    tray.setContextMenu(buildMenu(actions))
    // Clicking the icon should open the window on Windows/Linux; on macOS the
    // menu is the expected interaction, so only wire the platforms where a
    // plain click is conventional.
    if (process.platform !== 'darwin') {
      tray.on('click', showWindow)
    }
  } catch {
    // A tray is unavailable on some Linux desktops. Without it the app must
    // NOT keep running invisibly with no way to get back to it — main falls
    // back to quitting on window close when this returns null.
    tray = null
  }
  return tray
}

function setTooltip(text) {
  try { tray?.setToolTip(text) } catch { /* tray may be gone */ }
}

function destroy() {
  try { tray?.destroy() } catch { /* ignore */ }
  tray = null
}

function hasTray() {
  return !!tray
}

// Launch on login. Uses Electron's own API so it writes the right thing per
// platform (registry Run key, LaunchAgent, autostart .desktop file).
function applyLoginItem(enabled, { startMinimised = false } = {}) {
  try {
    // Not meaningful for an unpackaged dev run — it would register the
    // electron binary rather than Hiro.
    if (!app.isPackaged) return { success: false, error: 'Available in the installed app only.' }
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: !!startMinimised,
      args: startMinimised ? ['--hidden'] : [],
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getLoginItem() {
  try {
    if (!app.isPackaged) return { openAtLogin: false, available: false }
    const s = app.getLoginItemSettings()
    return { openAtLogin: !!s.openAtLogin, openAsHidden: !!s.openAsHidden, available: true }
  } catch {
    return { openAtLogin: false, available: false }
  }
}

module.exports = {
  init, destroy, hasTray, setTooltip, showWindow,
  isQuitting, beginQuit, applyLoginItem, getLoginItem,
}
