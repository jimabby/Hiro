const crypto = require('crypto')
const configService = require('./config')
const database = require('./database')

const clean = (value, max = 500) => String(value || '').trim().slice(0, max)
const validTime = (value) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || ''))

function listCampaigns() {
  // One load, not two. Every load decrypts each stored secret through the OS
  // keychain, and this is called on every Workbench render.
  const campaigns = configService.load().campaigns
  return Array.isArray(campaigns) ? campaigns : []
}

function saveCampaign(input = {}) {
  const campaigns = listCampaigns()
  const requestedSalary = Number(input.salaryMin)
  // An id is honoured only when it names a campaign that already exists — that
  // is an edit. A caller-supplied id for something that doesn't exist is not
  // trusted to become one, or a malformed request could plant a row under any
  // identifier it liked and overwrite an unrelated campaign on the next save.
  const requestedId = clean(input.id, 80)
  const isEdit = requestedId && campaigns.some(c => c.id === requestedId)
  const campaign = {
    id: isEdit ? requestedId : crypto.randomUUID(),
    name: clean(input.name, 80) || 'Untitled campaign',
    keywords: clean(input.keywords, 500),
    location: clean(input.location, 160),
    salaryMin: Number.isFinite(requestedSalary) ? Math.min(10000000, Math.max(0, requestedSalary)) : 0,
    resumeId: clean(input.resumeId, 100),
    scheduleTime: validTime(input.scheduleTime) ? input.scheduleTime : '09:00',
    enabled: input.enabled !== false,
    reviewBeforeSubmit: input.reviewBeforeSubmit !== false,
  }
  const next = campaigns.filter(c => c.id !== campaign.id).concat(campaign)
  configService.update({ campaigns: next })
  return campaign
}

function deleteCampaign(id) {
  const next = listCampaigns().filter(c => c.id !== id)
  configService.update({ campaigns: next })
  return { success: true }
}

// Returns a result rather than throwing. Every caller — the Workbench button,
// the IPC handler, and the mobile/extension endpoint — already branches on
// `success`, and the endpoint maps a false result to 400. A throw bypassed all
// of that and surfaced a plainly invalid URL to the browser extension as a
// 500 Internal Server Error.
// The closing date an import carries, as the YYYY-MM-DD that attention_jobs
// .closing_date holds everywhere else (taskInbox and the closing-soon query
// compare it as text against date('now')). The extension sends schema.org's
// validThrough, which is usually a full timestamp — "2026-11-30T23:59:59+11:00"
// — and the date as written there is the employer's local date, which is the
// one that matters; so the date part is taken as-is rather than converted
// through this machine's time zone. Anything that is not a real calendar date
// is dropped rather than stored as a deadline that never comes.
function importClosingDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(value, 40))
  if (!m) return null
  const [y, mo, d] = m.slice(1).map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  if (y < 2000 || y > 2100) return null
  return m.slice(1).join('-')
}

function importJob(input = {}) {
  let url
  try { url = new URL(clean(input.url, 2000)) } catch {
    return { success: false, reason: 'Enter a valid http(s) job URL.' }
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { success: false, reason: 'Only http(s) job URLs are supported.' }
  }
  return database.insertAttentionJob({
    job_title: clean(input.title, 200) || 'Imported job',
    company: clean(input.company, 200) || url.hostname.replace(/^www\./, ''),
    platform: 'Imported',
    salary: clean(input.salary, 120),
    job_url: url.toString(),
    job_description: clean(input.description, 50000),
    match_score: null,
    talking_points: '[]',
    reason: 'Imported manually — review the listing and apply with Hiro’s prepared workflow.',
    // Stored on the row taskInbox already reads, so an imported job with a
    // closing date shows up as an "Application closes" task like a scanned one.
    closing_date: importClosingDate(input.closingDate ?? input.closing_date),
  })
}

function listContacts() { return database.getContacts() }
function dueContacts() { return database.getDueContacts() }
function saveContact(input) { return database.saveContact(input) }
function deleteContact(id) { return database.deleteContact(id) }
function completeContact(id) { return database.completeContactReminder(id) }
function snoozeContact(id, date) { return database.snoozeContactReminder(id, date) }
function campaignAnalytics() { return database.getCampaignAnalytics() }
function insights() { return database.getOptimisationInsights() }
function rejectionAnalysis() { return database.getRejectionAnalysis() }
function versionOutcomes() { return database.getVersionOutcomes() }
function applicationVersions(id) { return database.getApplicationVersionOutcome(Number(id)) }
function offers() { return database.getOffers() }
function saveOffer(id, data) { return database.saveOffer(Number(id), data || {}) }
function deleteOffer(id) { return database.deleteOffer(Number(id)) }
function replies(id) { return database.getRecruiterReplies(Number(id)) }

