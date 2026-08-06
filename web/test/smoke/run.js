// Release smoke test: install the packaged app and drive it.
//
// The 25 unit suites cover the services thoroughly and still could not see the
// bug that broke reload in packaged Windows builds — because nothing they run
// is packaged, and nothing they run is a renderer. This is the layer that
// catches that class of failure: a real installer, a real Electron main
// process, a real preload bridge, a real SQLite file on disk.
//
// Nothing here touches the network or the user's own profile:
//   • HIRO_CONFIG_DIR points the whole app at a throwaway directory.
//   • The job source and the AI adapter are replaced at runtime, in the main
//     process, through the module cache. No test-only branch exists in shipped
//     code for this — see mockExternals().
//
// Run locally:  npm run build:dry && npm run smoke

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { install } = require('./install')

// Electron needs a display. Re-exec under xvfb-run rather than failing with an
// unhelpful "Missing X server" from deep inside Chromium.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.HIRO_SMOKE_XVFB) {
  const xvfb = spawnSync('xvfb-run', ['--auto-servernum', process.execPath, __filename], {
    stdio: 'inherit',
    env: { ...process.env, HIRO_SMOKE_XVFB: '1' },
  })
  if (xvfb.error) {
    console.error('No DISPLAY and xvfb-run is unavailable. Install xvfb or run with a display.')
    process.exit(1)
  }
  process.exit(xvfb.status ?? 1)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-smoke-'))
const INSTALL_DIR = path.join(TMP, 'app')
const PROFILE_DIR = path.join(TMP, 'profile')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
function note(msg) { console.log(`      ${msg}`) }

// A profile that is already set up, so the app opens on the dashboard rather
// than the setup wizard, and a scan is allowed to start. The AI key is a dummy:
// every AI call is replaced before a scan runs.
const PROFILE = {
  setupComplete: true,
  aiProvider: 'claude',
  aiApiKey: 'smoke-test-not-a-real-key',
  masterResume: 'Jane Smoke\nSenior Platform Engineer\n10 years of Node.js, Postgres and Kubernetes.',
  jobKeywords: 'platform engineer',
  jobLocation: '',
  matchThreshold: 50,
  // Only the ATS source is enabled: it is the one scraper that needs no browser
  // and no login, so a scan exercises scrape → score → tailor → persist without
  // launching Chromium.
  enableSeek: false,
  enableIndeed: false,
  enableLinkedIn: false,
  enableAtsBoards: true,
  atsBoards: [{ provider: 'greenhouse', slug: 'smoketest', label: 'Smoke Test Co' }],
  dailyLimitAts: 10,
  // Everything that would reach the outside world, or the user's own machine.
  mobileApiEnabled: false,
  enableInboxCheck: false,
  enableFollowUp: false,
  enableWeeklyReport: false,
  enableSmartScheduling: false,
  minimizeToTray: false,
  launchOnLogin: false,
  reviewMode: false,
}

// Replace the two external boundaries — the job source and the model — in the
// RUNNING main process. `applicator` looks both up as properties on the module
// object at call time (`scraper.scrape(cfg)`, `aiAdapter.tailorResume(...)`), so
// reassigning those properties is enough; the scan pipeline itself is untouched
// and entirely real.
//
// The module objects are taken out of require.cache rather than re-required, so
// there is no chance of loading a second copy under a differently-spelled path
// and patching something the app is not using.
async function mockExternals(electronApp) {
  return electronApp.evaluate(async () => {
    // `require` is not in scope inside an evaluated function, even though this
    // runs in the main process. process.mainModule.require is, and it resolves
    // relative to the app's own entry point — which is exactly the resolution
    // context needed to reach the loaded service modules.
    const req = process.mainModule.require.bind(process.mainModule)
    const path = req('path')
    // Module._cache IS require.cache; going through it means there is no chance
    // of loading a second copy under a differently-spelled path and patching
    // something the app is not actually using.
    const cache = req('module')._cache

    const find = (suffix) => {
      const key = Object.keys(cache).find(p => p.endsWith(path.join(...suffix)))
      if (!key) throw new Error(`${suffix.join('/')} is not loaded — the app changed shape`)
      return cache[key].exports
    }

    const ats = find(['services', 'scraper', 'ats.js'])
    const ai = find(['services', 'ai', 'index.js'])

    const jobs = [
      {
        job_title: 'Senior Platform Engineer',
        company: 'Smoke Test Co',
        salary: '$180,000 - $210,000',
        job_url: 'https://smoke.example/jobs/1',
        _description: 'We need a platform engineer with Node.js, Postgres and Kubernetes experience.',
        _provider: 'Greenhouse',
      },
      {
        job_title: 'Staff Infrastructure Engineer',
        company: 'Smoke Test Co',
        salary: '',
        job_url: 'https://smoke.example/jobs/2',
        _description: 'Terraform, AWS and a large Kubernetes estate.',
        _provider: 'Greenhouse',
      },
    ]

    ats.scrape = async () => {
      // primeDescriptions is the real one, so the description hand-off between
      // scrape and the applicator is still under test.
      ats.primeDescriptions(jobs)
      return jobs.map(j => ({ ...j }))
    }

    ai.scoreMatchWithExplanation = async () => ({ score: 91, explanation: 'Strong overlap on Node.js and Kubernetes.' })
    ai.tailorResume = async () => 'Jane Smoke — tailored for platform engineering.'
    ai.generateCoverLetter = async () => 'Dear Smoke Test Co, I would like to apply.'
    ai.generateTalkingPoints = async () => '- Ran a 200-node Kubernetes estate\n- Cut deploy time by 60%'
    return true
  })
}

