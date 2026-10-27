// What the renderer is allowed to see of the config, and what it is allowed to
// write back.
//
// Two problems, one boundary.
//
// config:get used to hand the renderer every decrypted secret — the AI key, the
// mail password, the Supabase refresh token, the cloud data key, the calendar
// refresh token, the proxy password, every webhook URL. The renderer needs to
// know whether each is SET, and to let the user replace one; it never needs the
// value. A renderer compromise (an XSS through scraped job text, say) should not
// be a credential dump. So secrets go out as a placeholder, and coming back as
// that placeholder means "unchanged".
//
// config:save used to write the renderer's form back nearly verbatim. The form
// is a snapshot from when the page loaded, and the services keep writing config
// underneath it: a phone is revoked, the calendar is disconnected, a refresh
// token is rotated, the mailbox is signed out. Saving Settings from the stale
// form put all of it back — revoked phone tokens worked again, a disconnected
// calendar reconnected with a dead token. Two rules now:
//
//   1. Keys a service owns are never taken from the renderer at all.
//   2. Every other key is taken only if the renderer CHANGED it — compared with
//      what this process served it (the snapshot) rather than with what is on
//      disk now. A field the user did not touch keeps whatever a service has
//      written since; a field the user did edit (a newly pasted app password,
//      say) is saved, which is the one thing a blanket "never take credentials
//      from the renderer" rule would have broken.

const crypto = require('crypto')
const { isDeepStrictEqual } = require('util')

// What a stored secret looks like to the renderer. Truthy, so "is a key set?"
// checks keep working, and unmistakable, so it can never be confused with a
// value someone typed.
const SECRET_PLACEHOLDER = '__hiro_saved_secret__'

// The snapshot id rides along inside the config object, so every caller that
// does `saveConfig({ ...await getConfig(), something })` carries it back
// without having to know it exists.
const SNAPSHOT_KEY = '__configSnapshot'

const REDACTED_KEYS = [
  'aiApiKey', 'gmailAppPassword', 'supabaseRefreshToken', 'cloudDataKey',
  'calendarRefreshToken', 'calendarClientSecret', 'proxyPassword', 'mobileApiToken',
  'scheduledExportPassphrase',
]

// Written by background services and by their own dedicated IPC calls (connect,
// pair, revoke, sign in), never by the Settings form. Kept in step with
// RUNTIME_KEYS in services/configTransfer.js, which answers the related question
// of what must not travel to another machine.
const SERVICE_OWNED_KEYS = [
  'cloudCommandReceipts', 'cloudScanResults',
  'pendingScans', 'lastScanAt', 'lastInboxCheck', 'lastCloudSyncAt', 'lastJobAlertCheck',
  'lastBackupDrill', 'lastScanOutcome',
  'cloudSyncEnabled', 'supabaseEmail', 'supabaseRefreshToken', 'cloudDataKey',
  'cloudIdentityAccount', 'cloudFirstSyncChoice', 'deviceId', 'knownDeviceIds',
  'mobileApiEnabled', 'mobileApiToken', 'mobileDevices',
  'calendarProvider', 'calendarClientId', 'calendarClientSecret', 'calendarRefreshToken',
  'calendarSyncCursor', 'lastCalendarSyncAt',
  'encryptDatabase', 'automationCooldowns',
  // Owned by the scheduled-export IPC handlers, not by the Settings form.
  'scheduledExport', 'scheduledExportPassphrase', 'scheduledExportLastRunAt', 'scheduledExportLastResult',
]

const REDACTED = new Set(REDACTED_KEYS)
const SERVICE_OWNED = new Set(SERVICE_OWNED_KEYS)

