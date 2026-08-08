const fs = require('fs')
const path = require('path')
const os = require('os')

// Everything Hiro owns — config, the SQLite database, backups, logs — lives in
// one directory so a profile can be moved, backed up or thrown away as a unit.
// HIRO_CONFIG_DIR relocates it: a second profile for a different job search, a
// portable install on a USB stick, and the release smoke test, which must drive
// the packaged app without touching the real profile on the machine.
const CONFIG_DIR = process.env.HIRO_CONFIG_DIR
  ? path.resolve(process.env.HIRO_CONFIG_DIR)
  : path.join(os.homedir(), '.hiro')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// ─── Secret encryption (Electron safeStorage, OS keychain-backed) ──────────
// Sensitive fields are stored encrypted with an "enc:v1:" prefix. Existing
// plaintext values still load and get encrypted on the next save. If the OS
// keychain is unavailable, values fall back to plaintext rather than locking
// the user out.
const SECRET_KEYS = [
  'aiApiKey', 'gmailAppPassword', 'supabaseRefreshToken', 'mobileApiToken',
  'calendarRefreshToken', 'calendarClientSecret',
]
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
  reviewFollowUpEmails: true,
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

  // This installation's identity on the account. Generated once, never
  // regenerated — a device that changes id on every launch cannot be listed,
  // trusted, or revoked, which is the whole point of having one.
  deviceId: '',
  deviceName: '',

  // Device ids this desktop has already seen on the account, so a phone signing
  // in is announced exactly once. Compared against this rather than against
  // created_at, so a desktop that was switched off for a week still reports
  // Tuesday's sign-in when it comes back. null (not []) means "never looked",
  // which is what stops the first run announcing every existing device.
  knownDeviceIds: null,

  // How this device combined its data with the account's the first time the two
  // met, once both held rows. Empty means the question has not been asked yet;
  // sync pauses rather than guessing, because the three reasonable answers
  // (merge / take the cloud / seed from here) are not interchangeable and two
  // of them destroy data on one side.
  cloudFirstSyncChoice: '',

  // ─── Mobile pairing ────────────────────────────────────────────
  // Phones paired to this desktop. Each carries its own token — stored as a
  // sha256 hash, so this file leaking does not hand anyone working access — plus
  // an issue date and an expiry. The old model was one shared token that never
  // aged out and could not be withdrawn from a single lost phone.
  mobileDevices: [],
  // Days a device token stays valid. 0 means never expires, which is a choice
  // rather than an oversight and is treated as one.
  mobileTokenTtlDays: 90,

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
  // Retries allowed across a whole scan, not per call. Per-call retries bound
  // one flaky request; this bounds a provider that is degrading, where every
  // job burns its full allowance and the scan takes an order of magnitude
  // longer while still being billed for each successful retry. 0 disables the
  // run-level cap.
  aiRetryBudgetPerScan: 20,

  // ─── ATS job boards ────────────────────────────────────────────
  // Company career boards hosted on Greenhouse / Lever / Ashby. These serve
  // structured JSON and have no bot defenses, so they're far more reliable
  // than scraping the aggregators. Each entry is { id, provider, slug, label }.
  atsBoards: [],
  enableAtsBoards: false,
  dailyLimitAts: 10,

  // Platforms that repeatedly block automation or exhibit broken selectors
  // are paused automatically. Entries are { platform: ISO timestamp } and are
  // maintained by automationHealth; the duration remains user-configurable.
  automationCooldownHours: 6,
  automationCooldowns: {},

  // ─── Recruiter contact extraction ──────────────────────────────
  // Pull a contact address out of the job ad and out of recruiter replies, so
  // auto follow-up has somewhere to send. Without it, follow-up skipped every
  // application, because nothing ever populated recruiter_email.
  extractRecruiterEmail: true,

  // ─── Push notifications to the phone ───────────────────────────
  // Sent through Expo's push service to the tokens registered by paired phones
  // (devices.push_token in Supabase). No Hiro server is involved, and nothing is
  // sent unless cloud sync is signed in — the token registry lives there.
  pushEnabled: false,
  // Per-kind switches. A user who wants interview reminders but not a ping for
  // every below-threshold scan needs these to be separable.
  pushKinds: {
    reply: true,        // a recruiter replied
    interview: true,    // an interview is coming up
    expiring: true,     // an application's closing date is near
    scanFailed: true,   // a scan errored or was blocked
    review: true,       // drafts are waiting for approval
    newDevice: true,    // a device signed in to the account
    followUp: true,     // a pipeline next-action date came due
  },
  // How far ahead to warn about an interview, and how long to keep quiet
  // afterwards. Two reminders (a day out, an hour out) is the useful shape.
  interviewReminderHoursAhead: [24, 2],
  // Warn when a listing closes within this many days and the application is
  // still unsent (held or in Needs Attention).
  closingSoonDays: 3,
  // Don't nag: at most one review-queue reminder per this many hours.
  reviewReminderHours: 24,

  // ─── Calendar sync ─────────────────────────────────────────────
  // Two-way sync of interviews with Google Calendar or Outlook (Microsoft
  // Graph). .ics export still exists and needs none of this.
  calendarProvider: '',      // '' | 'google' | 'outlook'
  calendarSyncEnabled: false,
  // OAuth client credentials. Hiro ships no client secret of its own: the user
  // registers their own OAuth app, which keeps a desktop app from embedding a
  // secret that cannot be kept.
  calendarClientId: '',
  calendarClientSecret: '',
  calendarRefreshToken: '',
  // Which calendar to write to. Empty means the account's primary calendar.
  calendarId: '',
  // Sync token / delta link from the last incoming pass, so each poll asks only
  // for what changed rather than re-reading the whole calendar.
  calendarSyncCursor: '',
  lastCalendarSyncAt: null,
  // Minutes before an interview for the calendar's own reminder.
  calendarReminderMinutes: 60,

  // ─── Pipeline ──────────────────────────────────────────────────
  // Days after which an application with no next action set is treated as
  // needing one, so nothing quietly falls off the board. 0 disables.
  pipelineNudgeDays: 7,

  // ─── Local database encryption ─────────────────────────────────
  // Encrypts autoapply.db and every backup at rest with AES-256-GCM, keyed by
  // the OS keychain through Electron's safeStorage. Off by default because
  // turning it on is a one-way door on machines whose keychain can be lost —
  // see services/dbCrypto.js.
  encryptDatabase: false,
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