async function main() {
  console.log(`Installing the packaged app into ${INSTALL_DIR}`)
  const { executablePath, installer } = install(INSTALL_DIR)
  note(`installer: ${path.basename(installer)}`)
  note(`executable: ${executablePath}`)

  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROFILE_DIR, 'config.json'), JSON.stringify(PROFILE, null, 2))

  // ELECTRON_RUN_AS_NODE turns any Electron binary into a bare Node interpreter,
  // and editors set it for the processes they spawn — VS Code's extension host
  // exports it, so `npm run smoke` from an integrated terminal inherits it and the
  // packaged app rejects every Chromium switch as a "bad option" before main.js
  // ever runs. NODE_OPTIONS is stripped for the same reason.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const { _electron: electron } = require('playwright')
  const electronApp = await electron.launch({
    executablePath,
    env: {
      ...env,
      HIRO_CONFIG_DIR: PROFILE_DIR,
      // Nothing in this run should reach a real service.
      HIRO_SKIP_BROWSER_INSTALL: '1',
    },
    timeout: 120_000,
  })

  // A main-process crash is otherwise reported as a mysterious timeout.
  const stderr = []
  electronApp.process().stderr?.on('data', d => stderr.push(d.toString()))

  try {
    // ── Startup ────────────────────────────────────────────────
    const page = await electronApp.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    check('a window opens', true, true)

    // The packaged app must load its own entry file, not the dev server and not
    // anything else on disk.
    const startUrl = page.url()
    note(`entry URL: ${startUrl}`)
    check('entry URL is a file: URL', startUrl.startsWith('file://'), true)
    check('entry URL is the packaged index.html', /\/dist\/index\.html$/.test(new URL(startUrl).pathname), true)

    // ── The renderer actually rendered ─────────────────────────
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 })
    check('the app shell renders', await page.locator('[data-testid="app-shell"]').count(), 1)
    // setupComplete is true in the profile, so the dashboard must be reachable
    // — if the preload bridge were broken, App would still be waiting on
    // getConfig() and the nav would never appear.
    await page.waitForSelector('[data-testid="nav-dashboard"]', { timeout: 30_000 })
    check('the preload bridge answered getConfig', await page.locator('[data-testid="nav"]').count(), 1)

    // ── Renderer-initiated navigation to the entry point ───────
    // This is the packaged-Windows regression. The navigation guard compared a
    // file: URL's pathname ("/C:/Program Files/...") against a resolved
    // filesystem path, which on Windows produced "C:\C:\Program Files\..." and
    // matched nothing — so will-navigate refused to let the app reach its own
    // entry file. Any URL naming the entry file must be allowed through.
    const navTarget = `${startUrl.split('#')[0]}?smoke=nav`
    await page.evaluate((u) => { window.location.href = u }, navTarget)
    let navAllowed = true
    try {
      await page.waitForURL(u => u.toString().includes('smoke=nav'), { timeout: 15_000 })
    } catch {
      navAllowed = false
    }
    check('navigation to the entry point is allowed', navAllowed, true)

    // A plain reload has to survive too.
    await page.reload({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="nav-dashboard"]', { timeout: 30_000 })
    check('the app survives a reload', await page.locator('[data-testid="app-shell"]').count(), 1)

    // ── Navigation the guard must still refuse ─────────────────
    // The guard exists to stop the privileged renderer being pointed at an
    // arbitrary local file. Prove it is still doing that in the packaged build.
    const secretPath = path.join(PROFILE_DIR, 'smoke-secret.txt')
    fs.writeFileSync(secretPath, 'this must never be reachable from the renderer')
    const secretUrl = require('url').pathToFileURL(secretPath).href
    await page.evaluate((u) => { window.location.href = u }, secretUrl)
    let blocked = true
    try {
      await page.waitForURL(u => u.toString().includes('smoke-secret'), { timeout: 5_000 })
      blocked = false
    } catch { /* expected: the navigation was prevented */ }
    check('navigation to an arbitrary local file is refused', blocked, true)

    // A navigation the main process vetoed leaves the renderer with a pending
    // request that Playwright keeps waiting on, so every later click would time
    // out on "waiting for navigation to finish". Reload to clear it.
    await page.reload({ timeout: 30_000 })
    await page.waitForSelector('[data-testid="nav-dashboard"]', { timeout: 30_000 })

    // ── The database opens ─────────────────────────────────────
    const stats = await page.evaluate(() => window.api.getStats())
    check('getStats returns a shape the dashboard can render',
      typeof stats?.totalAllTime === 'number' && Array.isArray(stats?.byStatus), true)
    const dbFile = path.join(PROFILE_DIR, 'autoapply.db')
    check('the SQLite file was created in the profile directory', fs.existsSync(dbFile), true)
    check('the SQLite file is a real database',
      fs.readFileSync(dbFile).subarray(0, 15).toString(), 'SQLite format 3')

    // ── One mocked scan, end to end ────────────────────────────
    await mockExternals(electronApp)
    const started = await page.evaluate(() => window.api.startAutomation())
    check('the scan starts', started?.success, true)

    // startAutomation is fire-and-forget; the status flag is the completion
    // signal. 3 minutes is generous — the scan does no I/O beyond SQLite.
    const deadline = Date.now() + 180_000
    let status = null
    do {
      await page.waitForTimeout(500)
      status = await page.evaluate(() => window.api.getAutomationStatus())
    } while (status?.running && Date.now() < deadline)
    check('the scan finishes', status?.running, false)

    // ATS boards cannot be auto-submitted, so a match is filed under Needs
    // Attention with its documents already drafted. Two fixture jobs in, two
    // rows out — which means scrape, score, tailor, cover letter and the
    // database write all ran.
    const attention = await page.evaluate(() => window.api.getAttentionJobs())
    if (attention.length !== 2) {
      // Without the log, "0 rows" is an unexplained failure; with it, the reason
      // the scan rejected the fixtures is right there.
      const why = await page.evaluate(() => window.api.getRecentLogs())
      note(`scan log:\n${(Array.isArray(why) ? why : [why]).slice(-25).join('\n')}`)
    }
    check('the scan produced one row per matched job', attention.length, 2)
    const first = attention.find(a => a.job_title === 'Senior Platform Engineer')
    check('the matched job was scored', first?.match_score, 91)
    check('the salary range was normalised', [first?.salary_min, first?.salary_max], [180000, 210000])
    check('talking points were drafted', (first?.talking_points || '').includes('Kubernetes'), true)

    // The scan is also expected to have written a log the user can read.
    const logs = await page.evaluate(() => window.api.getRecentLogs())
    const logText = Array.isArray(logs) ? logs.join('\n') : String(logs || '')
    check('the scan was logged', /Scan complete/.test(logText), true)

    // ── Every page renders ─────────────────────────────────────
    // Clicking through the nav is the cheapest way to catch a render crash: a
    // page that throws leaves React with an empty tree, and no unit test in this
    // repo mounts a component. The Needs Attention page now has real rows in it
    // from the scan above, so it is exercised with data rather than empty.
    for (const tab of ['pipeline', 'review', 'attention', 'timeline', 'analytics', 'settings', 'dashboard']) {
      await page.click(`[data-testid="nav-${tab}"]`)
      // The shell surviving the click is the assertion: an exception during
      // render unmounts everything below it.
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 })
      const rendered = await page.evaluate(() => ({
        shell: !!document.querySelector('[data-testid="app-shell"]'),
        // React replaces <main> content per page; empty means the page threw.
        main: (document.querySelector('main')?.textContent || '').trim().length,
      }))
      check(`the ${tab} page renders`, [rendered.shell, rendered.main > 0], [true, true])
    }

    // ── The pipeline board, driven through the UI ──────────────
    // The scan above filed its matches under Needs Attention (ATS boards cannot
    // be auto-submitted), so the board itself has nothing on it. Insert a
    // submitted application through the main process, then use the real UI to
    // book a follow-up on it — which exercises the IPC round trip, the date
    // handling, and the board's own re-read.
    await electronApp.evaluate(async ({ app }) => {
      const req = process.mainModule.require.bind(process.mainModule)
      const path = req('path')
      const cache = req('module')._cache
      const key = Object.keys(cache).find(p => p.endsWith(path.join('services', 'database.js')))
      const database = cache[key].exports
      database.insertApplication({
        job_title: 'Smoke Pipeline Role',
        company: 'Pipeline Co',
        platform: 'Seek',
        salary: '',
        job_url: 'https://smoke.example/pipeline/1',
        job_description: '',
        match_score: 80,
        match_explanation: '',
        tailored_resume: '',
        screening_qa: [],
        status: 'applied',
        closing_date: null,
      })
      return app.getVersion()
    })

    await page.click('[data-testid="nav-pipeline"]')
    await page.click('[data-testid="pipeline"] >> text=Refresh')
    await page.waitForSelector('[data-testid="pipeline-stage-applied"]', { timeout: 15_000 })
    const card = page.locator('[data-testid="pipeline-stage-applied"]').getByText('Smoke Pipeline Role')
    check('a submitted application appears on the board', await card.count(), 1)

    await page.click('[data-testid="pipeline-stage-applied"] >> text=Set next action')
    await page.fill('[data-testid="pipeline-stage-applied"] input[placeholder^="What needs doing"]', 'Chase the recruiter')
    await page.click('[data-testid="pipeline-stage-applied"] >> text=Next week')
    await page.click('[data-testid="pipeline-stage-applied"] >> text=Save')

    // The board re-reads from the main process after saving, so seeing the note
    // means the whole round trip worked, not just that local state changed.
    await page.waitForSelector('[data-testid="pipeline"] >> text=Chase the recruiter', { timeout: 15_000 })
    check('the follow-up shows on the card',
      await page.locator('[data-testid="pipeline"]').getByText('Chase the recruiter').count(), 1)

    // And it is genuinely persisted, as a local YYYY-MM-DD a week out.
    const stored = await page.evaluate(async () => {
      const rows = await window.api.getApplications({})
      const row = rows.find(r => r.job_title === 'Smoke Pipeline Role')
      return { at: row?.next_action_at, note: row?.next_action_note }
    })
    const weekOut = (() => {
      const d = new Date()
      d.setDate(d.getDate() + 7)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })()
    check('the follow-up date was persisted as a local date', stored.at, weekOut)
    check('and so was the note', stored.note, 'Chase the recruiter')

    // Clicking a card opens that application on the Dashboard, which is the
    // cross-page navigation the board depends on.
    await page.click('[data-testid="pipeline"] >> text=Smoke Pipeline Role')
    await page.waitForSelector('[data-testid="nav-dashboard"]', { timeout: 15_000 })

    // Every page stays mounted behind `display: none` so background work survives
    // a tab switch, so a plain text match would find the Pipeline's own (hidden)
    // copy of this title. Only a VISIBLE match means the dashboard opened it.
    const visibleTitles = async () => page.locator('text=Smoke Pipeline Role').evaluateAll(
      els => els.filter(el => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null)).length
    )
    for (let i = 0; i < 30 && await visibleTitles() === 0; i++) await page.waitForTimeout(200)
    check('clicking a card opens the application on the dashboard',
      await visibleTitles() > 0, true)

    // ── Nothing crashed on the way ─────────────────────────────
    // Chromium is noisy on CI; only genuine JS failures matter here.
    const fatal = stderr.join('').split('\n')
      .filter(l => /Uncaught|Unhandled|FATAL/i.test(l))
    if (fatal.length) note(`stderr:\n${fatal.join('\n')}`)
    check('no uncaught errors in the main process', fatal.length, 0)
  } finally {
    await electronApp.close().catch(() => {})
  }
}

main()
  .then(() => {
    console.log(failures === 0
      ? '\n✓ Packaged smoke test passed.'
      : `\n✗ ${failures} smoke check(s) failed.`)
    process.exitCode = failures === 0 ? 0 : 1
  })
  .catch(err => {
    console.error(`\n✗ Smoke test could not run: ${err.stack || err.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    // Best effort — a Windows installer can hold a handle open for a moment
    // after the process exits, and failing cleanup must not fail the run.
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }) } catch { /* leave it for the OS */ }
  })
