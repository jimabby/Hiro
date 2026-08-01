// Audit trail: what was actually sent, frozen at the moment it was sent.
//
// The applications row is mutable — approving overwrites screening_qa, and
// editing the master resume changes the base out from under every past
// application. These snapshots are the only record that survives that, so the
// things worth testing are that they are captured on the paths that matter and
// that nothing later rewrites them.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-audit-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { diffLines, diffSummary } = require('../electron/services/textDiff')
const { check, done } = createChecker()

// ── Diff engine ────────────────────────────────────────────────
{
  const base = 'Jane Doe\nEngineer\nPython, Go\nAcme 2019-2024'
  const tailored = 'Jane Doe\nSenior Engineer\nPython, Go, Kubernetes\nAcme 2019-2024'
  const diff = diffLines(base, tailored)
  const summary = diffSummary(diff)

  check('unchanged lines are kept', diff.filter(d => d.type === 'same').length, 2)
  check('rewrites show as add + remove', summary.added, 2)
  check('removed count matches', summary.removed, 2)
  check('first line survives untouched', diff[0].type, 'same')

  // Order matters: the result has to read as a patch top to bottom, not as
  // every removal followed by every addition.
  const types = diff.map(d => d.type).join(',')
  check('diff is in document order', types.startsWith('same,'), true)

  // A tailoring pass that drops content is the failure worth catching.
  const dropped = diffLines('A\nB\nC\nD', 'A\nD')
  check('dropped lines are reported', diffSummary(dropped).removed, 2)
  check('nothing invented when only dropping', diffSummary(dropped).added, 0)

  check('identical documents produce no changes', diffSummary(diffLines('A\nB', 'A\nB')).added, 0)
  check('empty base is all additions', diffSummary(diffLines('', 'A\nB')).added, 2)
  check('empty tailored is all removals', diffSummary(diffLines('A\nB', '')).removed, 2)
  check('both empty is an empty diff', diffLines('', '').length, 0)
  check('non-string input does not throw', diffLines(null, undefined).length, 0)

  // Windows-authored resumes must not read as every line changed.
  check('CRLF matches LF', diffSummary(diffLines('A\r\nB', 'A\nB')).added, 0)
}

;(async () => {
  await db.init()

  // ── Snapshot on draft ────────────────────────────────────────
  const held = db.insertApplication({
    job_title: 'Senior Engineer', company: 'Acme', platform: 'Seek',
    job_url: 'https://example.com/1', job_description: 'jd', match_score: 91,
    base_resume: 'Jane Doe\nEngineer',
    tailored_resume: 'Jane Doe\nSenior Engineer',
    cover_letter: 'Dear Acme',
    screening_qa: [], status: 'held', resume_name: 'Backend CV',
  })

  let snaps = db.getSnapshots(held.id)
  check('drafting captures a snapshot', snaps.length, 1)
  check('draft snapshot is labelled', snaps[0].reason, 'drafted')
  check('list omits the documents', snaps[0].tailored_resume, undefined)
  check('list still reports document size', snaps[0].tailored_length > 0, true)

  // ── The base resume is frozen, not referenced ────────────────
  const full = db.getSnapshot(snaps[0].id)
  check('base resume is stored in full', full.base_resume, 'Jane Doe\nEngineer')
  check('resume attribution is kept', full.resume_name, 'Backend CV')

  const diff = db.getSnapshotDiff(snaps[0].id)
  check('diff is computed from the snapshot', diff.summary.added, 1)
  check('diff reports the removal too', diff.summary.removed, 1)

  // ── Snapshot on submission ───────────────────────────────────
  // This is the only record of the screening answers: they are written during
  // the submit and overwrite whatever the held row carried.
  db.markHeldApplied(held.id, [{ question: 'Do you have working rights?', answer: 'Yes', source: 'ai' }])

  snaps = db.getSnapshots(held.id)
  check('submitting appends a second snapshot', snaps.length, 2)
  check('newest snapshot is first', snaps[0].reason, 'submitted')
  check('the draft snapshot is still there', snaps[1].reason, 'drafted')

  const submitted = db.getSnapshot(snaps[0].id)
  check('screening answers are captured', submitted.screening_qa.length, 1)
  check('the answer text is preserved', submitted.screening_qa[0].answer, 'Yes')
  check('the source is preserved', submitted.screening_qa[0].source, 'ai')

  // The draft snapshot must not have been rewritten by the submission.
  const draftAgain = db.getSnapshot(snaps[1].id)
  check('the draft snapshot is untouched', draftAgain.screening_qa.length, 0)
  check('draft base resume still frozen', draftAgain.base_resume, 'Jane Doe\nEngineer')

  // ── Undo ─────────────────────────────────────────────────────
  const beforeRestore = db.getApplication(held.id).tailored_resume
  check('live row carries the tailored resume', beforeRestore, 'Jane Doe\nSenior Engineer')

  // Simulate a later re-tailor that made things worse.
  db.recordSnapshot(held.id, 'retailored', {
    base_resume: 'Jane Doe\nEngineer',
    tailored_resume: 'WRONG PERSON',
    cover_letter: 'wrong',
    screening_qa: [], match_score: 91, status: 'applied',
  })
  const bad = db.getSnapshots(held.id)[0]
  db.restoreSnapshot(bad.id)
  check('restore puts the snapshot back on the row',
    db.getApplication(held.id).tailored_resume, 'WRONG PERSON')

  // Restoring is itself reversible — the pre-restore state was captured.
  const trail = db.getSnapshots(held.id)
  check('restore records what it overwrote', trail.some(s => s.reason === 'before-restore'), true)
  const undoTarget = trail.find(s => s.reason === 'before-restore')
  db.restoreSnapshot(undoTarget.id)
  check('undo of the undo restores the good version',
    db.getApplication(held.id).tailored_resume, 'Jane Doe\nSenior Engineer')

  // ── Rows with nothing generated ──────────────────────────────
  const skipped = db.insertApplication({
    job_title: 'Junior Dev', company: 'Globex', platform: 'Seek',
    job_url: 'https://example.com/2', job_description: 'jd', match_score: 20,
    tailored_resume: '', cover_letter: '', screening_qa: [], status: 'skipped',
  })
  check('a skipped row with no documents takes no snapshot',
    db.getSnapshots(skipped.id).length, 0)

  // ── Guards ───────────────────────────────────────────────────
  check('unknown snapshot returns null', db.getSnapshot(99999), null)
  check('diff of an unknown snapshot returns null', db.getSnapshotDiff(99999), null)
  check('restoring an unknown snapshot fails cleanly',
    db.restoreSnapshot(99999).success, false)
  check('recording without an id fails cleanly',
    db.recordSnapshot(null, 'drafted').success, false)

  done()
})()
