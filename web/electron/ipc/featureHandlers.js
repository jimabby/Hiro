const database = require('../services/database')
const featureHub = require('../services/featureHub')

module.exports = function registerFeatureHandlers({ ipcMain, scheduler, getWindow }) {
  ipcMain.handle('features:taskInbox', () => featureHub.taskInbox())
  ipcMain.handle('features:completeInboxTask', (_, task) => featureHub.completeInboxTask(task))

  // A thank-you note after an interview: drafted here, edited and sent by the
  // user from their own mail app (shell:openMailDraft). Nothing is sent.
  ipcMain.handle('features:thankYouDraft', async (_, interviewId) => {
    try { return await require('../services/thankYouNote').draft(interviewId) }
    catch (err) { return { success: false, error: err.message } }
  })

  // Weekly goals and the skills-gap report.
  ipcMain.handle('features:weeklyGoals', () => require('../services/weeklyGoals').progress())
  ipcMain.handle('features:saveWeeklyGoals', (_, targets) => require('../services/weeklyGoals').saveTargets(targets))
  ipcMain.handle('features:skillsGap', (_, opts) => {
    const days = [30, 60, 90, 180].includes(Number(opts?.days)) ? Number(opts.days) : 90
    return require('../services/skillsGap').analyse({ days })
  })
  // Practice flashcards. Arguments are checked again in the service; nothing
  // here reaches a model or the network.
  const practice = () => require('../services/practice')
  ipcMain.handle('practice:today', () => practice().today())
  ipcMain.handle('practice:more', (_, count) => practice().more({ count }))
  ipcMain.handle('practice:rate', (_, cardId, rating) => practice().rate(cardId, rating))
  ipcMain.handle('practice:bank', () => practice().bank())
  ipcMain.handle('practice:stats', () => practice().stats())
  ipcMain.handle('practice:flag', (_, cardId, reason, note) => practice().flag(cardId, reason, note))
  ipcMain.handle('practice:unflag', (_, cardId) => practice().unflag(cardId))
  ipcMain.handle('practice:saveSettings', (_, settings) => practice().saveSettings(settings))
  ipcMain.handle('practice:saveNote', (_, cardId, note) => practice().saveNote(cardId, note))
  // Ask AI and deck generation spend on the user's AI key; both are refused
  // without a provider and stop at the monthly cap like every other call.
  ipcMain.handle('practice:explanations', (_, cardId) => practice().explanations(cardId))
  ipcMain.handle('practice:explain', (_, cardId, followUp) => practice().explain(cardId, followUp))
  ipcMain.handle('practice:clearExplanations', (_, cardId) => practice().clearExplanations(cardId))
  ipcMain.handle('practice:decks', () => practice().decks())
  ipcMain.handle('practice:generateDeck', (_, input) => practice().generateDeck(input && typeof input === 'object' ? input : {}))
  ipcMain.handle('practice:renameDeck', (_, id, title) => practice().renameDeck(id, title))
  ipcMain.handle('practice:deleteDeck', (_, id) => practice().deleteDeck(id))
  ipcMain.handle('practice:prepareJobDeck', (_, applicationId) => practice().prepareJobDeck(applicationId))
  // A question file the user chose: read in the renderer as text, parsed and
  // checked here. Previewed first; nothing is saved until importDeck.
  const importInput = (input) => ({
    name: typeof input?.name === 'string' ? input.name.slice(0, 200) : '',
    text: typeof input?.text === 'string' ? input.text : '',
    title: typeof input?.title === 'string' ? input.title : '',
  })
  ipcMain.handle('practice:previewImport', (_, input) => practice().previewImport(importInput(input)))
  ipcMain.handle('practice:importDeck', (_, input) => practice().importDeck(importInput(input)))
  ipcMain.handle('practice:deckFromUrl', (_, input) => practice().deckFromUrl({
    url: typeof input?.url === 'string' ? input.url : '',
    title: typeof input?.title === 'string' ? input.title : '',
    count: input?.count,
  }))
  ipcMain.handle('practice:stories', () => practice().stories())
  ipcMain.handle('practice:saveStory', (_, story) => practice().saveStory(story && typeof story === 'object' ? story : {}))
  ipcMain.handle('practice:deleteStory', (_, id) => practice().deleteStory(id))
  ipcMain.handle('practice:linkStory', (_, cardId, storyId) => practice().linkStory(cardId, storyId))
  ipcMain.handle('practice:unlinkStory', (_, cardId, storyId) => practice().unlinkStory(cardId, storyId))
  ipcMain.handle('practice:insights', (_, opts) => practice().insights({ days: opts?.days }))
  ipcMain.handle('practice:reminder', () => practice().reminderSettings())
  // A new time only takes effect once the cron job is rebuilt.
  ipcMain.handle('practice:saveReminder', (_, settings) => {
    const result = practice().saveReminder(settings)
    if (result.success) scheduler.restart(getWindow())
    return result
  })
  // Cram: one topic, outside the schedule. Nothing it does is saved.
  ipcMain.handle('practice:cram', (_, topic, count) => practice().cram({ topic, count }))
  // Export: the file is built here and written where the user chooses; the
  // renderer only says which cards and which format.
  ipcMain.handle('practice:export', async (_, ids, format) => {
    const built = practice().exportCards({ ids, format })
    if (!built.success) return built
    const { dialog } = require('electron')
    const stamp = database.localDateString()
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: format === 'anki' ? 'Export for Anki' : 'Export as CSV',
      defaultPath: `hiro-questions-${stamp}${format === 'anki' ? '-anki' : ''}.${built.extension}`,
      filters: format === 'anki'
        ? [{ name: 'Anki notes in plain text', extensions: ['txt'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    try {
      require('fs').writeFileSync(filePath, built.text, 'utf8')
      return { success: true, count: built.count, path: filePath }
    } catch (err) {
      // Most often a file still open in Excel.
      return { success: false, error: `Could not save the file: ${err.message}` }
    }
  })
  ipcMain.handle('practice:bankInfo', () => practice().bankInfo())
  ipcMain.handle('practice:refreshBank', () => practice().refreshBank({ force: true }))
  ipcMain.handle('features:views', () => featureHub.savedViews())
  ipcMain.handle('features:saveView', (_, view) => featureHub.saveView(view))
  ipcMain.handle('features:deleteView', (_, id) => featureHub.deleteView(id))
  ipcMain.handle('features:checklist', (_, id) => database.getChecklist(id))
  ipcMain.handle('features:updateChecklist', (_, id, change) => database.updateChecklist(id, change))
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
  // The user's own exchange rates for comparing offers in different currencies.
  // Typed in, never fetched; validated in database.setExchangeRates.
  ipcMain.handle('features:setExchangeRates', (_, fx) => database.setExchangeRates(fx || {}))

  // What the employer wrote back, shown alongside interview prep.
  ipcMain.handle('features:replies', (_, id) => featureHub.replies(id))
}
