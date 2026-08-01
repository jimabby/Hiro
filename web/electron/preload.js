const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  getConfigLoadError: () => ipcRenderer.invoke('config:loadError'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testAiConnection: (provider, apiKey, geminiModel) => ipcRenderer.invoke('ai:test', provider, apiKey, geminiModel),
  testEmailConnection: (email, password) => ipcRenderer.invoke('email:test', email, password),

  // Automation
  startAutomation: () => ipcRenderer.invoke('automation:start'),
  startDryRun: () => ipcRenderer.invoke('automation:dryRun'),
  stopAutomation: () => ipcRenderer.invoke('automation:stop'),
  getAutomationStatus: () => ipcRenderer.invoke('automation:status'),
  getScanInfo: () => ipcRenderer.invoke('automation:scanInfo'),
  getThresholdAdvice: () => ipcRenderer.invoke('automation:thresholdAdvice'),

  // Persistent activity log
  getRecentLogs: () => ipcRenderer.invoke('logs:getRecent'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogFile: () => ipcRenderer.invoke('logs:openFile'),

  // Applications history
  getApplications: (filters) => ipcRenderer.invoke('db:getApplications', filters),
  getApplication: (id) => ipcRenderer.invoke('db:getApplication', id),
  updateApplicationStatus: (id, status) => ipcRenderer.invoke('db:updateStatus', id, status),
  updateApplicationComment: (id, comment) => ipcRenderer.invoke('db:updateComment', id, comment),
  updateRecruiterEmail: (id, email) => ipcRenderer.invoke('db:updateRecruiterEmail', id, email),
  deleteApplication: (id) => ipcRenderer.invoke('db:deleteApplication', id),
  clearAllApplications: () => ipcRenderer.invoke('db:clearAllApplications'),

  // Jobs needing attention
  getAttentionJobs: () => ipcRenderer.invoke('db:getAttentionJobs'),
  dismissAttentionJob: (id) => ipcRenderer.invoke('db:dismissAttention', id),
  deleteAttentionJob: (id) => ipcRenderer.invoke('db:deleteAttentionJob', id),
  clearAllAttentionJobs: () => ipcRenderer.invoke('db:clearAllAttentionJobs'),
  applyAttentionJob: (id) => ipcRenderer.invoke('attention:apply', id),
  applyAttentionJobs: (ids) => ipcRenderer.invoke('attention:applyMany', ids),
  onAttentionLog: (cb) => ipcRenderer.on('attention:log', (_, msg) => cb(msg)),
  applySkippedJob: (id) => ipcRenderer.invoke('application:applySkipped', id),
  onSkippedApplyLog: (cb) => ipcRenderer.on('skipped:apply-log', (_, msg) => cb(msg)),

  // Stats
  getStats: () => ipcRenderer.invoke('db:getStats'),

  // LinkedIn session
  linkedinStatus: () => ipcRenderer.invoke('linkedin:status'),
  linkedinLogin: () => ipcRenderer.invoke('linkedin:login'),
  linkedinLogout: () => ipcRenderer.invoke('linkedin:logout'),

  // Seek session
  seekStatus: () => ipcRenderer.invoke('seek:status'),
  seekLogin: () => ipcRenderer.invoke('seek:login'),
  seekLogout: () => ipcRenderer.invoke('seek:logout'),
  onSeekStatusUpdate: (cb) => ipcRenderer.on('seek:status-update', (_, msg) => cb(msg)),

  // Indeed session
  indeedStatus: () => ipcRenderer.invoke('indeed:status'),
  indeedLogin: () => ipcRenderer.invoke('indeed:login'),
  indeedLogout: () => ipcRenderer.invoke('indeed:logout'),
  onIndeedStatusUpdate: (cb) => ipcRenderer.on('indeed:status-update', (_, msg) => cb(msg)),

  // Resume file import / improve / download
  importResumeFile: () => ipcRenderer.invoke('resume:importFile'),
  improveResume: (text) => ipcRenderer.invoke('resume:improve', text),
  downloadResume: (text, name, format, type) => ipcRenderer.invoke('resume:download', text, name, format, type),
  getResumePDFBase64: (text, originalPath, originalExt) => ipcRenderer.invoke('resume:getPDFBase64', text, originalPath, originalExt),
  getCoverLetterPDFBase64: (text) => ipcRenderer.invoke('coverLetter:getPDFBase64', text),
  openResumeDocx: (text, originalPath) => ipcRenderer.invoke('resume:openDocx', text, originalPath),

  // Screening question prompts (mid-apply). Payload is { id, question }; the
  // answer must echo the id back so it reaches the apply flow that asked.
  onQuestionAsk: (cb) => ipcRenderer.on('question:ask', (_, payload) => cb(payload)),
  sendQuestionAnswer: (payload) => ipcRenderer.send('question:answer', payload),
  onSubmitReview: (cb) => ipcRenderer.on('submit:review', (_, payload) => cb(payload)),
  sendSubmitConfirm: (payload) => ipcRenderer.send('submit:confirm', payload),

  // Export CSV
  exportCSV: (filters) => ipcRenderer.invoke('db:exportCSV', filters),

  // Timeline & Analytics
  getApplicationsByDate: () => ipcRenderer.invoke('db:getApplicationsByDate'),
  getApplicationsPerDay: (days) => ipcRenderer.invoke('db:getApplicationsPerDay', days),

  // AI features
  generateInterviewQuestions: (jobDesc, resume) => ipcRenderer.invoke('ai:interviewQuestions', jobDesc, resume),
  generateInterviewFollowUp: (question, userAnswer, jobDescription) => ipcRenderer.invoke('ai:interviewFollowUp', question, userAnswer, jobDescription),
  analyzeKeywordGap: (jobDesc, resume) => ipcRenderer.invoke('ai:keywordGap', jobDesc, resume),
  blacklistCompany: (company) => ipcRenderer.invoke('config:blacklistCompany', company),
  removeBlacklistCompany: (company) => ipcRenderer.invoke('config:removeBlacklistCompany', company),

  // Interview prep persistence
  saveInterviewPrep: (applicationId, questions) => ipcRenderer.invoke('db:saveInterviewPrep', applicationId, questions),
  getInterviewPrep: (applicationId) => ipcRenderer.invoke('db:getInterviewPrep', applicationId),

  // Analytics export
  exportAnalyticsPDF: () => ipcRenderer.invoke('analytics:exportPDF'),
  getWeeklyData: () => ipcRenderer.invoke('analytics:getWeeklyData'),

  // Webhooks
  testWebhook: (provider, url) => ipcRenderer.invoke('webhook:test', provider, url),

  // Smart scheduling
  getBatchSchedule: () => ipcRenderer.invoke('scheduler:getBatchSchedule'),

  // Screening cache management
  getCachedAnswers: () => ipcRenderer.invoke('db:getCachedAnswers'),
  deleteCachedAnswer: (question) => ipcRenderer.invoke('db:deleteCachedAnswer', question),
  updateCachedAnswer: (question, answer) => ipcRenderer.invoke('db:updateCachedAnswer', question, answer),
  clearAllCachedAnswers: () => ipcRenderer.invoke('db:clearAllCachedAnswers'),
  getStorageInfo: () => ipcRenderer.invoke('db:getStorageInfo'),

  // Interview schedule
  getUpcomingInterviews: (limit) => ipcRenderer.invoke('db:getUpcomingInterviews', limit),
  getInterviewEvents: (applicationId) => ipcRenderer.invoke('db:getInterviewEvents', applicationId),
  addInterviewEvent: (payload) => ipcRenderer.invoke('db:addInterviewEvent', payload),
  deleteInterviewEvent: (id) => ipcRenderer.invoke('db:deleteInterviewEvent', id),

  // Application closing date
  updateClosingDate: (id, closingDate) => ipcRenderer.invoke('db:updateClosingDate', id, closingDate),

  // Interview calendar export. Pass an eventId for one interview, omit for all.
  exportInterviewsICS: (eventId) => ipcRenderer.invoke('calendar:exportICS', eventId),

  // Score-band conversion analytics
  getScoreBandConversion: () => ipcRenderer.invoke('analytics:scoreBandConversion'),
  getSalaryStats: () => ipcRenderer.invoke('analytics:salaryStats'),

  // Retire applications that never got a reply (also runs on a schedule)
  sweepStaleApplications: () => ipcRenderer.invoke('db:sweepStale'),

  // Settings export / import (encrypted bundle)
  exportConfig: (passphrase, includeSecrets) => ipcRenderer.invoke('config:export', passphrase, includeSecrets),
  inspectConfigImport: (passphrase) => ipcRenderer.invoke('config:inspectImport', passphrase),
  applyConfigImport: () => ipcRenderer.invoke('config:applyImport'),

  // Status history & backups
  getStatusHistory: (applicationId) => ipcRenderer.invoke('db:getStatusHistory', applicationId),
  getSnapshots: (applicationId) => ipcRenderer.invoke('db:getSnapshots', applicationId),
  getSnapshot: (id) => ipcRenderer.invoke('db:getSnapshot', id),
  getSnapshotDiff: (id) => ipcRenderer.invoke('db:getSnapshotDiff', id),
  restoreSnapshot: (id) => ipcRenderer.invoke('db:restoreSnapshot', id),
  backupNow: () => ipcRenderer.invoke('db:backupNow'),
  listBackups: () => ipcRenderer.invoke('db:listBackups'),
  restoreBackup: (name) => ipcRenderer.invoke('db:restoreBackup', name),

  // Events from main process
  onNotification: (cb) => ipcRenderer.on('notification', (_, data) => cb(data)),
  onAutomationLog: (cb) => ipcRenderer.on('automation:log', (_, msg) => cb(msg)),
  onLinkedInStatusUpdate: (cb) => ipcRenderer.on('linkedin:status-update', (_, msg) => cb(msg)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // Mobile companion API
  getMobileInfo: () => ipcRenderer.invoke('mobile:getInfo'),
  setMobileEnabled: (enabled) => ipcRenderer.invoke('mobile:setEnabled', enabled),
  regenerateMobileToken: () => ipcRenderer.invoke('mobile:regenerateToken'),

  // Cloud sync (Supabase)
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  cloudSignIn: (email, password) => ipcRenderer.invoke('cloud:signIn', email, password),
  cloudSignOut: () => ipcRenderer.invoke('cloud:signOut'),
  cloudSyncNow: () => ipcRenderer.invoke('cloud:syncNow'),

  // Review queue (review-before-submit). Approving submits the already-drafted
  // documents; rejecting files the job as skipped so it isn't re-drafted.
  getHeldApplications: () => ipcRenderer.invoke('review:list'),
  approveHeldApplication: (id) => ipcRenderer.invoke('review:approve', id),
  approveHeldApplications: (ids) => ipcRenderer.invoke('review:approveMany', ids),
  rejectHeldApplication: (id) => ipcRenderer.invoke('review:reject', id),
  onReviewLog: (cb) => ipcRenderer.on('review:log', (_, msg) => cb(msg)),

  // AI usage & spend
  getAiUsage: () => ipcRenderer.invoke('ai:usage'),
  clearAiUsage: () => ipcRenderer.invoke('ai:clearUsage'),

  // Which resume actually converts
  getResumeConversion: () => ipcRenderer.invoke('analytics:resumeConversion'),

  // Company career boards (Greenhouse / Lever / Ashby)
  testAtsBoard: (provider, slug) => ipcRenderer.invoke('ats:testBoard', provider, slug),

  // Updates
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_, status) => cb(status)),

  // Tray / launch-on-login availability
  getTrayStatus: () => ipcRenderer.invoke('tray:status'),

  // Gmail sign-in & inbox
  gmailStatus: () => ipcRenderer.invoke('gmail:status'),
  gmailLogin: (email) => ipcRenderer.invoke('gmail:login', email),
  gmailLogout: () => ipcRenderer.invoke('gmail:logout'),
  onGmailStatusUpdate: (cb) => ipcRenderer.on('gmail:status-update', (_, msg) => cb(msg)),
  checkInboxNow: () => ipcRenderer.invoke('inbox:checkNow'),
  onInboxReply: (cb) => ipcRenderer.on('notification', (_, data) => { if (data.type === 'inbox-reply') cb(data.item) }),
})
