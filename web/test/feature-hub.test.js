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
// Refused as a RESULT, never a throw: the mobile/extension endpoint maps a
// false result to 400, and a throw reached the client as a 500 instead.
check('invalid import URL is refused', hub.importJob({ url: 'file:///tmp/x' }).success, false)
check('a refused import says why', /http/.test(hub.importJob({ url: 'file:///tmp/x' }).reason), true)
check('unparseable import URL is refused', hub.importJob({ url: 'not a url' }).success, false)
check('an import refusal never throws', (() => {
  try { hub.importJob({}); hub.importJob({ url: 'javascript:alert(1)' }); return true } catch { return false }
})(), true)
hub.importJob({ url: 'https://jobs.example/1', title: 'Engineer', company: 'Example' })
check('job import is honest about platform', imported.platform, 'Imported')
check('an import without a closing date stores none', imported.closing_date, null)
// The extension sends schema.org validThrough as closingDate; it is stored on
// the column taskInbox reads, so the import shows up as a deadline task.
hub.importJob({ url: 'https://jobs.example/2', salary: 'AUD $120,000 – $150,000 per year', closingDate: '2026-11-30T23:59:59+11:00' })
check('an imported closing date is kept as the listing\'s date', imported.closing_date, '2026-11-30')
check('an imported salary is passed to the store', imported.salary, 'AUD $120,000 – $150,000 per year')
check('an impossible closing date is dropped', hub.importClosingDate('2026-02-30'), null)
check('a non-date closing date is dropped', hub.importClosingDate('soon'), null)
check('closing_date is accepted as well', hub.importJob({ url: 'https://jobs.example/3', closing_date: '2026-12-01' }) && imported.closing_date, '2026-12-01')

// An id is an edit only when it names an existing campaign. Anything else gets
// a fresh one, so a malformed request cannot claim an identifier it likes.
const edited = hub.saveCampaign({ id: campaign.id, name: 'Renamed' })
check('an existing id edits in place', edited.id, campaign.id)
check('editing does not duplicate', hub.listCampaigns().filter(c => c.id === campaign.id).length, 1)
check('an unknown id does not get adopted', hub.saveCampaign({ id: 'attacker-chosen', name: 'X' }).id === 'attacker-chosen', false)
hub.saveContact({ email: 'person@example.com' })
check('contact delegates to durable store', savedContact.email, 'person@example.com')
done()
