// Cloud sync (Supabase). The local SQLite database stays the desktop's source
// of truth; this service mirrors applications up to Supabase so the phone can
// see them anywhere, and pulls phone-side status/comment edits back down.
// Conflicts resolve last-write-wins on `updated_at`.

const configService = require('./config')
const database = require('./database')
const logger = require('./logger')
const cloudCrypto = require('./cloudCrypto')
const deviceIdentity = require('./deviceIdentity')

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
// Set when a sync pulled down rows this device had never seen, so Settings can
// say "restored 42 applications from the cloud" instead of them just appearing.
let lastRestore = null
// Set when a sync stopped because this device and the account both hold data
// and nobody has said how to combine them. Sync stays paused until they do.
let pendingFirstSync = null
// When THIS process authenticated, which is what the device list means by
// "session age" — not when the device first appeared on the account.
let sessionStartedAt = null
// Called when a device the account has never had before shows up, so the
// renderer can raise it rather than leaving it in the log.
let onNewDevice = null
let onRemoteReview = null
// A successful interactive sign-in may follow an account password reset. The
// local database is authoritative and still has the plaintext, so its first
// upload must replace payloads encrypted with the previous derived key before
// any attempt to decrypt those old cloud rows.
let pendingRekey = false
const CLOUD_PAGE_SIZE = 500

// PostgREST projects commonly cap a response at 1,000 rows. A plain select()
// therefore is not an "all rows" operation, even though it looks like one.
// Keep paging until the server returns a short page; callers use this for
// recovery and deletion bookkeeping, where silently missing the tail is data
// loss rather than a cosmetic pagination bug.
async function selectAll(buildQuery, pageSize = CLOUD_PAGE_SIZE) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const query = buildQuery()
    // Test adapters and older PostgREST-compatible clients may not expose
    // range(); retain their single-page behavior while real Supabase clients
    // always take the complete paginated path.
    const { data, error } = await (typeof query.range === 'function'
      ? query.range(from, from + pageSize - 1)
      : query)
    if (error) throw new Error(error.message)
    const page = data || []
    rows.push(...page)
    if (typeof query.range !== 'function' || page.length < pageSize) return rows
  }
}

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
    lastRestore,
    // Status is polled by the UI and can be asked for before the database has
    // finished opening — never let a status read throw.
    pendingDeletions: (() => { try { return database.getTombstones().length } catch { return 0 } })(),
    // A paused sync is not a broken one, but it is not a working one either —
    // the UI has to be able to tell the difference and say what is needed.
    pendingFirstSync,
    deviceId: cfg.deviceId || null,
    deviceName: cfg.deviceName || null,
    conflicts: (() => { try { return database.countSyncConflicts() } catch { return 0 } })(),
  }
}

// Sign in, upgrading the account to a derived auth secret if it is still on the
// raw password.
//
// The password itself must never reach Supabase — see cloudCrypto. Accounts
// created before that was true still have the raw password set, so:
//
//   1. try the derived secret (every already-upgraded account)
//   2. on failure, try the raw password — and if THAT works, this is a legacy
//      account, so immediately rotate its password to the derived secret
//
// Step 2 is the only moment the raw password is ever sent, it happens once per
// account, and the rotation closes it permanently.
async function signInWithDerivedSecret(c, email, password) {
  const { dataKey, authSecret } = cloudCrypto.deriveAccountKeys(email, password)

  const upgraded = await c.auth.signInWithPassword({ email, password: authSecret })
  if (!upgraded.error) return { session: upgraded.data, dataKey, migrated: false }

  const legacy = await c.auth.signInWithPassword({ email, password })
  if (legacy.error) {
    // Report the derived-secret failure, not the legacy one: for the ordinary
    // case of a mistyped password on an upgraded account, that is the real
    // error, and the fallback's message would only be a confusing echo.
    throw new Error(upgraded.error.message)
  }

  const { error: rotateError } = await c.auth.updateUser({ password: authSecret })
  if (rotateError) {
    // Signed in, but still on the raw password. Refuse rather than proceed:
    // continuing would encrypt this session's uploads under a key the server
    // can derive, which is precisely what this exists to prevent.
    throw new Error(`Signed in, but the account could not be upgraded to encrypted-key mode: ${rotateError.message}. Try again, or reset your password in Supabase.`)
  }
  logger.append('Cloud sync: account upgraded — the server no longer holds material that can derive your data key.')
  return { session: legacy.data, dataKey, migrated: true }
}

