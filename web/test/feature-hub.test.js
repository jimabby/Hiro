const { stub, service, createChecker } = require('./helpers')
let cfg = { campaigns: [] }, imported = null, savedContact = null
stub({
  './config': { load: () => cfg, update: patch => (cfg = { ...cfg, ...patch }) },
  './database': {
    insertAttentionJob: data => { imported = data; return { success: true, id: 7 } },
    getContacts: () => [], saveContact: data => { savedContact = data; return { success: true } },
    deleteContact: () => ({ success: true }), getOptimisationInsights: () => [{ kind: 'sample' }],
  },
})
const hub = service('featureHub'), { check, done } = createChecker()
const campaign = hub.saveCampaign({ name: 'Data roles', keywords: 'data, sql', scheduleTime: '99:99' })
check('campaign gets a durable id', typeof campaign.id, 'string')
check('invalid time falls back safely', campaign.scheduleTime, '09:00')
check('campaign round-trips', hub.listCampaigns()[0].name, 'Data roles')
check('non-finite campaign salary is rejected safely', hub.saveCampaign({ salaryMin: Infinity }).salaryMin, 0)
check('invalid import URL is refused', (() => { try { hub.importJob({ url: 'file:///tmp/x' }); return false } catch { return true } })(), true)
hub.importJob({ url: 'https://jobs.example/1', title: 'Engineer', company: 'Example' })
check('job import is honest about platform', imported.platform, 'Imported')
hub.saveContact({ email: 'person@example.com' })
check('contact delegates to durable store', savedContact.email, 'person@example.com')
done()
