// The scheduled portable export: an encrypted copy of the job search written
// into a folder on a schedule, keeping the newest N.
//
// What matters is that it runs when due and not otherwise, that what it writes
// opens with the passphrase and nothing else, that rotation only ever removes
// its own files, and that a failure is reported and retried rather than
// silently pushing the schedule a week out.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-sched-export-'))
const OUT = path.join(TMP, 'exports')
fs.mkdirSync(OUT)
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let cfg = {}
stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => ({ ...cfg }),
    update: (patch) => { cfg = typeof patch === 'function' ? patch({ ...cfg }) : { ...cfg, ...patch }; return cfg },
  },
  './logger': { append: () => {} },
})

const db = service('database')
const transfer = service('dataTransfer')
const { check, done } = createChecker()
const PASS = 'a long enough passphrase'
const at = (iso) => new Date(iso)
const files = () => fs.readdirSync(OUT).filter(n => n.startsWith(transfer.SCHEDULED_PREFIX)).sort()

;(async () => {
  await db.init()
  db.insertApplication({ job_title: 'Engineer', company: 'Acme', platform: 'Seek', job_url: 'https://x/1', tailored_resume: 'SECRET RESUME', status: 'applied' })

  // ── Configuration is validated ───────────────────────────────────
  check('enabling needs a folder', transfer.configureScheduledExport({ enabled: true, folder: '' }).success, false)
  check('the folder must exist', transfer.configureScheduledExport({ enabled: true, folder: path.join(TMP, 'nope'), passphrase: PASS }).success, false)
  check('enabling needs a passphrase', transfer.configureScheduledExport({ enabled: true, folder: OUT }).success, false)
  check('a short passphrase is refused', transfer.configureScheduledExport({ enabled: true, folder: OUT, passphrase: 'short' }).success, false)
  const saved = transfer.configureScheduledExport({ enabled: true, folder: OUT, frequency: 'daily', keep: 2, passphrase: PASS })
  check('a complete schedule is saved', saved.success, true)
  check('the passphrase lives in the config secret', cfg.scheduledExportPassphrase, PASS)
  check('the status never hands the passphrase to the renderer', JSON.stringify(saved).includes(PASS), false)
  check('it says one is set', saved.hasPassphrase, true)
  const again = transfer.configureScheduledExport({ frequency: 'daily', keep: 2, enabled: true, folder: OUT })
  check('changing the schedule keeps the stored passphrase', [again.success, cfg.scheduledExportPassphrase], [true, PASS])

  // ── Runs when due, and only then ─────────────────────────────────
  let r = transfer.maybeRunScheduledExport({ now: at('2026-10-01T03:00:00Z') })
  check('the first check runs an export', [r.ran, r.success], [true, true])
  check('one file is written', files().length, 1)
  const text = fs.readFileSync(path.join(OUT, files()[0]), 'utf8')
  check('the file is encrypted', text.includes('SECRET RESUME'), false)
  check('and opens with the passphrase', transfer.readBundle(text, PASS).bundle.data.applications.length, 1)
  check('and not without it', transfer.readBundle(text, 'wrong passphrase').ok, false)

  r = transfer.maybeRunScheduledExport({ now: at('2026-10-01T20:00:00Z') })
  check('not again before a day has passed', r.ran, false)
  transfer.maybeRunScheduledExport({ now: at('2026-10-02T04:00:00Z') })
  transfer.maybeRunScheduledExport({ now: at('2026-10-03T05:00:00Z') })

  // ── Rotation keeps the newest N, and only its own files ─────────
  fs.writeFileSync(path.join(OUT, 'my-notes.txt'), 'not ours')
  fs.writeFileSync(path.join(OUT, 'hiro-data-2026-01-01.hirodata'), 'a manual export')
  transfer.maybeRunScheduledExport({ now: at('2026-10-04T06:00:00Z') })
  check('only the newest two scheduled files are kept', files().length, 2)
  check('they are the newest ones', files().every(n => n.includes('2026-10-03') || n.includes('2026-10-04')), true)
  check('an unrelated file in the folder is untouched', fs.existsSync(path.join(OUT, 'my-notes.txt')), true)
  check('a manual export in the folder is untouched', fs.existsSync(path.join(OUT, 'hiro-data-2026-01-01.hirodata')), true)

  // ── Weekly ───────────────────────────────────────────────────────
  transfer.configureScheduledExport({ enabled: true, folder: OUT, frequency: 'weekly', keep: 2 })
  check('weekly waits a week', transfer.maybeRunScheduledExport({ now: at('2026-10-08T06:00:00Z') }).ran, false)
  check('and then runs', transfer.maybeRunScheduledExport({ now: at('2026-10-11T07:00:00Z') }).ran, true)

  // ── A failure is reported and retried, not skipped for a week ───
  fs.rmSync(OUT, { recursive: true, force: true })
  r = transfer.maybeRunScheduledExport({ now: at('2026-10-19T08:00:00Z') })
  check('a missing folder fails the run', r.success, false)
  check('the failure is recorded for Settings', cfg.scheduledExportLastResult.success, false)
  check('it does not count as the last export', cfg.scheduledExportLastRunAt, '2026-10-11T07:00:00.000Z')
  fs.mkdirSync(OUT)
  check('the next hourly check retries it', transfer.maybeRunScheduledExport({ now: at('2026-10-19T09:00:00Z') }).success, true)

  // ── Off means off ───────────────────────────────────────────────
  transfer.configureScheduledExport({ enabled: false })
  check('a disabled schedule never runs', transfer.maybeRunScheduledExport({ now: at('2027-01-01T00:00:00Z') }).ran, false)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