async function signIn(email, password) {
  const c = getClient()
  if (!c) throw new Error('Supabase is not configured — add your project URL and anon key first.')
  const { session: data, dataKey } = await signInWithDerivedSecret(c, email, password)
  user = data.user
  lastError = null
  configService.update({
    cloudSyncEnabled: true,
    supabaseEmail: email,
    supabaseRefreshToken: data.session?.refresh_token || '',
    cloudDataKey: dataKey,
  })
  // Existing cloud rows may predate end-to-end encryption. Re-upload them once
  // with encrypted_payload now that this device has the account-derived key.
  database.markAllDirty?.()
  pendingRekey = true
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
  sessionStartedAt = null
  stopAuto()
  configService.update({ cloudSyncEnabled: false, supabaseRefreshToken: '', cloudDataKey: '' })
  return getStatus()
}

function localToCloud(a) {
  const dataKey = configService.load().cloudDataKey
  const encryptedPayload = dataKey ? cloudCrypto.encrypt(dataKey, {
    job_description: a.job_description || '', tailored_resume: a.tailored_resume || '',
    cover_letter: a.cover_letter || '', screening_qa: a.screening_qa || '',
    recruiter_email: a.recruiter_email || '',
  }) : null
  return {
    user_id: user.id,
    local_id: a.id,
    job_title: a.job_title,
    company: a.company,
    platform: a.platform,
    salary: a.salary || '',
    salary_min: a.salary_min ?? null,
    salary_max: a.salary_max ?? null,
    job_url: a.job_url || '',
    job_description: encryptedPayload ? null : (a.job_description || ''),
    match_score: a.match_score ?? null,
    match_explanation: a.match_explanation || '',
    tailored_resume: encryptedPayload ? null : (a.tailored_resume || ''),
    cover_letter: encryptedPayload ? null : (a.cover_letter || ''),
    screening_qa: encryptedPayload ? null : (a.screening_qa || ''),
    comment: a.comment || '',
    recruiter_email: encryptedPayload ? null : (a.recruiter_email || ''),
    encrypted_payload: encryptedPayload,
    status: a.status || 'applied',
    // Which resume was sent, and whether review mode is still holding this
    // back — the phone needs both to label the row honestly.
    resume_id: a.resume_id || null,
    resume_name: a.resume_name || null,
    campaign_id: a.campaign_id || null,
    campaign_name: a.campaign_name || null,
    held_at: a.held_at ? toISO(a.held_at) : null,
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
  // Full rows, not just the editable columns: a row this device has never seen
  // has to be reconstructable locally, and the cloud is the only copy left.
  const data = await selectAll(() => c
    .from('applications')
    .select('*')
    .eq('user_id', user.id)
    .order('local_id', { ascending: true }))

  const localIds = new Set(database.getAllApplicationIds())
  // Deletions this desktop actually performed. Only these may be removed from
  // the cloud — see the note above pullChanges.
  const tombstoned = new Set(database.getTombstones())
  const toDeleteRemotely = []
  const restored = []

  // Same reason as pushDirty: markCloudSeen/applyCloudEdit fire once per remote
  // row, and each one would otherwise serialize the whole database.
  const dataKey = configService.load().cloudDataKey
  let obsoleteRows = 0

  database.batch(() => {
    for (const remote of data || []) {
      if (remote.encrypted_payload) {
        // A row this device cannot decrypt is not a reason to abandon the pull.
        // It used to be: the throw escaped the loop and every remaining row —
        // including perfectly readable ones — was skipped for good.
        //
        // The documents are the only encrypted part; status, comment and the
        // rest of the row travel in clear, so the row is still worth applying.
        // Encrypted fields simply stay as the desktop already has them, and
        // pushDirty re-uploads them under the current key.
        try {
          Object.assign(remote, cloudCrypto.decrypt(dataKey, remote.encrypted_payload) || {})
        } catch (err) {
          if (!err.obsoleteEnvelope) throw err
          obsoleteRows++
          delete remote.encrypted_payload
        }
      }
      if (remote.local_id == null) continue
      if (!localIds.has(remote.local_id)) {
        // Absent locally means one of two very different things, and the old
        // code assumed the destructive one for both.
        if (tombstoned.has(remote.local_id)) {
          toDeleteRemotely.push(remote.local_id)
        } else {
          // Never seen here: fresh install, reset machine, or a row created on
          // another desktop. Pull it down rather than destroying it.
          database.restoreApplicationFromCloud(remote)
          restored.push(remote.local_id)
        }
        continue
      }
      const local = database.getApplication(remote.local_id)

      const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0
      const lastSeen = local.cloud_updated_at ? new Date(local.cloud_updated_at).getTime() : null
      if (lastSeen != null && remoteTime === lastSeen) continue // remote unchanged since last sync
      // Both sides changed since the last sync: the desktop wins (it owns far
      // more fields) and pushDirty will overwrite the remote copy.
      //
      // Log what is being discarded before discarding it. The rule is right,
      // but silence made it indistinguishable from data loss — a status set on
      // the phone disappeared with no record it had ever existed.
      if (local.cloud_dirty) {
        for (const field of ['status', 'comment']) {
          const remoteValue = remote[field]
          if (remoteValue == null || remoteValue === local[field]) continue
          try {
            database.recordSyncConflict({
              applicationId: remote.local_id,
              field,
              localValue: local[field],
              remoteValue,
              resolvedAs: 'local-kept',
            })
          } catch { /* the log must never break a sync */ }
        }
        continue
      }

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

  // Mirror only deletions this desktop explicitly recorded. Tombstones are
  // cleared per chunk AFTER the delete is confirmed, so an interrupted sync
  // retries the rest next pass instead of dropping them silently.
  for (let i = 0; i < toDeleteRemotely.length; i += 200) {
    const chunk = toDeleteRemotely.slice(i, i + 200)
    const { error: delErr } = await c
      .from('applications')
      .delete()
      .eq('user_id', user.id)
      .in('local_id', chunk)
    if (delErr) throw new Error(delErr.message)
    database.clearTombstones(chunk)
  }

  // A tombstone whose row is no longer in the cloud has already been mirrored
  // (or never reached it). Without this the table would grow without bound and
  // re-issue a delete for the same id on every sync, forever.
  const remoteIds = new Set((data || []).map(r => r.local_id))
  const settled = [...tombstoned].filter(id => !remoteIds.has(id))
  if (settled.length > 0) database.clearTombstones(settled)

  // Rows still encrypted under a retired key. They are re-uploaded under the
  // current one by the next pushDirty (sign-in marks everything dirty), so this
  // is a progress note rather than a fault — but a silent one would look like
  // documents had gone missing from the phone.
  if (obsoleteRows > 0) {
    logger.append(`Cloud sync: ${obsoleteRows} row(s) still hold documents encrypted with a retired key — re-uploading them under the current key.`)
    database.markAllDirty?.()
  }

  return { restored: restored.length, deleted: toDeleteRemotely.length, obsolete: obsoleteRows }
}

// ─── One-way mirrors (desktop → cloud) ───────────────────────────
// Interviews and attention jobs are desktop-owned: the phone only reads them,
// so these push the full current set and delete anything the cloud still has
// that no longer exists locally. Both tables are optional (added later than
// `applications`) — a project that hasn't re-run schema.sql skips them quietly
// rather than failing the whole sync.
//
// Full-set replacement rather than dirty-tracking: both tables are small
// (dozens of rows), and the alternative is another pair of bookkeeping columns
// for data the phone can't edit anyway.
// "Does this project have the table yet?" — NOT "does the message mention the
// table name?". The old substring test matched any error quoting the table,
// including RLS denials ("new row violates row-level security policy for table
// \"attention_jobs\"") and permission errors, so a genuinely broken mirror was
// silently treated as an optional feature that wasn't set up and skipped
// forever. PostgREST reports an unknown relation as PGRST205/42P01.
const MISSING_TABLE_CODES = new Set(['PGRST205', 'PGRST202', '42P01'])

function isMissingTable(error, table) {
  if (!error) return false
  if (error.code && MISSING_TABLE_CODES.has(error.code)) return true
  // Fall back to the message only for the shapes that unambiguously mean the
  // relation does not exist — never a bare table-name match.
  const msg = String(error.message || '')
  return new RegExp(
    `(could not find the table|relation) [^]*${table}[^]*(in the schema cache|does not exist)`, 'i'
  ).test(msg)
}

async function mirrorTable(c, table, rows, toCloud) {
  const payload = rows.map(toCloud)
  if (payload.length > 0) {
    for (let i = 0; i < payload.length; i += 200) {
      const { error } = await c.from(table).upsert(payload.slice(i, i + 200), { onConflict: 'user_id,local_id' })
      if (error) {
        if (isMissingTable(error, table)) return { skipped: true }
        throw new Error(error.message)
      }
    }
  }

  // Remove cloud rows whose local counterpart is gone. `not in` with an empty
  // list is invalid, so an empty local set is a plain delete-all instead.
  const keep = rows.map(r => r.id)
  let del = c.from(table).delete().eq('user_id', user.id)
  if (keep.length > 0) del = del.not('local_id', 'in', `(${keep.join(',')})`)
  const { error: delErr } = await del
  if (delErr) {
    if (isMissingTable(delErr, table)) return { skipped: true }
    throw new Error(delErr.message)
  }
  return { skipped: false, count: payload.length }
}

async function pushInterviews(c) {
  const rows = database.getAllInterviewEventsForSync()
  return mirrorTable(c, 'interview_events', rows, (e) => ({
    user_id: user.id,
    local_id: e.id,
    application_local_id: e.application_id,
    scheduled_at: e.scheduled_at,
    has_time: e.has_time === 1 || e.has_time === true,
    source: e.source || 'manual',
    note: e.note || '',
    job_title: e.job_title || '',
    company: e.company || '',
    platform: e.platform || '',
    updated_at: new Date().toISOString(),
  }))
}

async function pushAttentionJobs(c) {
  const rows = database.getAttentionJobs()
  return mirrorTable(c, 'attention_jobs', rows, (j) => ({
    user_id: user.id,
    local_id: j.id,
    job_title: j.job_title,
    company: j.company,
    platform: j.platform,
    salary: j.salary || '',
    salary_min: j.salary_min ?? null,
    salary_max: j.salary_max ?? null,
    job_url: j.job_url || '',
    match_score: j.match_score ?? null,
    talking_points: j.talking_points || '[]',
    reason: j.reason || '',
    closing_date: j.closing_date || null,
    found_at: toISO(j.found_at),
    updated_at: new Date().toISOString(),
  }))
}

// Pick up scan requests the phone queued via the cloud (scan_requests table):
// delete-then-queue, with .select() confirming which rows THIS desktop claimed,
// so a request is never queued twice even if two syncs overlap.
async function pollScanRequests(c) {
  let data
  try {
    data = await selectAll(() => c
      .from('scan_requests')
      .select('id, keywords, location')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true }))
  } catch (error) {
    // The table is optional (added later than applications) — if it doesn't
    // exist in this project yet, skip quietly rather than failing the sync.
    // Anything else (RLS, permissions, network) is a real failure and must
    // surface, or a broken mirror looks like an unconfigured one.
    if (isMissingTable(error, 'scan_requests')) return
    throw error
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

async function pollReviewRequests(c) {
  if (!onRemoteReview) return
  let pending
  try {
    pending = await selectAll(() => c.from('review_requests')
      .select('id, application_local_id, action')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true }))
  } catch (error) {
    if (isMissingTable({ message: error.message }, 'review_requests')) return
    throw error
  }
  if (!pending.length) return
  const { data: claimed, error } = await c.from('review_requests').delete()
    .eq('user_id', user.id).in('id', pending.map(r => r.id))
    .select('id, application_local_id, action')
  if (error) throw new Error(error.message)
  for (const request of claimed || []) {
    try {
      await onRemoteReview(request)
      logger.append(`Cloud review: ${request.action} processed for application ${request.application_local_id}`)
    } catch (err) {
      // A browser session may be temporarily unavailable. Put the command back
      // rather than turning a phone's visible "queued" confirmation into loss.
      await c.from('review_requests').upsert({
        id: request.id, user_id: user.id, application_local_id: request.application_local_id,
        action: request.action,
      })
      logger.append(`Cloud review deferred for application ${request.application_local_id}: ${err.message}`)
    }
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

// ─── First-sync gate and device registration ─────────────────────

// Count both sides without modifying either.
async function checkFirstSync(c) {
  const cfg = deviceIdentity.ensureDeviceIdentity(configService)
  const localCount = database.countApplications()
  const { count, error } = await c
    .from('applications')
    .select('local_id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if (error) throw new Error(error.message)
  const remoteCount = count || 0

  const mode = deviceIdentity.resolveFirstSyncMode(cfg, { localCount, remoteCount })
  return { needsChoice: mode === 'ask', mode, localCount, remoteCount }
}

// Record the user's answer and let the next sync run.
//
// 'cloud' and 'local' are implemented as one-off preparations, after which the
// ordinary merge machinery is correct: wiping the losing side first means the
// existing pull/push does exactly the right thing with no special-casing
// scattered through it.
async function resolveFirstSync(choice) {
  if (!deviceIdentity.isValidChoice(choice)) {
    return { success: false, reason: `Unknown choice: ${choice}` }
  }
  const c = getClient()
  if (!c) return { success: false, reason: 'Supabase is not configured.' }
  if (!user && !(await restoreSession())) return { success: false, reason: 'Not signed in.' }

  try {
    if (choice === 'cloud') {
      // Discard local history and take the account's copy.
      //
      // Order matters and the obvious order is wrong: clearAllApplications
      // tombstones everything it removes, so clearing first and wiping second
      // leaves a full set of tombstones that the next pull would replay as
      // deletions against the very cloud rows being restored — destroying the
      // account's data instead of copying it.
      database.clearAllApplications()
      database.clearTombstones(database.getTombstones())
    } else if (choice === 'local') {
      const { error } = await c.from('applications').delete().eq('user_id', user.id)
      if (error) throw new Error(error.message)
      database.markAllDirty()
    }
    configService.update({ cloudFirstSyncChoice: choice })
    pendingFirstSync = null
    logger.append(`Cloud sync: first-sync choice recorded as "${choice}".`)
    await sync()
    return { success: true, choice }
  } catch (err) {
    return { success: false, reason: err.message }
  }
}

// Announce this device on the account so the user can see what is attached and
// cut off anything they no longer control. Best-effort: an older project without
// the table must not fail the whole sync.
//
// Also the point at which a NEW device on the account becomes visible. A phone
// that signs in registers itself here, and the account owner should hear about
// that from Hiro rather than find out later — so the first time this desktop
// sees a device id it has never seen, it says so.
async function registerDevice(c) {
  const cfg = deviceIdentity.ensureDeviceIdentity(configService)
  // sessionStartedAt is when THIS process authenticated, which is what the
  // device list means by "session age". It is not created_at (when the device
  // first appeared) and not last_seen_at (a heartbeat).
  if (!sessionStartedAt) sessionStartedAt = new Date().toISOString()

  // An array, like every other upsert here. A bare object works against real
  // PostgREST and breaks anything that treats the payload as a list.
  const { error } = await c.from('devices').upsert([{
    user_id: user.id,
    device_id: cfg.deviceId,
    name: cfg.deviceName,
    platform: process.platform,
    kind: 'desktop',
    app_version: appVersion(),
    session_started_at: sessionStartedAt,
    last_seen_at: new Date().toISOString(),
  }], { onConflict: 'user_id,device_id' })
  if (error) {
    // A project that predates the app_version/session_started_at columns must
    // still be able to register — re-running schema.sql is the fix, and until
    // then the device list is merely less detailed rather than empty.
    if (isMissingTable(error, 'devices')) return
    if (isMissingColumn(error)) {
      const { error: retry } = await c.from('devices').upsert([{
        user_id: user.id,
        device_id: cfg.deviceId,
        name: cfg.deviceName,
        platform: process.platform,
        kind: 'desktop',
        last_seen_at: new Date().toISOString(),
      }], { onConflict: 'user_id,device_id' })
      if (retry && !isMissingTable(retry, 'devices')) throw new Error(retry.message)
      return
    }
    throw new Error(error.message)
  }
}

function appVersion() {
  try { return require('electron').app.getVersion() } catch { return '' }
}

// PostgREST reports an unknown column as PGRST204, or 42703 from Postgres.
function isMissingColumn(error) {
  if (!error) return false
  if (error.code === 'PGRST204' || error.code === '42703') return true
  return /could not find the '.*' column|column .* does not exist/i.test(String(error.message || ''))
}

// Cooperative revocation, the receiving half.
//
// Supabase gives a signed-in client no way to invalidate ANOTHER client's
// refresh token — that needs the service-role admin API, which must never ship
// inside a desktop app. So "revoke" sets a flag on the device row and every
// device is responsible for honouring its own: when this desktop finds its row
// stamped revoked, it signs itself out and wipes the stored refresh token.
//
// The limitation is real and is stated in the UI: it works on a device that is
// still running and online, and does nothing for one that is switched off. For a
// lost phone, signOutEverywhere() below is the authoritative answer.
async function checkRevocation(c) {
  const cfg = configService.load()
  if (!cfg.deviceId) return false
  const { data, error } = await c
    .from('devices')
    .select('revoked_at')
    .eq('user_id', user.id)
    .eq('device_id', cfg.deviceId)
    .maybeSingle()
  // A missing table or column means the project has not been upgraded; a missing
  // ROW means this device was hard-removed from the list, which is not by itself
  // a revocation (registerDevice will recreate it).
  if (error) return false
  if (!data?.revoked_at) return false

  logger.append('Cloud sync: this device was revoked from the account — signing out and clearing the stored session.')
  // Clear the flag on the way out so the row does not sit revoked forever if the
  // user signs back in on purpose.
  try {
    await c.from('devices').update({ revoked_at: null, push_token: null })
      .eq('user_id', user.id).eq('device_id', cfg.deviceId)
  } catch { /* the sign-out matters more */ }
  await signOut()
  lastError = 'This device was revoked from the account. Sign in again to resume syncing.'
  return true
}

async function listDevices() {
  const c = getClient()
  if (!c) return []
  if (!user && !(await restoreSession())) return []
  const { data, error } = await c
    .from('devices')
    .select('*')
    .eq('user_id', user.id)
    .order('last_seen_at', { ascending: false })
  if (error) {
    if (isMissingTable(error, 'devices')) return []
    throw new Error(error.message)
  }
  const cfg = configService.load()
  const now = Date.now()
  const ageDays = (t) => (t ? Math.floor((now - new Date(t).getTime()) / 86400000) : null)
  return (data || []).map(d => ({
    ...d,
    isThisDevice: d.device_id === cfg.deviceId,
    // How long this device's session has been alive, and how long since it last
    // checked in. A device that stopped checking in weeks ago is the one worth
    // asking about.
    sessionAgeDays: ageDays(d.session_started_at || d.created_at),
    lastSeenDaysAgo: ageDays(d.last_seen_at),
    // Revoked but still listed: the flag is set and the device has not yet come
    // online to honour it.
    revokePending: !!d.revoked_at,
    pushRegistered: !!d.push_token,
  }))
}

// Cooperative revocation, the sending half. See checkRevocation.
async function revokeDevice(deviceId) {
  const cfg = configService.load()
  if (deviceId === cfg.deviceId) {
    return { success: false, reason: 'This is the device you are using — sign out instead.' }
  }
  const c = getClient()
  if (!c) return { success: false, reason: 'Supabase is not configured.' }
  if (!user && !(await restoreSession())) return { success: false, reason: 'Not signed in.' }
  // The push token goes immediately: that part IS enforceable from here, so a
  // revoked phone stops receiving notifications straight away even if it never
  // comes online to sign itself out.
  const { error } = await c.from('devices')
    .update({ revoked_at: new Date().toISOString(), push_token: null })
    .eq('user_id', user.id)
    .eq('device_id', deviceId)
  if (error) {
    if (isMissingColumn(error)) {
      return { success: false, reason: 'This needs the revoked_at column — re-run supabase/schema.sql in your project.' }
    }
    return { success: false, reason: error.message }
  }
  logger.append(`Cloud sync: marked device ${deviceId} revoked; it will sign itself out on next contact.`)
  return { success: true, pending: true }
}

// Drop a device from the list entirely. This is bookkeeping, not security: it
// says "I do not expect to see this device again". A device that is still signed
// in will simply re-register itself, which is why revokeDevice exists separately.
async function forgetDevice(deviceId) {
  const c = getClient()
  if (!c) return { success: false, reason: 'Supabase is not configured.' }
  if (!user && !(await restoreSession())) return { success: false, reason: 'Not signed in.' }
  const { error } = await c.from('devices').delete().eq('user_id', user.id).eq('device_id', deviceId)
  if (error) return { success: false, reason: error.message }
  // Forget it locally too, or the next sync would announce it as a new device.
  const known = (configService.load().knownDeviceIds || []).filter(id => id !== deviceId)
  configService.update({ knownDeviceIds: known })
  logger.append(`Cloud sync: removed device ${deviceId} from the list.`)
  return { success: true }
}

// The authoritative one. Supabase honours a global sign-out server-side by
// invalidating every refresh token on the account — including this desktop's —
// so it is the only action here that genuinely stops a device that is switched
// off, wiped, or in someone else's hands.
//
// It signs this desktop out too. That is not a shortcoming to work around; a
// scope that spared the caller would leave the account's most privileged session
// alive, and the user has this desktop in front of them to sign back in with.
async function signOutEverywhere() {
  const c = getClient()
  if (!c) return { success: false, reason: 'Supabase is not configured.' }
  if (!user && !(await restoreSession())) return { success: false, reason: 'Not signed in.' }
  try {
    // Clear the registry and every push token first: after the sign-out this
    // client has no authority to write to those rows.
    try {
      await c.from('devices').delete().eq('user_id', user.id)
    } catch { /* the sign-out is what matters */ }
    const { error } = await c.auth.signOut({ scope: 'global' })
    if (error) throw new Error(error.message)
  } catch (err) {
    return { success: false, reason: err.message }
  }
  user = null
  stopAuto()
  configService.update({ cloudSyncEnabled: false, supabaseRefreshToken: '', cloudDataKey: '', knownDeviceIds: [] })
  logger.append('Cloud sync: signed out every device on the account (all refresh tokens invalidated).')
  return { success: true }
}

// Tell the user when something new attaches itself to their account. Compared
// against a locally-remembered set rather than created_at, so a desktop that was
// switched off for a week still reports the phone that signed in on Tuesday
// exactly once.
async function announceNewDevices(devices) {
  const cfg = configService.load()
  const known = new Set(cfg.knownDeviceIds || [])
  const seen = devices.map(d => d.device_id)

  // First run has nothing to compare against: every device would be "new",
  // including this one. Record and stay quiet.
  if (!Array.isArray(cfg.knownDeviceIds)) {
    configService.update({ knownDeviceIds: seen })
    return
  }

  const fresh = devices.filter(d => !known.has(d.device_id) && d.device_id !== cfg.deviceId)
  if (fresh.length === 0) {
    if (seen.length !== known.size || seen.some(id => !known.has(id))) {
      configService.update({ knownDeviceIds: seen })
    }
    return
  }

  configService.update({ knownDeviceIds: seen })
  for (const d of fresh) {
    logger.append(`Cloud sync: new device on the account — ${d.name || d.device_id} (${d.platform || d.kind || 'unknown'})`)
    try { await require('./push').notifyNewDevice(d) } catch { /* best-effort */ }
    onNewDevice?.(d)
  }
}

// ─── Push token registry ─────────────────────────────────────────
// Phones register an Expo push token on their own device row; the desktop reads
// them to send notifications. Keeping the tokens on the device row rather than in
// a table of their own means revoking a device revokes its notifications too,
// with no second place to remember.

async function getPushTargets() {
  const c = getClient()
  if (!c) return []
  if (!user && !(await restoreSession())) return []
  const { data, error } = await c
    .from('devices')
    .select('device_id, push_token, push_enabled, revoked_at')
    .eq('user_id', user.id)
  if (error) return []
  return (data || [])
    .filter(d => d.push_token && d.push_enabled !== false && !d.revoked_at)
    .map(d => ({ deviceId: d.device_id, token: d.push_token }))
}

async function clearPushToken(deviceId) {
  const c = getClient()
  if (!c) return { success: false }
  if (!user && !(await restoreSession())) return { success: false }
  const { error } = await c.from('devices').update({ push_token: null })
    .eq('user_id', user.id).eq('device_id', deviceId)
  return { success: !error }
}

async function sync() {
  if (syncing) return getStatus()
  syncing = true // set BEFORE any await, or two callers can both enter
  try {
    const c = getClient()
    if (!c) return getStatus()
    if (!user && !(await restoreSession())) return getStatus()

    // Before anything is read or written: has this device been cut off? Syncing
    // first and checking afterwards would push a revoked device's data up one
    // last time, which is precisely what revoking it was meant to stop.
    if (await checkRevocation(c)) return getStatus()

    // First contact with an account that already holds data. Stop before
    // touching anything in either direction — merging is only one of three
    // reasonable answers and the wrong one is destructive.
    const gate = await checkFirstSync(c)
    if (gate.needsChoice) {
      pendingFirstSync = gate
      logger.append(`Cloud sync paused: this device has ${gate.localCount} application(s) and the account has ${gate.remoteCount}. Choose how to combine them in Settings.`)
      return getStatus()
    }

    if (pendingRekey) {
      await pushDirty(c)
      pendingRekey = false
    }
    const pulled = await pullChanges(c) // normally apply phone edits first so we don't clobber them
    // Recovering rows from the cloud is a significant, user-visible event (it
    // is what a reinstall looks like) — report it rather than letting the
    // database silently repopulate.
    if (pulled && pulled.restored > 0) {
      lastRestore = { count: pulled.restored, at: new Date().toISOString() }
      logger.append(`Cloud sync restored ${pulled.restored} application(s) not present on this device`)
    }
    await pushDirty(c)
    // Desktop-owned mirrors. Pushed after applications so an interview always
    // lands alongside an application row the phone can already resolve.
    await pushInterviews(c)
    await pushAttentionJobs(c)
    await pollScanRequests(c)
    await pollReviewRequests(c)
    await registerDevice(c)
    // Reading the list back is also how a new device on the account is noticed;
    // never let that reporting break a sync that otherwise succeeded.
    try { await announceNewDevices(await listDevices()) } catch { /* best-effort */ }
    // Clock-driven notifications (interview reminders, closing dates, the review
    // queue) piggyback on the sync timer rather than owning one — the dedupe
    // ledger makes running them often free.
    try { await require('./push').runDueChecks() } catch { /* best-effort */ }
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
async function init(hooks = {}) {
  onNewDevice = hooks.onNewDevice || null
  onRemoteReview = hooks.onRemoteReview || null
  const cfg = configService.load()
  if (!cfg.cloudSyncEnabled) return
  if (await restoreSession()) {
    startAuto()
    sync().catch(() => {})
  }
}

module.exports = {
  init, signIn, signOut, sync, getStatus, updateScanStatus,
  resolveFirstSync, selectAll,
  listDevices, revokeDevice, forgetDevice, signOutEverywhere,
  getPushTargets, clearPushToken,
}
