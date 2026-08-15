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

module.exports = {
  listCampaigns, saveCampaign, deleteCampaign, importJob,
  listContacts, dueContacts, saveContact, deleteContact, completeContact, snoozeContact,
  campaignAnalytics, insights,
  rejectionAnalysis, versionOutcomes, applicationVersions,
  offers, saveOffer, deleteOffer, replies,
}