function savedViews() { return configService.load().applicationViews || [] }
function saveView(input = {}) {
  const name = clean(input.name, 60)
  if (!name) throw new Error('Name this view first.')
  const all = savedViews()
  if (!input.id && all.length >= 30) throw new Error('You can save up to 30 views.')
  const f = input.filter || {}, sort = input.sort || {}
  const view = {
    id: all.some(v => v.id === input.id) ? input.id : crypto.randomUUID(), name,
    filter: {
      status: clean(f.status, 30), platform: clean(f.platform, 30), search: clean(f.search, 200),
      salaryFrom: clean(f.salaryFrom, 12), salaryTo: clean(f.salaryTo, 12),
      minMatch: clean(f.minMatch, 3), dueOnly: !!f.dueOnly,
    },
    sort: { key: ['applied_at', 'match_score', 'job_title', 'company', 'salary', 'status', 'platform'].includes(sort.key) ? sort.key : 'applied_at', dir: sort.dir === 'asc' ? 'asc' : 'desc' },
  }
  configService.update({ applicationViews: all.filter(v => v.id !== view.id).concat(view) })
  return view
}
function deleteView(id) {
  configService.update({ applicationViews: savedViews().filter(v => v.id !== id) })
}

// Every open to-do across applications, offers and Needs Attention, soonest
// first.
//
// Read from getTaskInboxRows rather than getApplications(): that was SELECT *
// (every résumé and cover letter) followed by a second full-row read per
// application inside getChecklist. A checklist that cannot be parsed — they
// arrive from the cloud unvalidated — used to throw out of the loop and empty
// the whole inbox; now that one row reports itself and the rest still show.
//
// Closing dates only matter for something not yet sent. 'held' is the only
// application status that means that ('failed' was never a status, so the old
// filter was 'held' with a dead branch); unsent Needs Attention jobs are the
// other half and come from their own table.
const UNSENT_STATUSES = ['held']
const DATE_RE = /^\d{4}-\d{2}-\d{2}/

function taskInbox() {
  const tasks = []
  const { applications, attention } = database.getTaskInboxRows()
  for (const app of applications) {
    const add = (kind, due, title, taskId) => tasks.push({ id: `${kind}:${app.id}:${taskId || ''}`, applicationId: app.id,
      company: app.company, jobTitle: app.job_title, kind, due: DATE_RE.test(String(due || '')) ? String(due) : '', title, taskId })
    const checklist = database.parseChecklist(app.checklist)
    if (!checklist) add('checklist-error', '', 'Checklist could not be read — open the application to fix it')
    else for (const task of checklist) if (!task.done && task.title) add('checklist', task.due, String(task.title).slice(0, 200), task.id)
    if (app.next_action_at && !app.next_action_done_at) add('follow-up', app.next_action_at, app.next_action_note || 'Follow up')
    if (app.closing_date && UNSENT_STATUSES.includes(app.status)) add('closing', app.closing_date, 'Application closes')
  }
  for (const offer of database.getOffers().offers) {
    if (offer.decision !== 'considering' || !offer.respond_by) continue
    tasks.push({ id: `offer:${offer.applicationId}`, applicationId: offer.applicationId, company: offer.company,
      jobTitle: offer.job_title, kind: 'offer', due: offer.respond_by, title: 'Respond to offer' })
  }
  for (const job of attention) {
    tasks.push({ id: `attention:${job.id}`, kind: 'attention', due: job.closing_date, attentionId: job.id,
      company: job.company, jobTitle: job.job_title, title: 'Application closes' })
  }
  // Interview times Hiro drafted when an invitation arrived without one (see
  // inbox.js). Listed until the user dismisses it; nothing is sent for them.
  for (const p of database.getOpenTimeProposals()) {
    tasks.push({ id: `propose-times:${p.applicationId}`, applicationId: p.applicationId, company: p.company,
      jobTitle: p.jobTitle, kind: 'propose-times', due: String(p.createdAt || '').slice(0, 10),
      title: `Reply with your availability (${p.slots.length} time${p.slots.length === 1 ? '' : 's'} drafted)` })
  }
  return tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.id.localeCompare(b.id))
}

function completeInboxTask(task = {}) {
  if (task.kind === 'checklist') { database.updateChecklist(Number(task.applicationId), { id: task.taskId, done: true }); return { success: true } }
  if (task.kind === 'follow-up') return database.completeNextAction(Number(task.applicationId))
  if (task.kind === 'propose-times') return database.dismissTimeProposal(Number(task.applicationId))
  throw new Error('Open this application to complete the action.')
}

module.exports = {
  taskInbox, completeInboxTask,
  savedViews, saveView, deleteView,
  listCampaigns, saveCampaign, deleteCampaign, importJob, importClosingDate,
  listContacts, dueContacts, saveContact, deleteContact, completeContact, snoozeContact,
  campaignAnalytics, insights,
  rejectionAnalysis, versionOutcomes, applicationVersions,
  offers, saveOffer, deleteOffer, replies,
}
