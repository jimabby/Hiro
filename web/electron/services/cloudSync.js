// Cloud sync (Supabase). The local SQLite database stays the desktop's source
// of truth; this service mirrors applications up to Supabase so the phone can
// see them anywhere, and pulls phone-side status/comment edits back down.
// Conflicts resolve last-write-wins on `updated_at`.

const configService = require('./config')
const database = require('./database')

let createClient = null
try {
  ({ createClient } = require('@supabase/supabase-js'))
} catch {
  // Dependency not installed yet — cloud sync stays disabled until it is.
}

let client = null
let clientKey = null
let user = null
let syncing = false
let timer = null
let lastError = null

function getClient() {
  if (!createClient) return null
  const cfg = configService.load()
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return null
  // Rebuild the client if the URL/key changed in Settings — otherwise a
  // corrected key would keep using the stale client until app restart.
  const key = cfg.supabaseUrl + '\n' + cfg.supabaseAnonKey
  if (!client || clientKey !== key) {
    client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    clientKey = key
    user = null // any previous session belongs to the old project/key
  }
  return client
}

// Parse SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) into a comparable Date / ISO string.
function toISO(sqliteTime) {
  if (!sqliteTime) return null
  if (sqliteTime.includes('T')) return sqliteTime
  return sqliteTime.replace(' ', 'T') + 'Z'
}

function getStatus() {
  const cfg = configService.load()
  return {
    available: !!createClient,
    enabled: !!cfg.cloudSyncEnabled,
    configured: !!(cfg.supabaseUrl && cfg.supabaseAnonKey),
    signedIn: !!user,
    email: user?.email || cfg.supabaseEmail || null,
    syncing,
    lastSyncAt: cfg.lastCloudSyncAt || null,
    error: lastError,
  }
}

async function signIn(email, password) {
  const c = getClient()
  if (!c) throw new Error('Supabase is not configured — add your project URL and anon key first.')
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  user = data.user
  lastError = null
  configService.update({
    cloudSyncEnabled: true,
    supabaseEmail: email,
    supabaseRefreshToken: data.session?.refresh_token || '',
  })
  startAuto()
  sync().catch(() => {})
  return getStatus()
}

// Restore a session from the stored refresh token (used on app launch).
async function restoreSession() {
  const c = getClient()
  const cfg = configService.load()
  if (!c || !cfg.cloudSyncEnabled || !cfg.supabaseRefreshToken) return false
  const { data, error } = await c.auth.refreshSession({ refresh_token: cfg.supabaseRefreshToken })
  if (error || !data.session) { lastError = error?.message || 'Session expired'; return false }
  user = data.user
  lastError = null
  if (data.session.refresh_token && data.session.refresh_token !== cfg.supabaseRefreshToken) {
    configService.update({ supabaseRefreshToken: data.session.refresh_token })
  }
  return true
}

async function signOut() {
  try { await getClient()?.auth.signOut() } catch {}
  user = null
  stopAuto()
  configService.update({ cloudSyncEnabled: false, supabaseRefreshToken: '' })
  return getStatus()
}

function localToCloud(a) {
  return {
    user_id: user.id,
    local_id: a.id,
    job_title: a.job_title,
    company: a.company,
    platform: a.platform,
    salary: a.salary || '',
    job_url: a.job_url || '',
    job_description: a.job_description || '',
    match_score: a.match_score ?? null,
    match_explanation: a.match_explanation || '',
    tailored_resume: a.tailored_resume || '',
    cover_letter: a.cover_letter || '',
    screening_qa: a.screening_qa || '',
    comment: a.comment || '',
    recruiter_email: a.recruiter_email || '',
    status: a.status || 'applied',
    applied_at: toISO(a.applied_at),
    updated_at: toISO(a.updated_at),
  }
}

// Push rows with local changes the cloud hasn't seen, keyed by (user_id, local_id).
// Pushing only dirty rows (instead of everything) means a phone edit that lands
// mid-sync can no longer be blanket-overwritten by an unrelated push.
async function pushDirty(c) {
  const apps = database.getDirtyApplications()
  for (let i = 0; i < apps.length; i += 200) {
    const chunk = apps.slice(i, i + 200)
    const { error } = await c.from('applications').upsert(chunk.map(localToCloud), { onConflict: 'user_id,local_id' })
    if (error) throw new Error(error.message)
    // One database flush for the whole chunk. Each markCloudSynced is a write,
    // and sql.js serializes the entire database on every write — per-row
    // flushing meant up to 200 full-database writes per chunk.
    database.batch(() => {
      for (const a of chunk) {
        // Remember exactly which version we pushed; skipped if the row was
        // edited again while the upsert was in flight (stays dirty).
        database.markCloudSynced(a.id, toISO(a.updated_at), a.updated_at)
      }
    })
  }
}

