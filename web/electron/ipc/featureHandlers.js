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
}
