// The follow-up pipeline.
//
// `status` records where an application GOT TO; it cannot record what the user
// still owes it, which is why applications used to die of neglect while the
// dashboard reported a healthy response rate. These assertions pin the half that
// was missing: what is due, what is overdue, and what has gone quiet with nothing
// booked at all.
//
// Dates are local YYYY-MM-DD throughout. A follow-up is a day, not an instant, and
// a UTC boundary would make "due today" mean the wrong day for half the world.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-pipeline-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { pipelineNudgeDays: 7 }
stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => config,
    update: (patch) => { config = { ...config, ...patch }; return config },
  },
})

const db = service('database')
const { check, done } = createChecker()

const p = (n) => String(n).padStart(2, '0')
function localDate(daysFromNow = 0) {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

let seq = 0
function add(status, company) {
  seq++
  db.insertApplication({
    job_title: `Role ${seq}`,
    company,
    platform: 'Seek',
    salary: '',
    job_url: `https://example.com/job/${seq}`,
    job_description: '',
    match_score: 85,
    match_explanation: '',
    tailored_resume: '',
    screening_qa: [],
    status,
    closing_date: null,
  })
  return seq
}

// Backdate a row's timestamps and reload, so the "gone quiet" nudge is exercised
// against real data rather than a mock.
async function backdate(id, days) {
  const SQL = await require('sql.js')()
  const file = path.join(TMP, 'autoapply.db')
  const handle = new SQL.Database(fs.readFileSync(file))
  handle.run(
    "UPDATE applications SET applied_at = datetime('now','-' || ? || ' days'), updated_at = datetime('now','-' || ? || ' days') WHERE id = ?",
    [days, days, id]
  )
  fs.writeFileSync(file, Buffer.from(handle.export()))
  handle.close()
  await db.init()
}

async function main() {
  await db.init()

  // ── Setting and clearing ─────────────────────────────────────
  const chase = add('applied', 'Chase Me Ltd')
  check('nothing is booked to begin with', db.getApplication(chase).next_action_at, null)

  check('a next action can be set',
    db.setNextAction(chase, { date: localDate(3), note: 'Chase the recruiter' }).success, true)
  let row = db.getApplication(chase)
  check('the date is stored as given', row.next_action_at, localDate(3))
  check('the note is stored', row.next_action_note, 'Chase the recruiter')
  // Editing an application must mark it for the next cloud push, or the phone
  // never sees the follow-up.
  check('the row is marked dirty for cloud sync', row.cloud_dirty, 1)

  // A malformed date is refused rather than stored — a stored "next Thursday"
  // would sort and compare as garbage forever.
  const bad = db.setNextAction(chase, { date: 'next thursday', note: 'x' })
  check('a malformed date is refused', bad.success, false)
  check('with an explanation', /YYYY-MM-DD/.test(bad.reason), true)
  check('and the stored date is untouched', db.getApplication(chase).next_action_at, localDate(3))

  // ── Due and overdue ──────────────────────────────────────────
  const overdue = add('applied', 'Overdue Inc')
  db.setNextAction(overdue, { date: localDate(-2), note: 'Send the take-home' })
  const dueToday = add('applied', 'Due Today Co')
  db.setNextAction(dueToday, { date: localDate(0), note: 'Call back' })
  const future = add('applied', 'Later Ltd')
  db.setNextAction(future, { date: localDate(5), note: 'Follow up' })

  const due = db.getDueNextActions()
  check('due includes overdue and today, not the future',
    due.map(d => d.company), ['Overdue Inc', 'Due Today Co'])
  // Soonest first: the overdue one is what the user has to deal with.
  check('the most overdue comes first', due[0].company, 'Overdue Inc')

  // ── Completing ───────────────────────────────────────────────
  check('an action can be completed', db.completeNextAction(overdue).success, true)
  row = db.getApplication(overdue)
  check('the date is cleared', row.next_action_at, null)
  // Cleared is not the same as never set: without this record the "gone quiet"
  // nudge would immediately re-flag a row the user just dealt with.
  check('but it is recorded as done', !!row.next_action_done_at, true)
  check('a completed action is no longer due',
    db.getDueNextActions().map(d => d.company), ['Due Today Co'])

  // ── Never-submitted rows are out of it ───────────────────────
  const held = add('held', 'Held Back Ltd')
  db.setNextAction(held, { date: localDate(-1), note: 'Approve me' })
  const skipped = add('skipped', 'Below Threshold Ltd')
  db.setNextAction(skipped, { date: localDate(-1), note: 'Nope' })
  check('a held row is never due — nothing was sent',
    db.getDueNextActions().some(d => d.company === 'Held Back Ltd'), false)
  check('nor is a skipped row',
    db.getDueNextActions().some(d => d.company === 'Below Threshold Ltd'), false)

  // ── The board ────────────────────────────────────────────────
  add('no_response', 'Ghosted Ltd')
  add('interview', 'Interviewing Co')
  add('offer', 'Offer Corp')
  add('rejected', 'Passed Ltd')
  add('pending', 'Unclear Ltd')

  const board = db.getPipeline()
  const stageOf = (company) => board.items.find(i => i.company === company)?.stage

  check('the board has the expected columns',
    board.stages.map(s => s.id), ['applied', 'waiting', 'interview', 'offer', 'closed'])
  check('today is reported so the UI does not guess it', board.today, localDate(0))

  // Stages are DERIVED from status, so the board can never disagree with the
  // status shown everywhere else and no backfill was needed.
  check('applied maps to Applied', stageOf('Chase Me Ltd'), 'applied')
  check('no_response maps to No reply yet', stageOf('Ghosted Ltd'), 'waiting')
  check('pending also maps to No reply yet', stageOf('Unclear Ltd'), 'waiting')
  check('interview maps to Interviewing', stageOf('Interviewing Co'), 'interview')
  check('offer maps to Offer', stageOf('Offer Corp'), 'offer')
  check('rejected maps to Closed', stageOf('Passed Ltd'), 'closed')

  check('held rows are not on the board',
    board.items.some(i => i.company === 'Held Back Ltd'), false)
  check('skipped rows are not on the board',
    board.items.some(i => i.company === 'Below Threshold Ltd'), false)

  const dueTodayItem = board.items.find(i => i.company === 'Due Today Co')
  check('an action due today is flagged as such', [dueTodayItem.dueToday, dueTodayItem.overdue], [true, false])
  const futureItem = board.items.find(i => i.company === 'Later Ltd')
  check('a future action is neither due nor overdue', [futureItem.dueToday, futureItem.overdue], [false, false])

  // Rows with something booked come first, soonest first — the board is ordered
  // by what is owed, not by when the application was made.
  const booked = board.items.filter(i => i.next_action_at)
  check('booked rows sort by date',
    booked.map(i => i.company), ['Due Today Co', 'Chase Me Ltd', 'Later Ltd'])
  check('booked rows come before unbooked ones',
    board.items.findIndex(i => i.company === 'Due Today Co')
    < board.items.findIndex(i => i.company === 'Ghosted Ltd'), true)

  // ── The "gone quiet" nudge ───────────────────────────────────
  // A row nobody has touched in a while, with nothing booked, is the one that
  // actually goes missing: no status change, no reply, no reminder.
  const forgotten = add('applied', 'Forgotten Ltd')
  await backdate(forgotten, 30)
  let item = db.getPipeline().items.find(i => i.company === 'Forgotten Ltd')
  check('a stale row with nothing booked is flagged', item.needsAction, true)

  // Booking something is exactly the answer, so it must clear the flag.
  db.setNextAction(forgotten, { date: localDate(2), note: 'Chase' })
  item = db.getPipeline().items.find(i => i.company === 'Forgotten Ltd')
  check('booking an action clears the flag', item.needsAction, false)
  db.completeNextAction(forgotten)

  // A resolved application needs no nudge — there is nothing left to chase.
  const rejectedOld = add('rejected', 'Long Since Passed Ltd')
  await backdate(rejectedOld, 60)
  check('a rejected row is never nudged',
    db.getPipeline().items.find(i => i.company === 'Long Since Passed Ltd').needsAction, false)
  const offerOld = add('offer', 'Won It Ltd')
  await backdate(offerOld, 60)
  check('an offer is never nudged',
    db.getPipeline().items.find(i => i.company === 'Won It Ltd').needsAction, false)

  // A recent row is not stale.
  const fresh = add('applied', 'Fresh Ltd')
  check('a row touched today is not flagged',
    db.getPipeline().items.find(i => i.company === 'Fresh Ltd').needsAction, false)

  // Zero disables the nudge entirely, which is a choice rather than an oversight.
  // A second stale row is needed because completing the action above stamped
  // updated_at, which is exactly what makes 'Forgotten Ltd' no longer stale.
  const alsoForgotten = add('applied', 'Also Forgotten Ltd')
  await backdate(alsoForgotten, 30)
  check('the second stale row is flagged',
    db.getPipeline().items.find(i => i.company === 'Also Forgotten Ltd').needsAction, true)
  config = { ...config, pipelineNudgeDays: 0 }
  check('setting the nudge window to zero disables it',
    db.getPipeline().items.some(i => i.needsAction), false)
  config = { ...config, pipelineNudgeDays: 7 }
  check('and restoring it brings the flag back',
    db.getPipeline().items.some(i => i.needsAction), true)

  // ── Interviews on the board ──────────────────────────────────
  const interviewApp = db.getApplications({ status: 'interview' })[0]
  db.addInterviewEvent({ applicationId: interviewApp.id, scheduledAt: `${localDate(2)} 10:00:00`, hasTime: true })
  item = db.getPipeline().items.find(i => i.id === interviewApp.id)
  check('an upcoming interview rides along with its card',
    item.nextInterview?.scheduled_at, `${localDate(2)} 10:00:00`)
  check('a card with no interview says so',
    db.getPipeline().items.find(i => i.company === 'Fresh Ltd').nextInterview, null)

  // ── Closing dates ────────────────────────────────────────────
  // Only rows that were NOT submitted: a deadline on an application already sent
  // is not something the user can act on.
  db.updateClosingDate(held, localDate(2))
  db.updateClosingDate(fresh, localDate(2))
  db.insertAttentionJob({
    job_title: 'Manual Apply Role', company: 'Careers Page Co', platform: 'ATS',
    salary: '', job_url: 'https://example.com/ats/1', job_description: '',
    match_score: 92, talking_points: [], reason: 'Requires manual application',
    closing_date: localDate(1),
  })

  const closing = db.getClosingSoon(3)
  check('a held row closing soon is included',
    closing.some(c => c.company === 'Held Back Ltd' && c.source === 'application'), true)
  check('a Needs Attention job closing soon is included',
    closing.some(c => c.company === 'Careers Page Co' && c.source === 'attention'), true)
  check('an already-submitted row is not',
    closing.some(c => c.company === 'Fresh Ltd'), false)
  check('soonest deadline first', closing[0].company, 'Careers Page Co')

  check('a window of zero returns nothing', db.getClosingSoon(0), [])
  check('a nonsense window returns nothing', db.getClosingSoon('soon'), [])
  check('a deadline outside the window is excluded',
    db.getClosingSoon(1).some(c => c.company === 'Held Back Ltd'), false)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
