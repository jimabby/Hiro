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
  'cloudDataKey',
  // Handed to Chromium for proxy authentication, never to a job board.
  'proxyPassword',
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

// ─── Secrets that cannot be decrypted right now ────────────────────────────
//
// A ciphertext this machine cannot unwrap is NOT the same as an absent value,
// and the difference used to be fatal. decryptValue returned '' for it, and the
// very next configService.update() — one runs at the end of every scan — wrote
// that '' straight back over the ciphertext. A keychain that was merely locked,
// or a profile copied to a second machine, silently and permanently destroyed
// the API key, the Gmail app password, the Supabase refresh token and the cloud
// data key. dbCrypto has always refused to guess in exactly this situation (see
// its 'key-unwrap-failed' path); this is the same rule applied to config.
//
// The ciphertext is remembered here at load time and written back verbatim on
// save unless the user has actually supplied a new value, so a keychain that
// comes back later finds the secrets intact.
const preservedSecrets = new Map() // key -> original 'enc:v1:…' string

// Set when a secret was present but unreadable, so the UI can say so instead of
// presenting a blank field that looks like the value was never set.
let secretError = null

function getSecretError() {
  return secretError
}

function decryptValue(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value
  if (!canEncrypt()) throw new Error('the OS keychain is unavailable')
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    throw new Error('the stored value could not be unwrapped by this keychain')
  }
}

const encryptSecret = encryptValue
// Callers outside this module (pairing.js) want a best-effort read: an
// unreadable per-device token means that device falls back to bearer auth, and
// there is nothing to preserve because the hash is the authority.
const decryptSecret = (value) => {
  try { return decryptValue(value) } catch { return '' }
}

// Decrypt for load(). Records what could not be read rather than flattening it
// to '', so save() can put the original back.
// The reason is held in a LOCAL, not in `secretError` itself. Reusing the
// module-level variable as the scratch space meant the second load embedded the
// whole of the first load's message inside the new one — and load() runs on
// nearly every operation, so the text grew by ~200 bytes each time and read as
// "…could not be decrypted because 1 saved secret could not be decrypted
// because…" all the way down. Reset per load; derive the message from scratch.
function decryptForLoad(config) {
  const out = { ...config }
  const unreadable = []
  let reason = null
  preservedSecrets.clear()
  secretError = null
  for (const key of SECRET_KEYS) {
    if (!(key in out)) continue
    const raw = out[key]
    try {
      out[key] = decryptValue(raw)
    } catch (err) {
      preservedSecrets.set(key, raw)
      unreadable.push(key)
      out[key] = ''
      if (!reason) reason = err.message
    }
  }
  secretError = unreadable.length
    ? `${unreadable.length} saved secret${unreadable.length === 1 ? '' : 's'} (${unreadable.join(', ')}) could not be decrypted because ${reason}. `
      + 'They have been left untouched on disk and will work again once the keychain is available. '
      + 'Re-entering a value here replaces the stored one.'
    : null
  return out
}

// Encrypt for save(). A field the caller left empty while its stored ciphertext
// is unreadable keeps the ciphertext; anything the user actually typed wins.
function encryptForSave(config) {
  const out = { ...config }
  for (const key of SECRET_KEYS) {
    if (!(key in out)) {
      // The key was dropped from the object entirely (a partial patch). Keep
      // whatever is on disk rather than losing it.
      if (preservedSecrets.has(key)) out[key] = preservedSecrets.get(key)
      continue
    }
    if (!out[key] && preservedSecrets.has(key)) out[key] = preservedSecrets.get(key)
    else out[key] = encryptValue(out[key])
  }
  return out
}

