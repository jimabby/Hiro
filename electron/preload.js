const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testAiConnection: (provider, apiKey, geminiModel) => ipcRenderer.invoke('ai:test', provider, apiKey, geminiModel),
  testEmailConnection: (email, password) => ipcRenderer.invoke('email:test', email, password),

  // Automation
  startAutomation: () => ipcRenderer.invoke('automation:start'),
  stopAutomation: () => ipcRenderer.invoke('automation:stop'),
  getAutomationStatus: () => ipcRenderer.invoke('automation:status'),

  // Applications history
  getApplications: (filters) => ipcRenderer.invoke('db:getApplications', filters),
  getApplication: (id) => ipcRenderer.invoke('db:getApplication', id),
  updateApplicationStatus: (id, status) => ipcRenderer.invoke('db:updateStatus', id, status),

  // Jobs needing attention
  getAttentionJobs: () => ipcRenderer.invoke('db:getAttentionJobs'),
  dismissAttentionJob: (id) => ipcRenderer.invoke('db:dismissAttention', id),

  // Stats
  getStats: () => ipcRenderer.invoke('db:getStats'),

  // LinkedIn session
  linkedinStatus: () => ipcRenderer.invoke('linkedin:status'),
  linkedinLogin: () => ipcRenderer.invoke('linkedin:login'),
  linkedinLogout: () => ipcRenderer.invoke('linkedin:logout'),

  // Resume file import / improve / download
  importResumeFile: () => ipcRenderer.invoke('resume:importFile'),
  improveResume: (text) => ipcRenderer.invoke('resume:improve', text),
  downloadResume: (text, name) => ipcRenderer.invoke('resume:download', text, name),

  // Events from main process
  onNotification: (cb) => ipcRenderer.on('notification', (_, data) => cb(data)),
  onAutomationLog: (cb) => ipcRenderer.on('automation:log', (_, msg) => cb(msg)),
  onLinkedInStatusUpdate: (cb) => ipcRenderer.on('linkedin:status-update', (_, msg) => cb(msg)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
})
