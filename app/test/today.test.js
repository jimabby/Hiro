// The Today list: the desktop task inbox's rules, cut to overdue / today / soon,
// and where each piece comes from over LAN and cloud.
const { createChecker } = require('./helpers')
const { buildTasks, interviewTasks, todayView, countDue } = require('../src/todayTasks')
const { loadTodayTasks, CHECKLIST_FETCH_CAP } = require('../src/todayLoader')
const { check, done } = createChecker()

const TODAY = '2026-10-27'

const applications = [
  { id: 1, job_title: 'Engineer', company: 'Acme', status: 'applied', next_action_at: '2026-10-25', next_action_note: 'Chase recruiter' },
  { id: 2, job_title: 'Designer', company: 'Beta', status: 'held', closing_date: '2026-10-27' },
  { id: 3, job_title: 'Analyst', company: 'Gamma', status: 'rejected', next_action_at: '2026-10-20' },
  { id: 4, job_title: 'PM', company: 'Delta', status: 'applied', closing_date: '2026-10-27' },
  { id: 5, job_title: 'SRE', company: 'Eps', status: 'interview', next_action_at: '2026-10-27', next_action_done_at: '2026-10-26' },
]
const checklists = {
  1: [{ id: 'a', title: 'Send portfolio', due: '2026-10-28', done: false }, { id: 'b', title: 'Done already', due: '2026-10-27', done: true }],
  3: [{ id: 'c', title: 'Closed app task', due: '2026-10-27', done: false }],
  4: [{ id: 'd', title: 'No date', due: '', done: false }],
}
const offers = [
  { id: 'o1', application_id: 4, company: 'Delta', job_title: 'PM', decision: 'considering', respond_by: '2026-10-29' },
  { id: 'o2', application_id: 1, company: 'Acme', job_title: 'Engineer', decision: 'declined', respond_by: '2026-10-27' },
]
const attention = [
  { id: 9, job_title: 'Imported', company: 'Zeta', closing_date: '2026-11-30' },
  { id: 10, job_title: 'Soon', company: 'Eta', closing_date: '2026-10-30' },
]

const tasks = buildTasks({ applications, checklists, offers, attention })
const ids = tasks.map(t => t.id).sort()
check('follow-up for an open application', ids.includes('follow-up:1:'), true)
check('a closed application gives no tasks', ids.some(id => id.endsWith(':3:') || id.includes(':3:c')), false)
check('a finished follow-up is not a task', ids.includes('follow-up:5:'), false)
check('closing date only for an unsent (held) application', [ids.includes('closing:2:'), ids.includes('closing:4:')], [true, false])
check('done checklist items are left out', ids.includes('checklist:1:b'), false)
check('open checklist item is a task', ids.includes('checklist:1:a'), true)
check('only a live offer is a task', ids.filter(id => id.startsWith('offer:')), ['offer:4'])
check('attention jobs with a closing date are tasks', ids.filter(id => id.startsWith('attention:')).length, 2)

const ivs = interviewTasks([
  { id: 7, application_id: 1, job_title: 'Engineer', company: 'Acme', scheduled_at: '2026-10-27 14:00:00', has_time: 1 },
  { id: 8, application_id: 2, job_title: 'Designer', company: 'Beta', scheduled_at: '2026-10-27', has_time: 0 },
  { id: 6, application_id: 2, job_title: 'Old', company: 'Beta', scheduled_at: '2026-10-20 09:00:00', has_time: 1 },
])
check('interview keeps its wall-clock time', ivs[0].time, '14:00')
check('a date-only interview has no time', ivs[1].time, '')

const view = todayView([...tasks, ...ivs], TODAY)
check('overdue: the missed follow-up', view.overdue.map(t => t.id), ['follow-up:1:'])
check('today: interviews first, timed before untimed, then closing', view.today.map(t => t.id), ['interview:7', 'interview:8', 'closing:2:'])
check('soon: within three days, in date order', view.soon.map(t => t.id), ['checklist:1:a', 'offer:4', 'attention:10'])
check('a past interview is not overdue', view.overdue.some(t => t.kind === 'interview'), false)
check('beyond the horizon is left out', [...view.today, ...view.soon].some(t => t.id === 'attention:9'), false)
check('undated tasks are left out', [...view.overdue, ...view.today, ...view.soon].some(t => t.id === 'checklist:4:d'), false)
check('count is overdue + today', countDue(view), 4)
check('a duplicate id is shown once', todayView([...ivs, ...ivs], TODAY).today.length, 2)
check('timestamps are cut to their date', todayView([{ id: 'x', kind: 'follow-up', due: '2026-10-27T09:00:00Z' }], TODAY).today[0].due, TODAY)

;(async () => {
  // LAN, current desktop: its own inbox is used as-is, plus interviews.
  const lan = {
    getTaskInbox: async () => [{ id: 'follow-up:1:', kind: 'follow-up', due: TODAY, title: 'Chase' }],
    getUpcomingInterviews: async () => [{ id: 7, scheduled_at: `${TODAY} 10:00:00`, has_time: 1 }],
    getApplications: async () => { throw new Error('should not be called') },
  }
  const fromDesktop = await loadTodayTasks(lan)
  check('LAN uses the desktop inbox', [fromDesktop.source, fromDesktop.tasks.map(t => t.id)], ['desktop', ['follow-up:1:', 'interview:7']])

  // LAN, older desktop (404 → null): built here, checklists one by one, capped.
  const many = Array.from({ length: CHECKLIST_FETCH_CAP + 5 }, (_, i) => ({ id: i + 1, status: 'applied', updated_at: `2026-10-${String(1 + (i % 27)).padStart(2, '0')}` }))
  let asked = 0
  const old = {
    getTaskInbox: async () => null,
    getApplications: async () => many,
    getChecklist: async (id) => { asked++; return id === 1 ? [{ id: 'z', title: 'T', due: TODAY, done: false }] : [] },
    getOffers: async () => { throw new Error('no offers route') },
    getAttention: async () => [],
    getUpcomingInterviews: async () => [],
  }
  const built = await loadTodayTasks(old)
  check('older desktop: built on the phone', built.source, 'built')
  check('older desktop: checklist requests are capped', asked, CHECKLIST_FETCH_CAP)
  check('older desktop: says the list was truncated', built.truncated, true)
  check('a failing source costs only its own tasks', Array.isArray(built.tasks), true)

  // Cloud: one bulk checklist read.
  let bulk = 0
  const cloud = {
    getApplications: async () => applications,
    getChecklists: async () => { bulk++; return checklists },
    getChecklist: async () => { throw new Error('per-app read should not be used') },
    getOffers: async () => ({ offers }),
    getAttention: async () => attention,
    getUpcomingInterviews: async () => [],
  }
  const fromCloud = await loadTodayTasks(cloud)
  check('cloud reads every checklist in one call', bulk, 1)
  check('cloud builds the same tasks as the rules', fromCloud.tasks.map(t => t.id).sort(), ids)

  let threw = false
  try { await loadTodayTasks({ getApplications: async () => { throw new Error('offline') } }) } catch { threw = true }
  check('no application list is an error, not "nothing to do"', threw, true)
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
