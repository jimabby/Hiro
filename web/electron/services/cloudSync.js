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
let user = null
let syncing = false
let timer = null
let lastError = null

function getClient() {
  if (!createClient) return null
  const cfg = configService.load()
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return null
  if (!client) {
    client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
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
  const cfg = configService.load()
  configService.save({
    ...cfg,
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
    configService.save({ ...cfg, supabaseRefreshToken: data.session.refresh_token })
  }
  return true
}

async function signOut() {
  try { await getClient()?.auth.signOut() } catch {}
  user = null
  stopAuto()
  const cfg = configService.load()
  configService.save({ ...cfg, cloudSyncEnabled: false, supabaseRefreshToken: '' })
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

// Push every local application up, keyed by (user_id, local_id).
async function pushAll(c) {
  const apps = database.getApplications()
  if (apps.length === 0) return
  const rows = apps.map(localToCloud)
  // Upsert in chunks to stay well under request size limits.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await c.from('applications').upsert(chunk, { onConflict: 'user_id,local_id' })
    if (error) throw new Error(error.message)
  }
}

// Pull status/comment edits made on the phone back into the local DB.
async function pullChanges(c) {
  const { data, error } = await c
    .from('applications')
    .select('local_id, status, comment, updated_at')
    .eq('user_id', user.id)
  if (error) throw new Error(error.message)

  for (const remote of data || []) {
    if (remote.local_id == null) continue
    const local = database.getApplication(remote.local_id)
    if (!local) continue
    const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0
    const localTime = local.updated_at ? new Date(toISO(local.updated_at)).getTime() : 0
    if (remoteTime <= localTime) continue
    if (remote.status && remote.status !== local.status) {
      database.updateApplicationStatus(remote.local_id, remote.status)
    }
    if (remote.comment != null && remote.comment !== local.comment) {
      database.updateApplicationComment(remote.local_id, remote.comment)
    }
  }
}

async function sync() {
  if (syncing) return getStatus()
  const c = getClient()
  if (!c) return getStatus()
  if (!user && !(await restoreSession())) return getStatus()

  syncing = true
  try {
    await pullChanges(c) // apply phone edits first so we don't clobber them
    await pushAll(c)
    lastError = null
    const cfg = configService.load()
    configService.save({ ...cfg, lastCloudSyncAt: new Date().toISOString() })
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

module.exports = { init, signIn, signOut, sync, getStatus }
