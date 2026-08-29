// Taking a job search to another machine, and getting it back.
//
// Nothing did this before. The rotating backups copy the SQLite file, which on
// an encrypted profile cannot be opened without this machine's keychain entry —
// exactly the wrong property for the case where the keychain is what was lost.
// The settings bundle is settings only. The CSV is fourteen columns with no
// resume, no cover letter and no reply.
//
// The two things that make this hard are both tested below: an application's id
// means nothing on another machine, and every child row points at one.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-data-transfer-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) }, './logger': { append: () => {} } })

const db = service('database')
const transfer = service('dataTransfer')
const { check, done } = createChecker()

const AD = `We need a Senior Data Engineer in Sydney to build pipelines, own the warehouse
models and work with analysts. Python, dbt, Airflow, Snowflake. Five years of production
experience expected, strong SQL, and the habit of writing things down properly.`

;(async () => {
  await db.init()

  // ── A job search with history hanging off it ────────────────────
  const app = db.insertApplication({
    job_title: 'Senior Data Engineer', company: 'Acme', platform: 'Seek',
    job_url: 'https://seek.test/1', job_description: AD, match_score: 91,
    tailored_resume: 'TAILORED RESUME TEXT', cover_letter: 'COVER LETTER TEXT',
    status: 'applied', recruiter_email: 'hr@acme.test', screening_qa: [{ q: 'Years?', a: '5' }],
  })
  db.updateApplicationStatus(app.id, 'interview')
  db.addInterviewEvent({ applicationId: app.id, scheduledAt: '2026-09-01 10:00:00', hasTime: true, note: 'Panel' })
  db.saveRecruiterReply({
    applicationId: app.id, uid: 7, from: 'hr@acme.test', subject: 'Interview',
    body: 'Can you do Tuesday?', classifiedAs: 'interview', receivedAt: '2026-08-20T09:00:00Z',
  })
  db.saveInterviewPrep(app.id, [{ question: 'Tell me about dbt', answer: 'I use it daily' }])
  db.insertAttentionJob({
    job_title: 'Platform Engineer', company: 'Globex', platform: 'Imported',
    job_url: 'https://globex.test/2', job_description: AD, reason: 'manual apply',
  })
  db.saveCachedAnswer('Notice period?', 'Four weeks', 'user')
  db.suppressRole({ company: 'Ghost Co', jobTitle: 'Forever Open', reason: 'Reposted monthly' })
  db.saveContact({ name: 'Dana', email: 'dana@acme.test', company: 'Acme', relationship: 'recruiter' })

  // ── Export ──────────────────────────────────────────────────────
  const plain = transfer.exportBundle('')
  check('an export without a passphrase is readable', plain.encrypted, false)
  const bundle = JSON.parse(plain.text)
  check('it declares what it is', bundle.magic, 'hiro-data-export')
  check('and a format version', bundle.version, 1)
  check('it carries the applications', bundle.data.applications.length, 1)
  // The documents are the entire point — the CSV export already covers the
  // columns a spreadsheet wants.
  check('including the tailored resume', bundle.data.applications[0].tailored_resume, 'TAILORED RESUME TEXT')
  check('and the cover letter', bundle.data.applications[0].cover_letter, 'COVER LETTER TEXT')
  check('it carries the status history', bundle.data.status_history.length >= 1, true)
  check('the interviews', bundle.data.interview_events.length, 1)
  check('the replies', bundle.data.recruiter_replies.length, 1)
  check('the interview prep', bundle.data.interview_prep.length, 1)
  check('the Needs Attention queue', bundle.data.attention_jobs.length, 1)
  check('the screening cache', bundle.data.screening_cache.length, 1)
  check('the suppressed roles', bundle.data.suppressed_roles.length, 1)
  check('the contacts', bundle.data.contacts.length, 1)
  // Every child row travels with its parent's URL, because the id it has here
  // will not survive the trip.
  check('children carry their parent URL', bundle.data.interview_events[0]._job_url, 'https://seek.test/1')
  // Machine-local bookkeeping must not travel: it would re-suppress
  // notifications, point at calendar events that do not exist, or tell cloud
  // sync to delete rows.
  for (const table of ['push_log', 'calendar_links', 'sync_conflicts', 'deleted_applications', 'automation_events', 'ai_usage']) {
    check(`${table} is not exported`, bundle.data[table], undefined)
  }
  check('the header counts what is inside', plain.counts.applications, 1)

  // ── Encryption ──────────────────────────────────────────────────
  const sealed = transfer.exportBundle('correct horse battery staple')
  check('an export with a passphrase is encrypted', sealed.encrypted, true)
  // The documents must not be sitting in the file in the clear.
  check('the documents are not readable in the file', sealed.text.includes('TAILORED RESUME TEXT'), false)
  check('nor is the recruiter address', sealed.text.includes('hr@acme.test'), false)
  const header = JSON.parse(sealed.text)
  // The header stays readable so a person with a text editor is told what the
  // file is rather than meeting an undifferentiated decryption failure.
  check('but the header still says what it is', header.magic, 'hiro-data-export')
  check('and how much is in it', header.counts.applications, 1)

  check('a wrong passphrase is refused', transfer.readBundle(sealed.text, 'wrong').ok, false)
  check('and says which problem it is', transfer.readBundle(sealed.text, 'wrong').needsPassphrase, true)
  check('a missing passphrase is refused', transfer.readBundle(sealed.text, '').needsPassphrase, true)
  check('the right passphrase opens it',
    transfer.readBundle(sealed.text, 'correct horse battery staple').bundle.data.applications.length, 1)
  check('an unrelated file is refused', transfer.readBundle('{"hello":1}').ok, false)
  check('and named as not a Hiro export', /not a Hiro data export/i.test(transfer.readBundle('{"hello":1}').reason), true)
  check('a newer format is refused rather than half-read',
    transfer.readBundle(JSON.stringify({ magic: 'hiro-data-export', version: 99 })).ok, false)
  check('garbage is refused', transfer.readBundle('not json at all').ok, false)

  // ── Import into a machine that already has some of it ───────────
  // Re-importing into the SAME database is the sharpest version of the merge
  // test: everything is a duplicate, so nothing may be added and nothing may be
  // doubled.
  const before = db.getStats().totalAllTime
  const again = transfer.importBundle(plain.text, '')
  check('re-importing the same data succeeds', again.success, true)
  check('and adds nothing', again.total, 0)
  check('leaving the totals untouched', db.getStats().totalAllTime, before)
  check('the status history is not doubled', db.getStatusHistory(app.id).length, bundle.data.status_history.length)
  check('nor the interviews', db.getInterviewEvents(app.id).length, 1)
  check('nor the replies', db.getRecruiterReplies(app.id).length, 1)

  // Now a genuinely new application in the bundle.
  const extended = JSON.parse(plain.text)
  extended.data.applications.push({
    ...bundle.data.applications[0],
    id: 999, job_url: 'https://seek.test/new', job_title: 'Staff Data Engineer',
  })
  extended.data.status_history.push({
    id: 999, application_id: 999, status: 'applied', changed_at: '2026-08-01 09:00:00',
    _job_url: 'https://seek.test/new',
  })
  const merged = transfer.importBundle(JSON.stringify(extended), '')
  check('a new application is added', merged.added.applications, 1)
  check('and the duplicate is reported as skipped', merged.skipped.applications, 1)
  const restored = db.getApplications({}).find(a => a.job_url === 'https://seek.test/new')
  check('the new row is really there', restored?.job_title, 'Staff Data Engineer')
  // The id in the file was 999; it must not have been honoured.
  check('its id was reassigned rather than taken from the file', restored.id === 999, false)
  // …and its child row must point at the id it actually got.
  check('its child row was re-pointed at the new id', db.getStatusHistory(restored.id).length, 1)

  // A child whose parent was skipped as a duplicate must not be imported: those
  // rows are already here under the existing application.
  check('children of a skipped parent are skipped too', merged.skipped.status_history >= 1, true)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
