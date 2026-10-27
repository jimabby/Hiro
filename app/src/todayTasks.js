// "What do I do today": one list of the things that are due — follow-ups,
// checklist items, interviews, offer deadlines and closing dates — built from
// data the phone already has over either transport.
//
// The rules are the desktop's task inbox (featureHub.taskInbox in
// web/electron/services/featureHub.js), and a task has the same shape —
// { id, kind, applicationId, company, jobTitle, due, title, taskId } — so the
// LAN path can take the desktop's own list (GET /api/tasks) unchanged and the
// cloud path, which has no desktop to ask, builds the same list here:
//
//   - nothing for a rejected, withdrawn or skipped application
//   - an unfinished checklist item, with its due date (or none)
//   - a follow-up that is set and not yet done
//   - a closing date, only for something not yet sent (held), and for every
//     Needs Attention job that has one
//   - an offer still being considered that has a respond-by date
//
// The desktop's inbox has no interviews (they have their own panel there), so
// they are added here as their own kind: on a phone, "today" without the
// interview at 2pm would be the wrong answer.
//
// Then the list is cut to what matters today: overdue, due today, and the next
// few days ("soon"), because an offer due on Thursday is Monday's job. Tasks
// with no due date are left out — they are a backlog, not today's work, and
// the desktop's inbox is where the backlog lives.
//
// CommonJS and free of react-native, so the plain-Node suite can pin it.

const { localDateOf } = require('./dates')

const CLOSED_STATUSES = ['rejected', 'withdrawn', 'skipped']
const UNSENT_STATUSES = ['held']
const SOON_DAYS = 3
const DATE_RE = /^\d{4}-\d{2}-\d{2}/

const dayOf = value => (DATE_RE.test(String(value || '')) ? String(value).slice(0, 10) : '')

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + n)
  return localDateOf(d)
}

// The cloud/fallback build. `checklists` maps an application id to its items
// (absent: not fetched, so no checklist tasks for it rather than a guess).
function buildTasks({ applications = [], checklists = {}, offers = [], attention = [] } = {}) {
  const tasks = []
  for (const app of applications || []) {
    if (!app || CLOSED_STATUSES.includes(app.status)) continue
    const add = (kind, due, title, taskId) => tasks.push({
      id: `${kind}:${app.id}:${taskId || ''}`, applicationId: app.id,
      company: app.company, jobTitle: app.job_title, kind, due: dayOf(due), title, taskId,
    })
    const items = checklists[app.id]
    if (Array.isArray(items)) {
      for (const task of items) if (task && !task.done && task.title) add('checklist', task.due, String(task.title).slice(0, 200), task.id)
    }
    if (app.next_action_at && !app.next_action_done_at) add('follow-up', app.next_action_at, app.next_action_note || 'Follow up')
    if (app.closing_date && UNSENT_STATUSES.includes(app.status)) add('closing', app.closing_date, 'Application closes')
  }
  for (const offer of offers || []) {
    if (!offer || offer.decision !== 'considering' || !offer.respond_by) continue
    const applicationId = offer.applicationId ?? offer.application_id
    tasks.push({ id: `offer:${applicationId ?? offer.id}`, applicationId, company: offer.company,
      jobTitle: offer.job_title, kind: 'offer', due: dayOf(offer.respond_by), title: 'Respond to offer' })
  }
  for (const job of attention || []) {
    if (!job?.closing_date) continue
    tasks.push({ id: `attention:${job.id}`, kind: 'attention', due: dayOf(job.closing_date), attentionId: job.id,
      company: job.company, jobTitle: job.job_title, title: 'Application closes' })
  }
  return tasks
}

// Interviews as tasks. scheduled_at is the desktop's wall-clock time (see
// parseLocal in dates.js), so its date part is the interview's day as written.
function interviewTasks(interviews = []) {
  return (interviews || []).filter(iv => dayOf(iv?.scheduled_at)).map(iv => {
    const hasTime = (iv.has_time === true || iv.has_time === 1) && /[ T]\d{2}:\d{2}/.test(String(iv.scheduled_at))
    return {
      id: `interview:${iv.id}`, applicationId: iv.application_id ?? null, company: iv.company, jobTitle: iv.job_title,
      kind: 'interview', due: dayOf(iv.scheduled_at), time: hasTime ? String(iv.scheduled_at).slice(11, 16) : '',
      title: iv.kind ? `Interview (${iv.kind})` : 'Interview',
    }
  })
}

// Order within a day: what has a clock time first (an interview at 10:00),
// then the kinds in rough order of cost-of-missing.
const KIND_RANK = { interview: 0, offer: 1, closing: 2, attention: 2, 'follow-up': 3, checklist: 4 }

function sortTasks(a, b) {
  return a.due.localeCompare(b.due)
    || (a.time || '99:99').localeCompare(b.time || '99:99')
    || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
    || String(a.id).localeCompare(String(b.id))
}

// Split into the three groups the screen shows. Duplicate ids (the same task
// reached by two routes) are shown once. An interview is never "overdue" —
// one that has passed is simply over.
function todayView(tasks = [], today, { soonDays = SOON_DAYS } = {}) {
  const horizon = addDays(today, soonDays)
  const seen = new Set()
  const out = { overdue: [], today: [], soon: [] }
  for (const task of tasks || []) {
    if (!task?.due || !DATE_RE.test(task.due) || seen.has(task.id)) continue
    const due = task.due.slice(0, 10)
    if (due < today && task.kind === 'interview') continue
    if (due > horizon) continue
    seen.add(task.id)
    const t = { ...task, due }
    if (due < today) out.overdue.push(t)
    else if (due === today) out.today.push(t)
    else out.soon.push(t)
  }
  for (const group of Object.values(out)) group.sort(sortTasks)
  return out
}

function countDue(view) {
  return view ? view.overdue.length + view.today.length : 0
}

module.exports = { buildTasks, interviewTasks, todayView, countDue, SOON_DAYS, CLOSED_STATUSES }
