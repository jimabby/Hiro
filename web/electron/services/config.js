const fs = require('fs')
const path = require('path')
const os = require('os')

const CONFIG_DIR = path.join(os.homedir(), '.hiro')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULTS = {
  aiProvider: '',
  aiApiKey: '',
  geminiModel: '',
  gmailAddress: '',
  gmailAppPassword: '',
  jobKeywords: '',
  jobLocation: '',
  salaryMin: 0,
  masterResume: '',
  resumes: [],
  defaultResumeId: '',
  matchThreshold: 80,
  dailyLimitSeek: 10,
  dailyLimitIndeed: 10,
  dailyLimitLinkedIn: 10,
  blacklistedCompanies: [],
  enableSeek: true,
  enableIndeed: true,
  enableLinkedIn: true,
  setupComplete: false,
  coverLetterTone: 'professional',
  coverLetterTemplate: '',
  scheduledScanTime: '09:00',
  followUpDays: 7,
  enableFollowUp: false,
  enableInboxCheck: false,
  lastInboxCheck: null,
  personalLinks: { portfolio: '', github: '', linkedin: '' },
  webhooks: [],
  enableWeeklyReport: false,
  enableSmartScheduling: false,
  smartScheduleStartTime: '09:00',
  smartScheduleEndTime: '17:00',
  smartScheduleBatchSize: 3,
  smartScheduleJitter: 15,
  mobileApiEnabled: false,
  mobileApiPort: 4823,
  mobileApiToken: '',
  pendingScans: [],   // scan requests queued (e.g. from the mobile app) waiting to run
  lastScanAt: null,
  // Cloud sync (Supabase) — shared account so desktop + phone see one dataset.
  cloudSyncEnabled: false,
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseEmail: '',
  supabaseRefreshToken: '',
  lastCloudSyncAt: null,
}

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

function load() {
  ensureDir()
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(config) {
  ensureDir()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}

module.exports = { load, save, CONFIG_DIR }
