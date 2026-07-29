// Config and database durability.
//
// Both used a bare writeFileSync, so a crash partway through a write left a
// truncated file. For the config that was worse than losing the write: load()
// caught the parse error and returned DEFAULTS, so every setting, resume,
// routing rule and API key silently appeared to have vanished.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-durability-' + Date.now())
fs.mkdirSync(CONFIG_DIR, { recursive: true })

// config.js resolves its own directory from os.homedir(), so point HOME at a
// scratch dir rather than stubbing the module under test.
process.env.HOME = CONFIG_DIR
process.env.USERPROFILE = CONFIG_DIR

const configService = require(path.join(__dirname, '..', 'electron', 'services', 'config.js'))
const { check, done } = createChecker()

const CONFIG_FILE = path.join(configService.CONFIG_DIR, 'config.json')

// ── Round trip ───────────────────────────────────────────────────
configService.save({ ...configService.DEFAULTS, jobKeywords: 'react, node', matchThreshold: 72 })
check('settings round-trip', configService.load().jobKeywords, 'react, node')
check('numbers round-trip', configService.load().matchThreshold, 72)
check('no temp file is left behind', fs.existsSync(CONFIG_FILE + '.tmp'), false)
check('a clean load reports no error', configService.getLoadError(), null)

// ── New defaults are present ─────────────────────────────────────
const d = configService.DEFAULTS
check('review mode defaults to off', d.reviewBeforeSubmit, false)
check('tray operation defaults to on', d.minimizeToTray, true)
check('the AI budget cap defaults to unlimited', d.aiMonthlyBudgetUsd, 0)
check('contact extraction defaults to on', d.extractRecruiterEmail, true)
check('career boards default to off', d.enableAtsBoards, false)

// A config written by an older version must keep working — every new key
// falls back to its default rather than coming back undefined.
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ jobKeywords: 'legacy' }), 'utf8')
const old = configService.load()
check('an old config still loads', old.jobKeywords, 'legacy')
check('missing new keys fall back to defaults', old.reviewBeforeSubmit, false)
check('missing numeric keys fall back too', old.aiMaxRetries, 3)

// ── Corruption is reported, not silently swallowed ───────────────
fs.writeFileSync(CONFIG_FILE, '{ "jobKeywords": "truncated', 'utf8')
const recovered = configService.load()
check('a corrupt config falls back to defaults', recovered.jobKeywords, '')
check('but the failure is reported', typeof configService.getLoadError(), 'string')
check('the salvaged copy is kept', fs.existsSync(CONFIG_FILE + '.corrupt'), true)
check('the message names the salvage path', configService.getLoadError().includes('.corrupt'), true)

// The salvage copy must not be overwritten by a second failed load, or the
// original good content would be lost on the second launch.
fs.writeFileSync(CONFIG_FILE + '.corrupt', 'ORIGINAL', 'utf8')
configService.load()
check('an existing salvage file is not clobbered',
  fs.readFileSync(CONFIG_FILE + '.corrupt', 'utf8'), 'ORIGINAL')

// A successful save clears the error state.
configService.save({ ...configService.DEFAULTS, jobKeywords: 'fixed' })
check('saving over a corrupt file recovers', configService.load().jobKeywords, 'fixed')
check('the error is cleared once it loads', configService.getLoadError(), null)

// ── Database writes are atomic ───────────────────────────────────
;(async () => {
  const { stub, service } = require('./helpers')
  stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })
  const db = service('database.js')
  await db.init()

  const DB_PATH = path.join(CONFIG_DIR, 'autoapply.db')
  db.insertApplication({
    job_title: 'A', company: 'B', platform: 'Seek', job_url: 'u1',
    job_description: '', match_score: 90, tailored_resume: '', screening_qa: [], status: 'applied',
  })
  check('the database file is written', fs.existsSync(DB_PATH), true)
  check('no database temp file is left behind', fs.existsSync(DB_PATH + '.tmp'), false)

  // The file on disk must be a complete, re-openable database — not a
  // half-written buffer.
  const SQL = await require('sql.js')()
  const reopened = new SQL.Database(fs.readFileSync(DB_PATH))
  const rows = reopened.exec('SELECT job_title FROM applications')
  check('the persisted file reopens cleanly', rows[0].values[0][0], 'A')

  done()
})()
