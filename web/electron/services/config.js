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
  // Keyword → resume routing. Each rule is { id, keywords, resumeId }; the
  // first rule whose comma-separated keywords appear in the job title or
  // description picks that resume, otherwise defaultResumeId is used.
  resumeRules: [],
  matchThreshold: 80,
  // Days before the same company is eligible again after a successful apply.
  // 0 disables the cooldown entirely (per-listing and cross-platform duplicate
  // checks still apply).
  companyCooldownDays: 30,
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
  // Inbox checks used to run Mon–Fri only, so a Friday-evening recruiter reply
  // wasn't seen until Monday. Every day by default; the weekday-only cadence is
  // still available for anyone who wants a quiet weekend.
  inboxCheckWeekdaysOnly: false,
  inboxCheckHours: 2,
  lastInboxCheck: null,
  // After this many days with no reply, an application moves to 'no_response'
  // so it stops inflating the response-rate denominator. 0 disables the sweep
  // and leaves everything at 'applied' indefinitely.
  staleAfterDays: 45,
  // Pages of search results to walk per platform per scan. One page is ~20
  // listings; with a daily limit and duplicate-skipping, a single page goes
  // stale within days.
  scrapePages: 3,
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

  // ─── Review before submit ──────────────────────────────────────
  // When on, a job that clears the match threshold is drafted in full but
  // parked as 'held' rather than submitted. Nothing reaches an employer until
  // the user approves it on the Review page.
  reviewBeforeSubmit: false,

  // With review on, this is the escape hatch: a job scoring at or above this
  // goes straight out, everything else waits for approval. null means every
  // draft is held, which is what "review before submit" meant before this
  // existed. Deliberately separate from matchThreshold — that one decides what
  // is worth applying to at all, this one decides what is safe to send unseen,
  // and collapsing them would make raising your standards also remove your
  // safety net.
  autoSubmitThreshold: null,

  // Pause at the last moment before an approved draft is sent and show the
  // screening answers for a final yes.
  //
  // This is the only point where those answers can be shown at all: they do not
  // exist until the form filler has walked the employer's wizard, so the Review
  // page has nothing true to display. Only applies to submissions you started —
  // a scheduled scan has nobody at the keyboard and never blocks on it.
  confirmBeforeSubmit: false,

  // ─── Background operation ──────────────────────────────────────
  // Closing the window used to quit the app on Windows/Linux, which stopped
  // every scheduled task — the daily scan, inbox checks, follow-ups and the
  // stale sweep only ran while someone had the window open.
  minimizeToTray: true,
  launchOnLogin: false,
  startMinimised: false,

  // ─── Updates ───────────────────────────────────────────────────
  autoCheckUpdates: true,

  // ─── AI budget ─────────────────────────────────────────────────
  // Hard cap on model spend per calendar month, in USD. 0 disables the cap.
  // Checked before each call, so it stops work rather than reporting an
  // overrun after the money is gone.
  aiMonthlyBudgetUsd: 0,
  // Retries for a failed model call, with exponential backoff. A rate limit
  // used to leave the job scored at a fabricated 50 and filed as skipped.
  aiMaxRetries: 3,

  // ─── ATS job boards ────────────────────────────────────────────
  // Company career boards hosted on Greenhouse / Lever / Ashby. These serve
  // structured JSON and have no bot defenses, so they're far more reliable
  // than scraping the aggregators. Each entry is { id, provider, slug, label }.
  atsBoards: [],
  enableAtsBoards: false,
  dailyLimitAts: 10,

  // ─── Recruiter contact extraction ──────────────────────────────
  // Pull a contact address out of the job ad and out of recruiter replies, so
  // auto follow-up has somewhere to send. Without it, follow-up skipped every
  // application, because nothing ever populated recruiter_email.
  extractRecruiterEmail: true,
}

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

// Set when load() finds a config file it can't parse. Falling back to DEFAULTS
// silently was indistinguishable from a first run — every setting, resume,
// routing rule and API key appeared to have vanished with no explanation. The
// broken file is preserved and this is surfaced in Settings instead.
let loadError = null

function getLoadError() {
  return loadError
}

function load() {
  ensureDir()
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    loadError = null
    return mapSecrets({ ...DEFAULTS, ...parsed }, decryptValue)
  } catch (err) {
    // Keep the unreadable file so it can be recovered by hand, and do it only
    // once — a later successful save must not be shadowed by a stale copy.
    const salvage = CONFIG_FILE + '.corrupt'
    try {
      if (!fs.existsSync(salvage)) fs.copyFileSync(CONFIG_FILE, salvage)
    } catch { /* best-effort */ }
    loadError = `Settings file could not be read (${err.message}). A copy was kept at ${salvage}; defaults are in use until it is fixed or overwritten.`
    return { ...DEFAULTS }
  }
}

// fsync before the rename, and fsync the directory after it. rename() is atomic
// with respect to ordering, but it does not force the temp file's bytes to disk
// first — after a power loss the entry can point at a file that is still partly
// zeroes. Best-effort: some filesystems refuse fsync on a directory handle.
function fsyncFile(file, flags) {
  let fd = null
  try {
    fd = fs.openSync(file, flags)
    fs.fsyncSync(fd)
  } catch { /* best-effort */ }
  finally { if (fd !== null) try { fs.closeSync(fd) } catch {} }
}

// Written via a temp file + rename so a crash or power loss partway through
// can't leave a truncated config — rename is atomic on NTFS and POSIX alike.
function save(config) {
  ensureDir()
  const json = JSON.stringify(mapSecrets(config, encryptValue), null, 2)
  const tmp = CONFIG_FILE + '.tmp'
  try {
    fs.writeFileSync(tmp, json, 'utf8')
    fsyncFile(tmp, 'r+')
    fs.renameSync(tmp, CONFIG_FILE)
    fsyncFile(CONFIG_DIR, 'r')
    loadError = null
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort */ }
    throw err
  }
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

module.exports = { load, save, update, getLoadError, CONFIG_DIR, DEFAULTS }
