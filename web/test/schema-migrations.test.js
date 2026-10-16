// Versioned schema upgrades.
//
// The old upgrade path was ~80 `try { ALTER … } catch {}` statements on every
// launch, which could not tell "already there" from a real failure. These pin
// the replacement: a database at any earlier version reaches the current one,
// an existing database that already has every column is adopted without
// error, the version only moves when a step finishes, and a failing step
// surfaces instead of leaving a half-upgraded schema behind.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-schema-'))
process.on('exit', () => { try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }) } catch {} })
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()
const DB_FILE = path.join(CONFIG_DIR, 'autoapply.db')

// Edit the file on disk with a second sql.js connection, as a different build
// of the app would have left it.
async function rewrite(fn) {
  const SQL = await require('sql.js')()
  const raw = new SQL.Database(fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : undefined)
  fn(raw)
  fs.writeFileSync(DB_FILE, Buffer.from(raw.export()))
  raw.close()
}
async function inspect(fn) {
  const SQL = await require('sql.js')()
  const raw = new SQL.Database(fs.readFileSync(DB_FILE))
  try { return fn(raw) } finally { raw.close() }
}
const versionOf = (raw) => raw.exec('PRAGMA user_version')[0].values[0][0]
const columns = (raw, table) => raw.exec(`PRAGMA table_info("${table}")`)[0].values.map(r => r[1])

;(async () => {
  // ── A pre-versioning database: base tables only, user_version 0 ──
  // This is roughly what the very first release wrote: the CREATE TABLE
  // statements without any of the columns added later.
  await rewrite(raw => {
    raw.run(`CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_title TEXT NOT NULL, company TEXT NOT NULL,
      platform TEXT NOT NULL, salary TEXT, job_url TEXT, job_description TEXT, match_score INTEGER,
      tailored_resume TEXT, screening_qa TEXT, status TEXT DEFAULT 'applied',
      applied_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      follow_up_sent INTEGER DEFAULT 0)`)
    raw.run(`INSERT INTO applications (job_title, company, platform, follow_up_sent, applied_at)
             VALUES ('Old', 'Co', 'Seek', 1, '2026-10-16T05:00:00+00:00')`)
  })
  await db.init()
  check('an old database reaches the current version', db.getSchemaVersion(), db.SCHEMA_VERSION)
  const upgraded = db.getApplication(1)
  check('its later columns exist', 'experiment_arm' in upgraded && 'cloud_id' in upgraded && 'checklist' in upgraded, true)
  check('a backfill ran on the launch that added its column', upgraded.follow_up_count, 1)
  check('an ISO timestamp left by an old restore is normalised', upgraded.applied_at, '2026-10-16 05:00:00')
  check('the version is written to disk', await inspect(versionOf), db.SCHEMA_VERSION)

  // ── A database written by the try/catch era: every column, version 0 ──
  await rewrite(raw => raw.run('PRAGMA user_version = 0'))
  let threw = null
  try { await db.init() } catch (err) { threw = err }
  check('a database that already has every column is adopted without error', threw, null)
  check('and stamped with the current version', db.getSchemaVersion(), db.SCHEMA_VERSION)
  check('without losing its rows', db.countApplications(), 1)

  // ── A step that fails rolls back and is reported ──────────────────
  // Version 1 done, version 2 not, and the table version 2 has to alter is a
  // view: a genuine failure, of the kind the old catch would have hidden.
  await rewrite(raw => {
    raw.run('PRAGMA user_version = 1')
    raw.run('DROP TABLE IF EXISTS cloud_mirror_state')
    raw.run('ALTER TABLE applications DROP COLUMN experiment_arm')
    raw.run('ALTER TABLE applications RENAME TO applications_moved')
    raw.run('CREATE VIEW applications AS SELECT * FROM applications_moved')
  })
  threw = null
  try { await db.init() } catch (err) { threw = err }
  check('the failure reaches init() instead of being swallowed', !!threw, true)
  check('and names the step that failed', /Database upgrade 2/.test(threw?.message || ''), true)
  check('the version did not move past the failed step', await inspect(versionOf), 1)
  check('and the step left nothing half-done', await inspect(raw => raw.exec("SELECT name FROM sqlite_master WHERE name = 'cloud_mirror_state'").length), 0)

  // Fix the cause and the next launch finishes the job.
  await rewrite(raw => { raw.run('DROP VIEW applications'); raw.run('ALTER TABLE applications_moved RENAME TO applications') })
  await db.init()
  check('a later launch completes the step', db.getSchemaVersion(), db.SCHEMA_VERSION)
  check('the table it creates exists', await inspect(raw => columns(raw, 'cloud_mirror_state').includes('hash')), true)

  // ── Old-style ALTERs appended to migrate() still work ────────────
  // Other changes may add `try { db.run('ALTER …') } catch {}` lines in the
  // legacy block; they run after the versioned steps on every launch. Here the
  // equivalent: a launch with nothing to do is a clean no-op.
  threw = null
  try { await db.init() } catch (err) { threw = err }
  check('a launch with nothing to upgrade is a no-op', threw, null)

  // ── A newer build's database is left alone ───────────────────────
  await rewrite(raw => { raw.run('ALTER TABLE offers DROP COLUMN benefits'); raw.run('PRAGMA user_version = 2') })
  await db.init()
  check('existing version 2 installs gain benefits', (await inspect(raw => columns(raw, 'offers'))).includes('benefits'), true)

  await rewrite(raw => raw.run(`PRAGMA user_version = ${db.SCHEMA_VERSION + 5}`))
  await db.init()
  check('a database from a newer build keeps its version', db.getSchemaVersion(), db.SCHEMA_VERSION + 5)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
