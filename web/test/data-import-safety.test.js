// Importing a data export is reading a file the user picked off disk. These pin
// what the merge must no longer take on trust: column names, privileged
// values, and the assumption that nothing throws half-way. Plus the bug that
// imported only the first child row per application, and the dry-run preview.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-import-safety-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) }, './logger': { append: () => {} } })

const db = service('database')
const transfer = service('dataTransfer')
const { check, done } = createChecker()

const bundle = (data) => JSON.stringify({ magic: 'hiro-data-export', version: 1, exportedAt: '2026-10-01T00:00:00Z', counts: {}, data })
const app = (url, over = {}) => ({ id: 77, job_title: 'Engineer', company: 'Acme', platform: 'Seek', job_url: url, status: 'applied', ...over })
const history = (url, status, at) => ({ id: 1, application_id: 77, status, changed_at: at, _job_url: url })

;(async () => {
  await db.init()

  // ── Every child row arrives, not just the first ──────────────────
  const URL1 = 'https://jobs.test/1'
  let res = transfer.importBundle(bundle({
    applications: [app(URL1)],
    status_history: [
      history(URL1, 'applied', '2026-09-01 09:00:00'),
      history(URL1, 'interview', '2026-09-05 09:00:00'),
      history(URL1, 'offer', '2026-09-20 09:00:00'),
    ],
  }))
  const id1 = db.getApplications({}).find(a => a.job_url === URL1).id
  check('the import succeeds', res.success, true)
  check('all three history rows are imported', db.getStatusHistory(id1).map(h => h.status), ['applied', 'interview', 'offer'])

  // The same file again adds nothing, and one genuinely new row for the
  // existing application IS added rather than taken for a duplicate.
  res = transfer.importBundle(bundle({
    applications: [app(URL1)],
    status_history: [
      history(URL1, 'applied', '2026-09-01 09:00:00'),
      history(URL1, 'interview', '2026-09-05 09:00:00'),
      history(URL1, 'offer', '2026-09-20 09:00:00'),
      history(URL1, 'withdrawn', '2026-09-25 09:00:00'),
    ],
  }))
  check('identical child rows are skipped', res.skipped.status_history, 3)
  check('a new child row of an existing application is added', res.added.status_history, 1)
  check('so the history is complete and not doubled', db.getStatusHistory(id1).length, 4)

  // ── Column names come from the schema, never from the file ──────
  const evil = 'job_title) VALUES (\'x\', \'x\', \'x\'); DROP TABLE contacts; --'
  res = transfer.importBundle(bundle({
    applications: [{ ...app('https://jobs.test/2'), [evil]: 'boom', made_up_column: 1 }],
  }))
  check('a file with unknown keys still imports what it can', res.added.applications, 1)
  check('the unknown keys are reported, not executed', res.unknownColumns.applications.includes('made_up_column'), true)
  check('the table the key tried to drop is still there', Array.isArray(db.getContacts()), true)

  // ── An imported answer is never trusted as the user's own ───────
  transfer.importBundle(bundle({
    screening_cache: [{ question_hash: 'qh-1', question: 'Do you hold a security clearance?', answer: 'Yes, TS/SCI', source: 'user' }],
  }))
  check('an imported cached answer is treated as model output', db.getAllCachedAnswers().find(a => a.question === 'Do you hold a security clearance?')?.source, 'ai')

  // ── All of it or none of it ──────────────────────────────────────
  const before = db.countApplications()
  const contactsBefore = db.getContacts().length
  res = transfer.importBundle(bundle({
    applications: [app('https://jobs.test/3'), app('https://jobs.test/4', { job_title: null })],
    contacts: [{ email: 'new@contact.test', company: 'Acme', name: 'New' }],
  }))
  check('a row that cannot be inserted fails the import', res.success, false)
  check('and says nothing was changed', /nothing was changed/i.test(res.reason || ''), true)
  check('the row before it was not kept', db.countApplications(), before)
  check('nor anything else in the file', db.getContacts().length, contactsBefore)
  // And the failure did not reach disk either: a fresh load sees the same.
  await db.init()
  check('the database on disk is unchanged', db.countApplications(), before)

  // ── A dry run says what would happen and does none of it ────────
  const preview = transfer.previewImport(bundle({
    applications: [app('https://jobs.test/5', { extra_from_newer_version: 'x' }), app(URL1)],
    status_history: [history('https://jobs.test/5', 'applied', '2026-10-01 09:00:00')],
  }))
  check('the preview succeeds', preview.success, true)
  check('it is marked as a dry run', preview.dryRun, true)
  check('it says what it would add', preview.added.applications, 1)
  check('and what it would skip', preview.skipped.applications, 1)
  check('including child rows of the new application', preview.added.status_history, 1)
  check('and which columns it does not know', preview.unknownColumns.applications, ['extra_from_newer_version'])
  check('nothing was written', db.countApplications(), before)
  const real = transfer.importBundle(bundle({
    applications: [app('https://jobs.test/5', { extra_from_newer_version: 'x' }), app(URL1)],
    status_history: [history('https://jobs.test/5', 'applied', '2026-10-01 09:00:00')],
  }))
  check('the real import does exactly what the preview said', [real.added, real.skipped], [preview.added, preview.skipped])

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
