const featureHub = require('../services/featureHub')

module.exports = function registerFeatureHandlers({ ipcMain, scheduler, getWindow }) {
  ipcMain.handle('features:campaigns', () => featureHub.listCampaigns())
  ipcMain.handle('features:saveCampaign', (_, campaign) => {
    const saved = featureHub.saveCampaign(campaign); scheduler.restart(getWindow()); return saved
  })
  ipcMain.handle('features:deleteCampaign', (_, id) => {
    const result = featureHub.deleteCampaign(id); scheduler.restart(getWindow()); return result
  })
  ipcMain.handle('features:runCampaign', (_, id) => {
    const campaign = featureHub.listCampaigns().find(c => c.id === id)
    if (!campaign) return { success: false, reason: 'Campaign not found.' }
    return { success: true, request: scheduler.requestScan({ ...campaign, campaignId: id, source: `campaign:${campaign.name}` }) }
  })
  ipcMain.handle('features:importJob', (_, job) => featureHub.importJob(job))
  ipcMain.handle('features:contacts', () => featureHub.listContacts())
  ipcMain.handle('features:dueContacts', () => featureHub.dueContacts())
  ipcMain.handle('features:saveContact', (_, contact) => featureHub.saveContact(contact))
  ipcMain.handle('features:deleteContact', (_, id) => featureHub.deleteContact(id))
  ipcMain.handle('features:completeContact', (_, id) => featureHub.completeContact(id))
  ipcMain.handle('features:snoozeContact', (_, id, date) => featureHub.snoozeContact(id, date))
  ipcMain.handle('features:campaignAnalytics', () => featureHub.campaignAnalytics())
  ipcMain.handle('features:insights', () => featureHub.insights())

  // Where applications actually die, and which generated version won.
  ipcMain.handle('features:rejectionAnalysis', () => featureHub.rejectionAnalysis())
  ipcMain.handle('features:versionOutcomes', () => featureHub.versionOutcomes())
  ipcMain.handle('features:applicationVersions', (_, id) => featureHub.applicationVersions(id))

  // Offers under consideration.
  ipcMain.handle('features:offers', () => featureHub.offers())
  ipcMain.handle('features:saveOffer', (_, id, data) => featureHub.saveOffer(id, data))
  ipcMain.handle('features:deleteOffer', (_, id) => featureHub.deleteOffer(id))

  // What the employer wrote back, shown alongside interview prep.
  ipcMain.handle('features:replies', (_, id) => featureHub.replies(id))
}