const DEFAULTS = {
  aiProvider: '',
  aiApiKey: '',
  geminiModel: '',
  // ─── Local model (aiProvider: 'local') ─────────────────────────
  // An OpenAI-compatible server on this machine — Ollama, LM Studio,
  // llama.cpp. Nothing leaves the device and nothing is billed. See
  // services/ai/local.js for why this is the one privacy gap the user could not
  // otherwise close.
  localAiBaseUrl: 'http://localhost:11434/v1',
  localAiModel: 'llama3.1:8b',
  gmailAddress: '',
  gmailAppPassword: '',
  // Mail servers. 'auto' looks the address domain up in services/mailProvider.js;
  // 'custom' uses the four fields below verbatim, which is what a personal
  // domain, a university address or a company mail server needs. There is
  // deliberately no third state: the old behaviour of quietly using Gmail's
  // servers for an unknown domain could never work and reported itself as a
  // wrong password.
  mailProvider: 'auto',
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  // Blank means "the address itself", which is right for almost every provider.
  // Set it where the login name differs from the address.
  smtpUser: '',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  imapUser: '',
  // The facts every application form asks for, answered deterministically
  // rather than by the model. See services/applicationProfile.js for why these
  // are the one category of screening question a model should not be near.
  applicationProfile: {},
  // Network egress for the scrapers. See scraper/utils.js: automationHealth can
  // already detect that a platform has started refusing us and back off, but
  // backing off was the entire toolkit — this is the lever for "route it
  // somewhere else", and the only thing that makes Hiro usable on a corporate
  // network whose sole route out is a proxy.
  proxyEnabled: false,
  proxyServer: '',
  proxyUsername: '',
  proxyPassword: '',
  proxyBypass: '',
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

  // ─── Résumé A/B test ───────────────────────────────────────────
  // Randomly split the jobs no routing rule claimed between two résumés, so the
  // interview-rate difference between them is caused by the document rather
  // than by which jobs each was pointed at. See services/resumeExperiment.js
  // for why the existing "which résumé converts" report cannot answer this.
  resumeExperiment: { enabled: false, name: '', resumeA: '', resumeB: '' },
  matchThreshold: 80,
  // Days before the same company is eligible again after a successful apply.
  // 0 disables the cooldown entirely (per-listing and cross-platform duplicate
  // checks still apply).
  companyCooldownDays: 30,
  dailyLimitSeek: 10,
  dailyLimitIndeed: 10,
  dailyLimitLinkedIn: 10,
  // Per-platform ceiling on drafts held for review in one day. The daily limits
  // above count what was SENT, so with review-before-submit on they never fire
  // and a scan would draft — and pay for — every listing it scraped. 0 disables.
  dailyDraftLimit: 20,
  blacklistedCompanies: [],
  enableSeek: true,
  enableIndeed: true,
  enableLinkedIn: true,
  setupComplete: false,
  coverLetterTone: 'professional',
  coverLetterTemplate: '',
  scheduledScanTime: '09:00',
  dailyReportTime: '18:00',
  // Days after applying before the FIRST follow-up.
  followUpDays: 7,
  // How many follow-ups an application may get in total. 1 is the old
  // behaviour: one nudge, ever. 2 is the default because the ordinary pattern
  // is a note after a week and one more a fortnight later, and the boolean this
  // replaces made the second one impossible.
  followUpMaxCount: 2,
  // Days between follow-ups after the first. Measured from the PREVIOUS
  // follow-up rather than from the application, or every remaining round would
  // come due the moment the first one went out.
  followUpIntervalDays: 14,
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
  campaigns: [],
  enableContactReminders: true,
  enableBackupDrills: true,
  lastBackupDrill: null,
  lastScanAt: null,
  // Cloud sync (Supabase) — shared account so desktop + phone see one dataset.
  cloudSyncEnabled: false,
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseEmail: '',
  supabaseRefreshToken: '',
  cloudDataKey: '',
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

  // ─── Screening answers ─────────────────────────────────────────
  // Days after which a cached screening answer is shown as needing
  // re-confirmation. These are submitted to employers over the user's name for
  // as long as they sit in the cache, and the facts under them move — "three
  // years of Python" was true when it was typed and is wrong two years later.
  // Nothing is ever deleted or withheld on age alone; the answer is flagged in
  // Settings and noted in the log when it is used. 0 turns the flagging off.
  screeningAnswerStaleDays: 180,

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
    offerDeadline: true, // an offer's respond-by date is close
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

// The profile directory holds config.json, the database, the backups and the
// wrapped database key. 0700 rather than the umask default of 0755: on a shared
// machine everything Hiro owns is private to the user by construction, so a file
// written without an explicit mode can never be the thing that exposes it.
// Windows ignores the mode and uses inherited ACLs.
function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

// Set when load() finds a config file it can't parse. Falling back to DEFAULTS
// silently was indistinguishable from a first run — every setting, resume,
// routing rule and API key appeared to have vanished with no explanation. The
// broken file is preserved and this is surfaced in Settings instead.
let loadError = null

function getLoadError() {
  return loadError
}

// ─── Load cache ────────────────────────────────────────────────────────────
//
// load() is called on nearly every operation in the app: once per mobile-API
// request, on every Workbench render, on every cloud-status poll, and inside
// most scheduler ticks. Each call reads and parses the file AND unwraps all
// seven secret fields through the OS keychain — Keychain on macOS, DPAPI on
// Windows, libsecret on Linux — which is a few milliseconds of IPC apiece and
// not something to do dozens of times a second.
//
// The cache is validated against the file's mtime and size rather than trusted
// blindly. This process holds the single-instance lock so it is the only writer,
// but a config edited by hand while Hiro is running must still be picked up —
// and a stale settings object is exactly the kind of bug that presents as "I
// changed the setting and nothing happened".
//
// Cached as a frozen snapshot that is COPIED on every read. Callers routinely
// mutate what load() hands back (scheduler patches a field then saves it), and
// handing out a shared object would let one caller's edit appear in another's
// unrelated read.
let cache = null // { mtimeMs, size, value }

function statSignature() {
  try {
    const st = fs.statSync(CONFIG_FILE)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch { return null }
}

function invalidate() {
  cache = null
}

function load() {
  ensureDir()
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS }
  const sig = statSignature()
  if (cache && sig && cache.mtimeMs === sig.mtimeMs && cache.size === sig.size) {
    // Restore the per-load diagnostics the cached parse produced, so a caller
    // that reads getSecretError() after a cache hit sees the same answer a cold
    // load would have given it.
    loadError = cache.loadError
    secretError = cache.secretError
    return { ...cache.value }
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    loadError = null
    const value = decryptForLoad({ ...DEFAULTS, ...parsed })
    if (sig) cache = { ...sig, value, loadError, secretError }
    return { ...value }
  } catch (err) {
    // Keep the unreadable file so it can be recovered by hand, and do it only
    // once — a later successful save must not be shadowed by a stale copy.
    const salvage = CONFIG_FILE + '.corrupt'
    try {
      if (!fs.existsSync(salvage)) fs.copyFileSync(CONFIG_FILE, salvage)
    } catch { /* best-effort */ }
    loadError = `Settings file could not be read (${err.message}). A copy was kept at ${salvage}; defaults are in use until it is fixed or overwritten.`
    invalidate()
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
//
// 0600, for the same reason dbCrypto writes db.key that way. This file always
// holds the master resume and the account addresses, and when the OS keychain is
// unavailable encryptValue is a no-op — so the AI API key, the Gmail app
// password and the cloud data key sit here in plaintext. That fallback exists so
// a missing secret service cannot lock the user out; it must not also mean every
// other account on the machine can read the secrets. `mode` only applies when
// the temp file is created, so chmod the survivor too.
function save(config) {
  ensureDir()
  const json = JSON.stringify(encryptForSave(config), null, 2)
  const tmp = CONFIG_FILE + '.tmp'
  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(tmp, 'r+')
    fs.renameSync(tmp, CONFIG_FILE)
    try { fs.chmodSync(CONFIG_FILE, 0o600) } catch { /* Windows ignores this */ }
    fsyncFile(CONFIG_DIR, 'r')
    loadError = null
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort */ }
    invalidate()
    throw err
  }
  // Unconditionally, and only after a successful write. The mtime check would
  // usually catch this on its own, but mtime resolution is coarse enough on some
  // filesystems that two saves inside the same tick can be indistinguishable —
  // and the cost of being wrong here is serving settings the user just changed.
  invalidate()
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

module.exports = {
  load, save, update, getLoadError, getSecretError, invalidate,
  CONFIG_DIR, DEFAULTS, encryptSecret, decryptSecret,
  // exported for tests
  _resetSecretState: () => { preservedSecrets.clear(); secretError = null; invalidate() },
}
