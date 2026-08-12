const crypto = require('crypto')
const configService = require('./config')
const database = require('./database')

const clean = (value, max = 500) => String(value || '').trim().slice(0, max)
const validTime = (value) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || ''))

function listCampaigns() {
  return Array.isArray(configService.load().campaigns) ? configService.load().campaigns : []
}

function saveCampaign(input = {}) {
  const campaigns = listCampaigns()
  const requestedSalary = Number(input.salaryMin)
  const campaign = {
    id: clean(input.id, 80) || crypto.randomUUID(),
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

function importJob(input = {}) {
  let url
  try { url = new URL(clean(input.url, 2000)) } catch { throw new Error('Enter a valid http(s) job URL.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) job URLs are supported.')
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
function saveContact(input) { return database.saveContact(input) }
function deleteContact(id) { return database.deleteContact(id) }
function insights() { return database.getOptimisationInsights() }

module.exports = {
  listCampaigns, saveCampaign, deleteCampaign, importJob,
  listContacts, saveContact, deleteContact, insights,
}
