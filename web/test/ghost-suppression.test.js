// Opting out of one role that keeps being reposted, and 'withdrawn'.
//
// Two separate additions, tested together because both are about a status or a
// decision the app previously had no way to express.
//
// Ghost suppression: the analysis already identified listings an employer
// reposts under a new URL every few weeks, and correctly refused to act on it —
// "probably a ghost" is a judgement about an employer and blacklisting on it
// would hide real jobs. But the cost it names, another score and another two
// documents on every reappearance, was still being paid every time. This is the
// narrow, explicit, reversible version of that decision: one role at one
// company, never inferred.
//
// 'withdrawn': the user pulled out. Previously that had to be recorded as
// 'rejected' (a lie about who ended it, and it landed in the rejection-stage
// analysis whose whole purpose is to say whether the resume or the interview is
// the problem) or 'skipped' (a lie about whether it was sent).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-ghost-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = {}
stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => config,
    update: (patch) => { config = { ...config, ...patch }; return config },
  },
})

const db = service('database')
const { check, done } = createChecker()

let seq = 0
function add(status, company, title) {
  seq++
  db.insertApplication({
    job_title: title, company, platform: 'Seek', salary: '',
    job_url: `https://example.com/job/${seq}`, job_description: '',
    match_score: 85, match_explanation: '', tailored_resume: '',
    screening_qa: [], status, closing_date: null,
  })
  return seq
}

;(async () => {
  await db.init()

  // ─── Suppressed roles ──────────────────────────────────────────
  check('nothing is suppressed to begin with', db.listSuppressedRoles().length, 0)
  check('an unsuppressed role is not suppressed',
    db.isRoleSuppressed('Globex', 'Backend Engineer'), false)

  db.suppressRole({ company: 'Globex', jobTitle: 'Backend Engineer', reason: 'Reposted 5x' })
  check('a suppressed role reports as suppressed',
    db.isRoleSuppressed('Globex', 'Backend Engineer'), true)
  check('it is listed', db.listSuppressedRoles().length, 1)
  check('the reason is kept', db.listSuppressedRoles()[0].reason, 'Reposted 5x')

  // Case and whitespace must not be a way to slip past it — scrapers do not
  // return a canonical casing.
  check('matching ignores case', db.isRoleSuppressed('globex', 'backend engineer'), true)
  check('matching ignores surrounding whitespace',
    db.isRoleSuppressed('  Globex ', ' Backend Engineer  '), true)

  // The whole point of being per-role: the company is not blacklisted.
  check('another role at the same company is unaffected',
    db.isRoleSuppressed('Globex', 'Frontend Engineer'), false)
  check('the same role at another company is unaffected',
    db.isRoleSuppressed('Initech', 'Backend Engineer'), false)

  // Exact match only. Fuzzy-matching would quietly turn a statement about one
  // role into a statement about a family of them.
  check('a similar title is not suppressed',
    db.isRoleSuppressed('Globex', 'Senior Backend Engineer'), false)

  // Reversible — "they are keeping a pipeline warm" is a guess the user is
  // entitled to change their mind about.
  db.unsuppressRole({ company: 'Globex', jobTitle: 'Backend Engineer' })
  check('it can be lifted', db.isRoleSuppressed('Globex', 'Backend Engineer'), false)
  check('and it leaves the list', db.listSuppressedRoles().length, 0)

  // Re-suppressing updates rather than duplicating.
  db.suppressRole({ company: 'Globex', jobTitle: 'Backend Engineer', reason: 'first' })
  db.suppressRole({ company: 'Globex', jobTitle: 'Backend Engineer', reason: 'second' })
  check('re-suppressing does not duplicate', db.listSuppressedRoles().length, 1)
  check('re-suppressing updates the reason', db.listSuppressedRoles()[0].reason, 'second')

  check('a role with no company or title is refused',
    db.suppressRole({ company: '', jobTitle: '' }).success, false)

  // ─── Withdrawn ─────────────────────────────────────────────────
  add('applied', 'Acme', 'Engineer A')
  add('applied', 'Acme', 'Engineer B')
  add('interview', 'Acme', 'Engineer C')
  add('rejected', 'Acme', 'Engineer D')

  const before = db.getStats()
  check('four applications are counted as sent', before.totalAllTime, 4)
  // 2 responded (interview + rejected) of 4 eligible.
  check('the response rate starts at 50%', before.responseRate, 50)

  const withdrawnId = add('withdrawn', 'Acme', 'Engineer E')
  const after = db.getStats()

  // It WAS sent. It happened, it cost the spend, and it is part of the record.
  check('a withdrawn application still counts as sent', after.totalAllTime, 5)

  // But the employer never got to finish answering it, so it must not drag the
  // rate down — taking a job elsewhere should not make the resume look worse.
  check('a withdrawal is excluded from the rate denominator', after.responseRate, 50)
  check('and from the interview rate', after.interviewRate, before.interviewRate)

  // It is visible in the breakdown rather than hidden.
  const byStatus = Object.fromEntries(after.byStatus.map(r => [r.status, r.count]))
  check('it appears in the status breakdown', byStatus.withdrawn, 1)

  // The inbox stops watching: the user has left the process, so a later email
  // is not an outcome to re-open the row with.
  const awaiting = db.getApplicationsAwaitingReply().map(a => a.id)
  check('a withdrawn application is no longer awaiting a reply',
    awaiting.includes(withdrawnId), false)

  // The pipeline board treats it as done — it owes nothing.
  const pipeline = db.getPipeline()
  const row = pipeline.items.find(r => r.id === withdrawnId)
  check('a withdrawn application is in the closed column', row.stage, 'closed')
  // And it must not collect a "gone quiet" nudge — it owes nothing.
  check('a withdrawn application needs no action', row.needsAction, false)

  done()
})()