function urlHint(value) {
  try {
    const u = new URL(String(value))
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? '/…' : ''}`
  } catch { return '' }
}

// Every webhook gets an id (so a redacted URL can be matched back to the stored
// one) and a signing secret. Returns null when nothing needed adding.
function withWebhookIdentity(webhooks, newSecret) {
  if (!Array.isArray(webhooks)) return null
  let changed = false
  const out = webhooks.map(wh => {
    if (!wh || typeof wh !== 'object') return wh
    if (wh.id && wh.secret) return wh
    changed = true
    return { ...wh, id: wh.id || crypto.randomUUID(), secret: wh.secret || newSecret() }
  })
  return changed ? out : null
}

function redactWebhook(wh) {
  if (!wh || typeof wh !== 'object') return wh
  const { secret, ...rest } = wh
  return { ...rest, url: wh.url ? SECRET_PLACEHOLDER : '', urlHint: urlHint(wh.url), hasSecret: !!secret }
}

function redactForRenderer(cfg) {
  const out = { ...cfg }
  for (const key of REDACTED_KEYS) {
    if (key in out) out[key] = out[key] ? SECRET_PLACEHOLDER : ''
  }
  if (Array.isArray(out.webhooks)) out.webhooks = out.webhooks.map(redactWebhook)
  return out
}

// The value a handler should use for an argument the renderer sent, which may be
// the placeholder standing in for a stored secret.
function resolveSecret(value, stored) {
  return value === SECRET_PLACEHOLDER ? stored : value
}

function isIssuedSecret(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function mergeWebhooks(current, submitted, served, newSecret) {
  if (!Array.isArray(submitted)) return current
  if (served !== undefined && isDeepStrictEqual(submitted, served)) return current
  const existing = new Map((Array.isArray(current) ? current : []).filter(w => w?.id).map(w => [w.id, w]))
  return submitted.filter(w => w && typeof w === 'object').map(wh => {
    const { urlHint: _hint, hasSecret: _has, ...rest } = wh
    const stored = wh.id ? existing.get(wh.id) : null
    const out = { ...rest, id: stored?.id || (typeof wh.id === 'string' && wh.id ? wh.id.slice(0, 64) : crypto.randomUUID()) }
    if (out.url === SECRET_PLACEHOLDER) out.url = stored?.url || ''
    // The secret is the desktop's to mint. One the renderer holds is accepted
    // only for a webhook that is new, and only in the shape webhook:create hands
    // out — an existing webhook's secret cannot be replaced from the form.
    out.secret = stored?.secret || (isIssuedSecret(wh.secret) ? wh.secret : newSecret())
    out.allowPrivateNetwork = !!wh.allowPrivateNetwork
    return out
  })
}

// current   — the config as it is on disk now
// submitted — what the renderer sent
// snapshot  — what this process served the renderer (redacted), or null when
//             the renderer did not start from a served config
function mergeRendererSave(current, submitted, snapshot, { newSecret = () => crypto.randomBytes(32).toString('hex') } = {}) {
  const merged = { ...current }
  for (const [key, value] of Object.entries(submitted || {})) {
    if (key === SNAPSHOT_KEY) continue
    if (SERVICE_OWNED.has(key)) continue
    if (key === 'webhooks') {
      merged.webhooks = mergeWebhooks(current.webhooks, value, snapshot ? snapshot.webhooks : undefined, newSecret)
      continue
    }
    if (REDACTED.has(key) && value === SECRET_PLACEHOLDER) continue
    // Untouched since it was served: whatever is on disk now is newer.
    if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, key) && isDeepStrictEqual(value, snapshot[key])) continue
    merged[key] = value
  }
  delete merged[SNAPSHOT_KEY]
  return withSessionBoundToProject(current, merged)
}

// The stored Supabase session belongs to the project it was issued by. The URL
// and anon key are ordinary Settings fields (setup has to be able to write
// them), so a compromised renderer could point them at a host it controls —
// and the next sync would rebuild the client for that host and hand it our
// refresh token in restoreSession. So a change of project is never allowed to
// inherit the session: the token, the derived data key and the enabled flag
// are dropped in the same write that changes the URL/key, and the user signs in
// again against the new project (which is what moving project means anyway).
// The email stays — it is not a credential and saves retyping.
function sameProject(a, b) {
  const norm = v => String(v || '').trim().replace(/\/+$/, '')
  return norm(a.supabaseUrl) === norm(b.supabaseUrl) && String(a.supabaseAnonKey || '').trim() === String(b.supabaseAnonKey || '').trim()
}

function withSessionBoundToProject(current, next) {
  if (sameProject(current || {}, next || {})) return next
  if (!current?.supabaseRefreshToken && !current?.cloudDataKey && !current?.cloudSyncEnabled) return next
  return { ...next, supabaseRefreshToken: '', cloudDataKey: '', cloudSyncEnabled: false }
}

// What each renderer was given, by id. Bounded: an id that has aged out simply
// means the next save falls back to "take what was changed relative to disk".
function createSnapshotStore(limit = 25) {
  const store = new Map()
  return {
    remember(served) {
      const id = crypto.randomUUID()
      const copy = { ...served }
      delete copy[SNAPSHOT_KEY]
      store.set(id, structuredClone(copy))
      while (store.size > limit) store.delete(store.keys().next().value)
      return id
    },
    get(id) {
      return typeof id === 'string' ? store.get(id) || null : null
    },
    // After a save the renderer's form IS what it submitted, so that becomes
    // the baseline its next save is compared against.
    advance(id, submitted) {
      const snap = this.get(id)
      if (!snap) return
      for (const [key, value] of Object.entries(submitted || {})) {
        if (key === SNAPSHOT_KEY || SERVICE_OWNED.has(key)) continue
        snap[key] = structuredClone(value)
      }
    },
    get size() { return store.size },
  }
}

module.exports = {
  SECRET_PLACEHOLDER, SNAPSHOT_KEY, REDACTED_KEYS, SERVICE_OWNED_KEYS,
  redactForRenderer, mergeRendererSave, withSessionBoundToProject, resolveSecret, withWebhookIdentity, createSnapshotStore, urlHint,
}
