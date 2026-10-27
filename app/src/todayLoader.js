// Gathers what the Today screen needs from whichever client is connected. The
// rules live in todayTasks.js; this only decides where each piece comes from.
//
//   LAN, current desktop:  GET /api/tasks (the desktop's own inbox) + interviews
//   LAN, older desktop:    built here — the application list, offers, Needs
//                          Attention, and checklists fetched per application
//   Cloud:                 built here — the same, with every checklist in one
//                          query (CloudClient.getChecklists)
//
// Each source is optional. One that fails (an older schema without the offers
// table, a desktop route that is not there) costs its own tasks, not the
// screen; only the applications list is required, because without it the
// answer would be "nothing to do" when that is not known to be true.
//
// CommonJS and react-native-free, so the plain-Node suite can run it against a
// fake client.

const { buildTasks, interviewTasks, CLOSED_STATUSES } = require('./todayTasks')

// The older-desktop fallback asks for checklists one application at a time.
// Bounded, newest first, so a long history cannot turn opening Today into a
// hundred requests; anything past the cap is still on the desktop's inbox.
const CHECKLIST_FETCH_CAP = 30
const CHECKLIST_CONCURRENCY = 4

const quietly = async (fn, fallback) => { try { return (await fn()) ?? fallback } catch { return fallback } }

async function fetchChecklistsOneByOne(client, applications) {
  const active = applications
    .filter(a => a && !CLOSED_STATUSES.includes(a.status))
    .sort((a, b) => String(b.updated_at || b.applied_at || '').localeCompare(String(a.updated_at || a.applied_at || '')))
    .slice(0, CHECKLIST_FETCH_CAP)
  const out = {}
  let next = 0
  const worker = async () => {
    while (next < active.length) {
      const app = active[next++]
      const items = await quietly(() => client.getChecklist(app.id), null)
      if (Array.isArray(items)) out[app.id] = items
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHECKLIST_CONCURRENCY, active.length) }, worker))
  return { checklists: out, truncated: applications.length > active.length && active.length === CHECKLIST_FETCH_CAP }
}

// Returns { tasks, source, truncated }. `source` is 'desktop' when the list is
// the desktop's own inbox, 'built' otherwise.
async function loadTodayTasks(client) {
  const interviewsP = quietly(() => client.getUpcomingInterviews?.(50), [])

  const inbox = typeof client.getTaskInbox === 'function' ? await quietly(() => client.getTaskInbox(), null) : null
  if (Array.isArray(inbox)) {
    return { tasks: [...inbox, ...interviewTasks(await interviewsP)], source: 'desktop', truncated: false }
  }

  const applications = await client.getApplications({})
  const [offerBoard, attention] = await Promise.all([
    quietly(() => client.getOffers?.(), null),
    quietly(() => client.getAttention?.(), []),
  ])
  let checklists = {}, truncated = false
  if (typeof client.getChecklists === 'function') checklists = await quietly(() => client.getChecklists(), {})
  else if (typeof client.getChecklist === 'function') ({ checklists, truncated } = await fetchChecklistsOneByOne(client, applications || []))

  const tasks = buildTasks({
    applications: applications || [],
    checklists,
    offers: offerBoard?.offers || [],
    attention: Array.isArray(attention) ? attention : [],
  })
  return { tasks: [...tasks, ...interviewTasks(await interviewsP)], source: 'built', truncated }
}

module.exports = { loadTodayTasks, CHECKLIST_FETCH_CAP }