// Pull status/comment edits made on the phone back into the local DB, and
// remove cloud rows whose local application was deleted on the desktop.
//
// A phone edit is detected by VERSION EQUALITY — "does the remote updated_at
// differ from the one we last pushed/saw (cloud_updated_at)?" — never by
// comparing the phone's clock against the desktop's, which silently dropped
// edits whenever the two clocks disagreed.
async function pullChanges(c) {
  const { data, error } = await c
    .from('applications')
    .select('local_id, status, comment, updated_at')
    .eq('user_id', user.id)
  if (error) throw new Error(error.message)

  const localIds = new Set(database.getAllApplicationIds())
  const orphans = []

  // Same reason as pushDirty: markCloudSeen/applyCloudEdit fire once per remote
  // row, and each one would otherwise serialize the whole database.
  database.batch(() => {
    for (const remote of data || []) {
      if (remote.local_id == null) continue
      if (!localIds.has(remote.local_id)) { orphans.push(remote.local_id); continue }
      const local = database.getApplication(remote.local_id)

      const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0
      const lastSeen = local.cloud_updated_at ? new Date(local.cloud_updated_at).getTime() : null
      if (lastSeen != null && remoteTime === lastSeen) continue // remote unchanged since last sync
      // Both sides changed since the last sync: the desktop wins (it owns far
      // more fields) and pushDirty will overwrite the remote copy.
      if (local.cloud_dirty) continue

      const changes = {}
      if (remote.status && remote.status !== local.status) changes.status = remote.status
      if (remote.comment != null && remote.comment !== local.comment) changes.comment = remote.comment
      if (Object.keys(changes).length > 0) {
        database.applyCloudEdit(remote.local_id, changes, remote.updated_at)
      } else {
        database.markCloudSeen(remote.local_id, remote.updated_at)
      }
    }
  })

  // The desktop is the only writer that creates rows, so a cloud row without a
  // local counterpart means the application was deleted locally — mirror that.
  for (let i = 0; i < orphans.length; i += 200) {
    const { error: delErr } = await c
      .from('applications')
      .delete()
      .eq('user_id', user.id)
      .in('local_id', orphans.slice(i, i + 200))
    if (delErr) throw new Error(delErr.message)
  }
}

// Pick up scan requests the phone queued via the cloud (scan_requests table):
// delete-then-queue, with .select() confirming which rows THIS desktop claimed,
// so a request is never queued twice even if two syncs overlap.
async function pollScanRequests(c) {
  const { data, error } = await c
    .from('scan_requests')
    .select('id, keywords, location')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) {
    // The table is optional (added later than applications) — if it doesn't
    // exist in this project yet, skip quietly rather than failing the sync.
    if (/scan_requests/.test(error.message)) return
    throw new Error(error.message)
  }
  if (!data || data.length === 0) return

  const { data: claimed, error: delErr } = await c
    .from('scan_requests')
    .delete()
    .eq('user_id', user.id)
    .in('id', data.map(r => r.id))
    .select('id, keywords, location')
  if (delErr) throw new Error(delErr.message)

  // Lazy require: scheduler requires cloudSync at module load, so a top-level
  // require here would be circular.
  const scheduler = require('./scheduler')
  for (const req of claimed || []) {
    scheduler.requestScan({ keywords: req.keywords || '', location: req.location || '', source: 'cloud' })
  }
}

// Mirror the desktop's scan-running state to the cloud (scan_status table) so
// the phone can show "scanning now…" from anywhere, not just over the LAN.
// Best-effort: a failure here must never affect the scan itself, and the table
// is optional (added later than applications) — skip quietly if it's missing.
async function updateScanStatus(running) {
  try {
    const c = getClient()
    if (!c) return
    if (!user && !(await restoreSession())) return
    await c.from('scan_status').upsert(
      { user_id: user.id, running, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  } catch { /* best-effort */ }
}

async function sync() {
  if (syncing) return getStatus()
  syncing = true // set BEFORE any await, or two callers can both enter
  try {
    const c = getClient()
    if (!c) return getStatus()
    if (!user && !(await restoreSession())) return getStatus()

    await pullChanges(c) // apply phone edits first so we don't clobber them
    await pushDirty(c)
    await pollScanRequests(c)
    lastError = null
    configService.update({ lastCloudSyncAt: new Date().toISOString() })
  } catch (err) {
    lastError = err.message
  } finally {
    syncing = false
  }
  return getStatus()
}

function startAuto() {
  if (timer) return
  timer = setInterval(() => { sync().catch(() => {}) }, 2 * 60 * 1000)
}

function stopAuto() {
  if (timer) { clearInterval(timer); timer = null }
}

// Called on app launch: restore the session and start periodic sync.
async function init() {
  const cfg = configService.load()
  if (!cfg.cloudSyncEnabled) return
  if (await restoreSession()) {
    startAuto()
    sync().catch(() => {})
  }
}

module.exports = { init, signIn, signOut, sync, getStatus, updateScanStatus }
