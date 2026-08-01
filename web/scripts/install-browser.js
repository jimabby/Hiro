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

// Locate Playwright's CLI entry point.
//
// This used to be `require.resolve('playwright/cli')`, which stopped resolving
// once Playwright added an "exports" map that doesn't list that subpath — so
// every fresh install printed "Package subpath './cli' is not defined" and
// silently shipped without a browser. Resolving the package's own manifest and
// reading its `bin` field works regardless of the exports map, and follows the
// package if the file is ever renamed again.
function resolvePlaywrightCli() {
  const pkgJsonPath = require.resolve('playwright/package.json')
  const pkgDir = path.dirname(pkgJsonPath)
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))

  const binField = pkg.bin
  const relative = typeof binField === 'string' ? binField : binField?.playwright
  const candidates = [relative, 'cli.js', 'lib/cli/cli.js'].filter(Boolean)

  for (const rel of candidates) {
    const full = path.join(pkgDir, rel)
    if (fs.existsSync(full)) return full
  }
  throw new Error(`could not locate the Playwright CLI inside ${pkgDir}`)
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
    execFileSync(process.execPath, [resolvePlaywrightCli(), 'install', 'chromium'], {
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
