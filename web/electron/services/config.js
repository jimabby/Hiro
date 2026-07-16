const fs = require('fs')
const path = require('path')
const os = require('os')

const CONFIG_DIR = path.join(os.homedir(), '.hiro')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// ─── Secret encryption (Electron safeStorage, OS keychain-backed) ──────────
// Sensitive fields are stored encrypted with an "enc:v1:" prefix. Existing
// plaintext values still load and get encrypted on the next save. If the OS
// keychain is unavailable, values fall back to plaintext rather than locking
// the user out.
const SECRET_KEYS = ['aiApiKey', 'gmailAppPassword', 'supabaseRefreshToken', 'mobileApiToken']
const ENC_PREFIX = 'enc:v1:'

let safeStorage = null
try { ({ safeStorage } = require('electron')) } catch { /* not in Electron (tests) */ }

function canEncrypt() {
  try { return !!safeStorage && safeStorage.isEncryptionAvailable() } catch { return false }
}

function encryptValue(value) {
  if (typeof value !== 'string' || !value || value.startsWith(ENC_PREFIX)) return value
  if (!canEncrypt()) return value
  try { return ENC_PREFIX + safeStorage.encryptString(value).toString('base64') } catch { return value }
}

function decryptValue(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value
  if (!canEncrypt()) return ''
  try { return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64')) } catch { return '' }
}

function mapSecrets(config, fn) {
  const out = { ...config }
  for (const key of SECRET_KEYS) {
    if (key in out) out[key] = fn(out[key])
  }
  return out
}

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
  dailyReportTime: '18:00',
  followUpDays: 7,
  enableFollowUp: false,
  enableInboxCheck: false,
  lastInboxCheck: null,
  personalLinks: { portfolio: '', github: '', linkedin: '' },
  webhooks: [],
  enableWeeklyReport: false,
  enableDesktopNotifications: true,
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
    return mapSecrets({ ...DEFAULTS, ...JSON.parse(raw) }, decryptValue)
  } catch {
    return { ...DEFAULTS }
  }
}

function save(config) {
  ensureDir()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(mapSecrets(config, encryptValue), null, 2), 'utf8')
}

// Atomic read-modify-write. Background services (scheduler, cloud sync, mobile
// API) must use this instead of load()+save(): load and save are synchronous,
// so a whole update() is un-interleavable on the event loop, whereas a caller
// that holds a loaded copy across an `await` and then saves it will clobber
// any fields written by another service in the meantime.
function update(patch) {
  const cfg = load()
  const next = typeof patch === 'function' ? patch(cfg) : { ...cfg, ...patch }
  save(next)
  return next
}

module.exports = { load, save, update, CONFIG_DIR }
