// Download Playwright's Chromium into web/browsers so electron-builder can
// ship it inside the installer.
//
// Playwright normally caches browsers in a per-user directory outside the
// project, which electron-builder never sees. A packaged build therefore
// installed cleanly and then failed every single scrape on the user's machine
// with "Executable doesn't exist" — the app's entire purpose, broken, with no
// way for the user to know that `npx playwright install chromium` was the fix.
//
// Runs on postinstall (so a dev clone is ready) and on prebuild (so a release
// can never be cut without it). Idempotent and quiet when already present.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const BROWSERS_DIR = path.join(__dirname, '..', 'browsers')

function alreadyInstalled() {
  try {
    if (!fs.existsSync(BROWSERS_DIR)) return false
    return fs.readdirSync(BROWSERS_DIR).some(d => d.startsWith('chromium'))
  } catch {
    return false
  }
}

function main() {
  // Opt-out for CI jobs that only run unit tests and don't need a 150 MB
  // download on every install.
  if (process.env.HIRO_SKIP_BROWSER_INSTALL === '1') {
    console.log('[hiro] Skipping Chromium install (HIRO_SKIP_BROWSER_INSTALL=1).')
    return
  }
  if (alreadyInstalled()) {
    console.log('[hiro] Chromium already present in web/browsers — skipping download.')
    return
  }

  console.log('[hiro] Downloading Chromium into web/browsers (one-off, ~150 MB)...')
  try {
    execFileSync(process.execPath, [require.resolve('playwright/cli'), 'install', 'chromium'], {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR },
    })
    console.log('[hiro] Chromium ready.')
  } catch (err) {
    // A failed download must not break `npm install` — the app still runs, it
    // just can't scrape until this succeeds. Say so plainly.
    console.warn(`[hiro] Could not download Chromium: ${err.message}`)
    console.warn('[hiro] Scraping will not work until this succeeds. Retry with:')
    console.warn('[hiro]   npm run --prefix web postinstall')
  }
}

main()
