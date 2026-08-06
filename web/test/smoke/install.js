// Turn a built artifact in dist-electron into a runnable application, the way a
// user's machine would.
//
// Unpacking `win-unpacked/` would be easier, but it would also test something no
// user ever runs. The NSIS installer rewrites paths, the AppImage runs from a
// squashfs mount, and the DMG carries the code signature — all three are places
// a release can break while the unpacked directory works fine.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const OUT_DIR = path.join(__dirname, '..', '..', 'dist-electron')

function findOne(predicate, what) {
  if (!fs.existsSync(OUT_DIR)) {
    throw new Error(`${OUT_DIR} does not exist — run "npm run build:dry" first.`)
  }
  const matches = fs.readdirSync(OUT_DIR).filter(predicate)
  if (matches.length === 0) throw new Error(`No ${what} found in ${OUT_DIR} — run "npm run build:dry" first.`)
  // Newest wins, so a stale artifact from an earlier version is never the one
  // under test.
  matches.sort((a, b) =>
    fs.statSync(path.join(OUT_DIR, b)).mtimeMs - fs.statSync(path.join(OUT_DIR, a)).mtimeMs)
  return path.join(OUT_DIR, matches[0])
}

const run = (file, args, opts = {}) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

// ── Windows: NSIS silent install ─────────────────────────────────
function installWindows(target) {
  const installer = findOne(f => /\.exe$/i.test(f) && /setup/i.test(f), 'Windows installer')
  // /S is NSIS silent mode. /D must be the LAST argument, must be absolute, and
  // must NOT be quoted — NSIS takes the rest of the command line verbatim, so a
  // quoted path installs into a directory whose name contains quote characters.
  run(installer, ['/S', `/D=${target}`])

  const exe = path.join(target, 'Hiro.exe')
  if (!fs.existsSync(exe)) {
    throw new Error(`Installer finished but ${exe} is missing. Contents: ${fs.readdirSync(target).join(', ')}`)
  }
  return { executablePath: exe, installer }
}

// ── Linux: AppImage self-extraction ──────────────────────────────
function installLinux(target) {
  const image = findOne(f => /\.AppImage$/i.test(f), 'AppImage')
  fs.chmodSync(image, 0o755)
  // FUSE is usually unavailable in CI containers, so extract rather than mount.
  run(image, ['--appimage-extract'], { cwd: target })
  const root = path.join(target, 'squashfs-root')

  // The executable name is derived from productName and has changed shape
  // between electron-builder versions; the .desktop file is the artifact that
  // authoritatively names it.
  const desktop = fs.readdirSync(root).find(f => f.endsWith('.desktop'))
  let exeName = null
  if (desktop) {
    const exec = fs.readFileSync(path.join(root, desktop), 'utf8').match(/^Exec=([^\s%]+)/m)
    if (exec) exeName = path.basename(exec[1])
  }
  const candidates = [exeName, 'hiro', 'Hiro', 'AppRun'].filter(Boolean)
  const exe = candidates.map(n => path.join(root, n)).find(p => fs.existsSync(p))
  if (!exe) {
    throw new Error(`No executable found in ${root}. Contents: ${fs.readdirSync(root).join(', ')}`)
  }
  fs.chmodSync(exe, 0o755)
  return { executablePath: exe, installer: image }
}

// ── macOS: mount the DMG and copy the app out ────────────────────
function installMac(target) {
  const dmg = findOne(f => /\.dmg$/i.test(f), 'DMG')
  const mount = path.join(target, 'mnt')
  fs.mkdirSync(mount, { recursive: true })
  run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount])
  try {
    const app = fs.readdirSync(mount).find(f => f.endsWith('.app'))
    if (!app) throw new Error(`No .app inside ${dmg}`)
    // -R preserves the signature; a plain file copy invalidates it.
    run('cp', ['-R', path.join(mount, app), target])
    const exe = path.join(target, app, 'Contents', 'MacOS', 'Hiro')
    if (!fs.existsSync(exe)) throw new Error(`Copied ${app} but ${exe} is missing.`)
    return { executablePath: exe, installer: dmg }
  } finally {
    // Always detach: a left-behind mount fails every later run on the machine.
    try { run('hdiutil', ['detach', mount, '-force']) } catch { /* already gone */ }
  }
}

function install(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const byPlatform = { win32: installWindows, linux: installLinux, darwin: installMac }
  const installer = byPlatform[process.platform]
  if (!installer) throw new Error(`No installer strategy for ${process.platform}`)
  return installer(targetDir)
}

module.exports = { install, OUT_DIR }
