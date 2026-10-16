// Supabase client + a data client that mirrors HiroClient's interface so the
// existing screens work unchanged whether the data comes from the desktop over
// LAN or from the cloud. Configure via app/.env:
//   EXPO_PUBLIC_SUPABASE_URL=...
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=...
import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
// The session Supabase persists here is a refresh token with full access to the
// user's cloud account, so it belongs in the Keychain/Keystore, not in an
// unencrypted AsyncStorage file. See src/secureStore.js.
import secureStore from './secureStore'

const url = process.env.EXPO_PUBLIC_SUPABASE_URL
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY

export const isConfigured = !!(url && anonKey)

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        storage: secureStore,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null

// Permanently delete the signed-in user's cloud account. The delete_account
// Postgres function (supabase/schema.sql) removes the auth user, and cascading
// foreign keys wipe their applications, scan requests, and scan status with it.
// Required for App Store guideline 5.1.1(v) — apps with account creation must
// offer account deletion in-app. Desktop-local data is untouched.
export async function deleteAccount() {
  const { error } = await supabase.rpc('delete_account')
  if (error) {
    if (/delete_account/i.test(error.message)) {
      throw new Error('Account deletion needs the delete_account function — re-run supabase/schema.sql in your project.')
    }
    throw new Error(error.message)
  }
  // The auth user is gone; drop the now-invalid local session too.
  try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* session already invalid */ }
}

// The stats/chart derivations live in src/stats.js as pure functions. They used
// to be inline here, which is how they drifted from the desktop's getStats() —
// the phone went on counting skipped and held rows as applications long after the
// desktop stopped. Extracted so a test can pin the two together.
import { deriveStats, derivePerDay, isUnsent } from './stats'
import { isDueOrOverdue, todayLocal, daysBetweenDates } from './dates'
import { randomUUID } from 'expo-crypto'
import { decryptCloudPayload, encryptCloudPayload, rowContext } from './cloudCrypto'

const VALID_STATUSES = ['applied', 'interview', 'offer', 'rejected', 'pending', 'no_response', 'skipped', 'held', 'withdrawn']

// Columns the list/stats screens actually need. Selecting * pulled every
// cover letter, tailored resume, and job description over cellular on each
// refresh (the LAN API slims list responses the same way).
// `encrypted_meta` carries the identifying fields — job title, company, URL,
// salary text, the match explanation and the user's comment — which used to
// travel in clear. It is a few hundred bytes and is deliberately separate from
// encrypted_payload (the documents), so this list stays cheap on cellular while
// still not handing the server the names of every employer applied to.
const LEGACY_COLUMNS = 'id, local_id, job_title, company, platform, salary, match_score, match_explanation, status, applied_at, updated_at, comment'
// Added later than the rest. A project that has not re-run schema.sql does not
// have them, and naming a missing column fails the WHOLE select — which would
// take the applications list down rather than degrade the follow-up feature. So
// they are requested separately and dropped on the first failure.
const PIPELINE_COLUMNS = 'next_action_at, next_action_note'
const BASE_COLUMNS = `${LEGACY_COLUMNS}, encrypted_meta, encrypted_comment`
const SLIM_COLUMNS = `${BASE_COLUMNS}, ${PIPELINE_COLUMNS}`
// Widest first, then drop one late addition at a time. Each tier is tried once
// and the working one is remembered, so a project on an older schema pays for
// the discovery a single time rather than on every refresh.
const COLUMN_TIERS = [SLIM_COLUMNS, BASE_COLUMNS, `${LEGACY_COLUMNS}, encrypted_meta`, LEGACY_COLUMNS]
const CLOUD_PAGE_SIZE = 500

async function selectAll(buildQuery, pageSize = CLOUD_PAGE_SIZE) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}

// Reads/writes the shared `applications` table. Exposes the same methods the
// screens already call on HiroClient (getStats, getApplications, getApplication,
// updateStatus, updateComment, getPerDay) so screens need no changes.
export class CloudClient {
  constructor(userId) {
    this.userId = userId
    this.queueDestination = { key: `cloud:${url}:${userId}`, label: `Cloud account ${userId.slice(0, 8)} · ${url}` }
    // Scans still run on the desktop, but they CAN be requested through the
    // cloud: we insert into scan_requests and the desktop picks it up on its
    // next sync cycle (~2 minutes).
    this.canScan = true
    this._cache = null // short-lived shared fetch: stats + chart + list reuse one download
    // Narrowed to BASE_COLUMNS once if this project's schema predates the
    // pipeline columns; see _fetchAll.
    this._columns = null
  }

  // Screens use the cloud UUID; installation-local integers are only for legacy deep links.
  _map(row) {
    return { ...row, id: row.id ?? row.local_id }
  }

  // Merge a row's encrypted metadata back over its blanked plaintext columns.
  //
  // Tolerant in both directions of version skew, which matters because the
  // desktop and the phone update independently: a row written by an older
  // desktop has no encrypted_meta and its plaintext columns are already correct,
  // so this is a no-op. A row this device cannot decrypt keeps whatever the
  // columns hold rather than failing the whole list — one unreadable row must
  // never be able to blank the screen.
  //
  // Envelopes are checked against the row they were found on (see rowContext),
  // so one copied over from another application is refused instead of shown.
  // The comment envelope is applied after meta: the phone rewrites only
  // encrypted_comment, so the copy inside meta can be older.
  async _withMeta(row, table = 'applications') {
    if (!row) return row
    const where = (column) => (typeof row.id === 'string' ? rowContext(table, row.id, column) : null)
    try {
      if (row.encrypted_meta) Object.assign(row, await decryptCloudPayload(row.encrypted_meta, where('encrypted_meta')) || {})
      if (row.encrypted_comment) Object.assign(row, await decryptCloudPayload(row.encrypted_comment, where('encrypted_comment')) || {})
    } catch {
      row.meta_pending = true
    }
    delete row.encrypted_meta
    return row
  }

  async _fetchAll() {
    const fetch = (columns) => selectAll(() => supabase
      .from('applications')
      .select(columns)
      .eq('user_id', this.userId)
      .order('applied_at', { ascending: false }).order('id', { ascending: true }))

    // PostgREST reports an unknown column as PGRST204 / 42703. Walk down the
    // tiers until one works, then remember it.
    const isMissingColumn = (err) => !!err && (
      err.code === 'PGRST204' || err.code === '42703'
      || /next_action|encrypted_meta/.test(err.message || '')
    )

    let data, error
    if (this._columns) {
      ;({ data, error } = await fetch(this._columns))
    } else {
      for (const tier of COLUMN_TIERS) {
        ;({ data, error } = await fetch(tier))
        if (!error) { this._columns = tier; break }
        if (!isMissingColumn(error)) break
      }
    }
    if (error) throw new Error(error.message)
    // Decryption is per row and async (WebCrypto), so the list is resolved in
    // one pass rather than lazily per screen — every consumer of _all() expects
    // plain rows.
    return Promise.all((data || []).map(async r => this._map(await this._withMeta(r))))
  }

  // Dashboard loads stats and the 7-day chart together; each derived from the
  // full list. Share one in-flight/recent fetch instead of downloading the
  // table two or three times per screen.
  _all() {
    const now = Date.now()
    if (!this._cache || now - this._cache.at > 5000) {
      const promise = this._fetchAll().catch(err => {
        if (this._cache?.promise === promise) this._cache = null
        throw err
      })
      this._cache = { at: now, promise }
    }
    return this._cache.promise
  }

  async getApplications({ status, platform, search } = {}) {
    let rows = await this._all()
    if (status) rows = rows.filter(a => a.status === status)
    if (platform) rows = rows.filter(a => a.platform === platform)
    if (search) {
      const s = search.toLowerCase()
      rows = rows.filter(a =>
        (a.job_title || '').toLowerCase().includes(s) ||
        (a.company || '').toLowerCase().includes(s))
    }
    return rows
  }

  async getApplication(id) {
    const { data, error } = await supabase
      .from('applications')
      .select('*')
      .eq('user_id', this.userId)
      .eq(typeof id === 'number' ? 'local_id' : 'id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    await this._withMeta(data)
    if (data.encrypted_payload) {
      // A payload under a retired key must not make the whole application
      // unopenable — the title, company, status and score are unencrypted and
      // are most of what this screen shows. Surface the documents as pending
      // instead of failing the read.
      try {
        Object.assign(data, await decryptCloudPayload(data.encrypted_payload, rowContext('applications', data.id, 'encrypted_payload')) || {})
      } catch (err) {
        if (!err.obsoleteEnvelope) throw err
        data.documents_pending = 'Documents are still encrypted with a retired key. Open Hiro on the desktop to re-upload them.'
      }
    }
    return this._map(data)
  }

  async getChecklist(id) {
    const row = await this.getApplication(id)
    if (!row) throw new Error('Application not found.')
    const value = row.encrypted_checklist ? await decryptCloudPayload(row.encrypted_checklist, rowContext('applications', row.id, 'encrypted_checklist')) : null
    return JSON.parse(value?.checklist || '[]')
  }

  async updateChecklist(id, change) {
    const row = await this.getApplication(id)
    if (!row) throw new Error('Application not found.')
    const value = row.encrypted_checklist ? await decryptCloudPayload(row.encrypted_checklist, rowContext('applications', row.id, 'encrypted_checklist')) : null
    const items = JSON.parse(value?.checklist || '[]')
    const existing = items.find(t => t.id === change.id)
    if (change.id && !existing) throw new Error('This task has changed. Refresh and try again.')
    if (change.remove) {
      if (!existing) throw new Error('Task not found.')
      items.splice(items.indexOf(existing), 1)
    }
    else {
      const title = String(change.title ?? existing?.title ?? '').trim().slice(0, 200)
      const due = change.due ?? existing?.due ?? ''
      if (!title) throw new Error('Task title is required.')
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Use a YYYY-MM-DD due date.')
      if (!existing && items.length >= 100) throw new Error('An application can have at most 100 tasks.')
      const item = { id: existing?.id || randomUUID(), title, due, done: !!(change.done ?? existing?.done ?? false) }
      if (existing) items[items.indexOf(existing)] = item
      else items.push(item)
    }
    const encrypted = await encryptCloudPayload({ checklist: JSON.stringify(items) }, rowContext('applications', row.id, 'encrypted_checklist'))
    // Refuse a stale read-modify-write rather than silently erase another device's task.
    const { data, error } = await supabase.from('applications').update({ encrypted_checklist: encrypted, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId).eq('id', row.id).eq('updated_at', row.updated_at).select('id')
    if (error) throw new Error(error.message)
    if (!data?.length) throw new Error('The application changed on another device. Refresh and try again.')
    this._cache = null
    return items
  }

  async updateStatus(id, status) {
    if (!VALID_STATUSES.includes(status)) throw new Error('Invalid application status.')
    const { error } = await supabase
      .from('applications')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq(typeof id === 'number' ? 'local_id' : 'id', id)
    if (error) throw new Error(error.message)
    this._cache = null // next read must see the edit
    return { success: true }
  }

  async updateComment(id, comment) {
    comment = String(comment || '').slice(0, 5000)
    // Bound to this row when the row is addressed by its cloud id. A legacy
    // numeric id cannot be bound here; the desktop rebinds it on its next push.
    const context = typeof id === 'string' ? rowContext('applications', id, 'encrypted_comment') : null
    const { error } = await supabase
      .from('applications')
      .update({ comment: '', encrypted_comment: await encryptCloudPayload({ comment }, context), updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq(typeof id === 'number' ? 'local_id' : 'id', id)
    if (error) throw new Error(error.message)
    this._cache = null
    return { success: true }
  }

  // ── Follow-up pipeline ─────────────────────────────────────────
  // The next-action date and note the desktop's Pipeline board runs on. Writable
  // from here because deciding "chase them Thursday" is exactly the sort of thing
  // done away from the desk. `date` is a local YYYY-MM-DD, or null to clear.
  async setNextAction(id, { date, note } = {}) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use a YYYY-MM-DD date.')
    const { error } = await supabase
      .from('applications')
      .update({
        next_action_at: date || null,
        next_action_note: String(note || '').slice(0, 5000),
        next_action_done_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', this.userId)
      .eq(typeof id === 'number' ? 'local_id' : 'id', id)
    if (error) {
      if (/next_action/.test(error.message)) {
        throw new Error('Follow-up dates need the next_action columns — re-run supabase/schema.sql in your project.')
      }
      throw new Error(error.message)
    }
    this._cache = null
    return { success: true }
  }

  async completeNextAction(id) {
    const { error } = await supabase.from('applications').update({
      next_action_at: null, next_action_done_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('user_id', this.userId).eq(typeof id === 'number' ? 'local_id' : 'id', id)
    if (error) throw new Error(error.message)
    this._cache = null
    return { success: true }
  }

  // Follow-ups due today or overdue, derived from the list already downloaded.
  // isDueOrOverdue compares local date strings rather than instants, so "due
  // today" means the user's today, not UTC's.
  async getDueActions() {
    return (await this._all())
      .filter(a => !isUnsent(a) && isDueOrOverdue(a.next_action_at))
      .sort((a, b) => String(a.next_action_at).localeCompare(String(b.next_action_at)))
  }

  // Count of mirrored attention jobs, or null when the table isn't there yet —
  // null tells the UI to hide the tile rather than show a misleading 0.
  async _attentionCount() {
    try {
      const { count, error } = await supabase
        .from('attention_jobs')
        .select('local_id', { count: 'exact', head: true })
        .eq('user_id', this.userId)
      if (error) return null
      return count ?? null
    } catch {
      return null
    }
  }

  // Stats and per-day are derived client-side from the application list, by the
  // same pure functions the tests pin against the desktop's definitions.
  async getStats() {
    return {
      ...deriveStats(await this._all()),
      // Mirrored from the desktop. Null when the table doesn't exist yet (older
      // schema, or a desktop that hasn't pushed) so the UI hides the tile rather
      // than showing a misleading 0. Not derivable from the list, so it is not
      // part of deriveStats.
      attentionCount: await this._attentionCount(),
    }
  }

  // Submitted applications per day, matching the desktop's getApplicationsPerDay
  // and the "Today" tile — a held row must not draw a bar.
  async getPerDay(days = 7) {
    return derivePerDay(await this._all(), days)
  }

  // Attention jobs are mirrored from the desktop (read-only here). The table is
  // optional — a project that hasn't re-run schema.sql, or a desktop still on an
  // older build, simply has nothing to return.
  async getAttention() {
    const { data, error } = await supabase
      .from('attention_jobs')
      .select('id, local_id, job_title, company, platform, salary, salary_min, salary_max, job_url, match_score, talking_points, reason, closing_date, found_at, encrypted_meta')
      .eq('user_id', this.userId)
      .order('found_at', { ascending: false })
    if (error) return []
    return Promise.all((data || []).map(async r => this._map(await this._withMeta(r))))
  }

  // Upcoming interviews, mirrored from the desktop. Filtered to today onward so
  // an interview later today doesn't vanish at midnight-plus-one-second, which
  // matches the desktop's own getUpcomingInterviews().
  async getUpcomingInterviews(limit = 25) {
    const today = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const { data, error } = await supabase
      .from('interview_events')
      .select('id, local_id, application_cloud_id, application_local_id, scheduled_at, has_time, source, source_zone, source_local, note, job_title, company, platform, encrypted_meta')
      .eq('user_id', this.userId)
      .gte('scheduled_at', today)
      .order('scheduled_at', { ascending: true })
      .limit(limit)
    if (error) return []
    return Promise.all((data || []).map(async (row) => {
      const r = await this._withMeta(row)
      return { ...r, id: r.id, application_id: r.application_cloud_id || r.application_local_id }
    }))
  }

  // Offers, mirrored from the desktop. Read-only here: accepting, declining and
  // the negotiation draft stay on the desktop.
  //
  // The summary figures are recomputed on this side rather than mirrored,
  // because they are derived from `today` — and the phone's today is the one
  // that matters when it is in a different timezone from the desktop that last
  // synced. Mirroring a stale daysToRespond is how an offer with one day left
  // reads as having three.
  async getOffers() {
    const empty = { offers: [], live: 0, best: null, spread: null, nextDeadline: null }
    let data, error
    try {
      ({ data, error } = await supabase
        .from('offers')
        .select('id, local_id, application_cloud_id, application_local_id, job_title, company, platform, currency, base_salary, bonus, comparable_comp, comp_is_advertised, respond_by, start_date, decision, excitement, encrypted_meta')
        .eq('user_id', this.userId)
        .order('respond_by', { ascending: true, nullsFirst: false }))
    } catch {
      return empty
    }
    // The table is optional — an older project hasn't re-run schema.sql, and an
    // older desktop never pushed. Nothing to report either way.
    if (error) return empty

    const today = todayLocal()
    const decrypted = await Promise.all((data || []).map(async (row) => {
      const r = await this._withMeta(row)
      const total = r.base_salary == null ? null : r.base_salary + (r.bonus || 0)
      return {
        ...r,
        id: r.id,
        application_id: r.application_cloud_id || r.application_local_id,
        totalComp: total,
        // comparable_comp arrives already computed by the desktop, but it is
        // null whenever the money was encrypted — recompute from the decrypted
        // figures when we have them, and fall back to what was sent.
        comparableComp: r.comparable_comp ?? total ?? null,
        compIsAdvertised: !!r.comp_is_advertised,
        // _withMeta sets this when the envelope could not be opened on this
        // device. The prose fields (pros, cons, notes, equity, location) live
        // ONLY inside it — a new table has no older clients to keep plaintext
        // columns for, so encryption-only is both safer and simpler. But that
        // makes an unopenable envelope look like an offer nobody filled in, so
        // the flag has to reach the screen.
        metaPending: !!r.meta_pending,
        daysToRespond: r.respond_by ? daysBetweenDates(today, r.respond_by) : null,
        expired: !!(r.respond_by && r.respond_by < today && r.decision === 'considering'),
      }
    }))

    // Same ordering as the desktop's getOffers: live offers first, then the ones
    // with a deadline, soonest first.
    decrypted.sort((a, b) => {
      const rank = (o) => (o.decision === 'considering' ? 0 : o.decision === 'accepted' ? 1 : 2)
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      const ad = a.respond_by || '￿'
      const bd = b.respond_by || '￿'
      return ad.localeCompare(bd)
    })

    const live = decrypted.filter(o => o.decision === 'considering')
    const currencies = [...new Set(live.filter(o => o.comparableComp != null).map(o => o.currency || ''))]
    const comparable = currencies.length === 1 && !!currencies[0]
    const comps = comparable ? live.map(o => o.comparableComp).filter(v => v != null) : []
    return {
      offers: decrypted,
      live: live.length,
      comparisonCurrency: comparable ? currencies[0] : '',
      comparisonNote: comparable ? '' : 'Different or unset currencies cannot be compared.',
      best: comps.length ? Math.max(...comps) : null,
      spread: comps.length >= 2 ? Math.max(...comps) - Math.min(...comps) : null,
      nextDeadline: live.find(o => o.respond_by) || null,
    }
  }

  // Live desktop status over the cloud: the desktop upserts its row in
  // scan_status when a scan starts/finishes, and queued scan_requests are the
  // ones it hasn't picked up yet. Both tables are optional (older projects) —
  // return null so the UI simply hides the status line.
  async getScanStatus() {
    const { data, error } = await supabase
      .from('scan_status')
      .select('running, updated_at')
      .eq('user_id', this.userId)
      .maybeSingle()
    if (error) return null
    let queued = 0
    try {
      const { count } = await supabase
        .from('scan_requests')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', this.userId).in('status', ['queued', 'accepted', 'running'])
      queued = count || 0
    } catch { /* older schema without scan_requests */ }
    // If the desktop crashed mid-scan it never wrote running=false; treat a
    // "running" flag older than 2 hours as stale rather than showing it forever.
    const age = data?.updated_at ? Date.now() - new Date(data.updated_at).getTime() : Infinity
    const running = !!data?.running && age < 2 * 60 * 60 * 1000
    return { running, queued, lastScanAt: null, cloud: true }
  }

  // Queue a scan through the cloud: the desktop drains scan_requests during
  // its periodic sync. `cloud: true` tells the UI to phrase the confirmation
  // accordingly (no live desktop status available here).
  async requestScan({ keywords = '', location = '' } = {}, { idempotencyKey = '' } = {}) {
    keywords = String(keywords).trim().slice(0, 500)
    location = String(location).trim().slice(0, 160)
    const { error } = await supabase
      .from('scan_requests')
      .upsert({ request_key: idempotencyKey || randomUUID(), user_id: this.userId, keywords, location }, { onConflict: 'user_id,request_key', ignoreDuplicates: true })
    if (error) {
      if (/scan_requests/.test(error.message)) {
        throw new Error('Cloud scan requests need the scan_requests table — re-run supabase/schema.sql in your project.')
      }
      throw new Error(error.message)
    }
    return { cloud: true }
  }

  async getCloudCommands() {
    const rows = [], applications = await this._all()
    for (const table of ['scan_requests', 'review_requests']) {
      const { data, error } = await supabase.from(table).select('*').eq('user_id', this.userId).order('created_at', { ascending: false }).limit(50)
      if (error) throw new Error(error.message)
      rows.push(...(data || []).map(row => {
        const app = applications.find(a => a.id === row.application_cloud_id)
        return { ...row, kind: table === 'scan_requests' ? 'scan' : 'review', jobTitle: app?.job_title, company: app?.company }
      }))
    }
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  async retryCloudCommand(kind, id) {
    const table = kind === 'scan' ? 'scan_requests' : kind === 'review' ? 'review_requests' : null
    if (!table) throw new Error('Invalid command kind.')
    const { data, error } = await supabase.from(table).update({ id: randomUUID(), status: 'queued', claimed_by: null, error: '', updated_at: new Date().toISOString() })
      .eq('user_id', this.userId).eq('id', id).eq('status', 'failed').select('id')
    if (error) throw new Error(error.message)
    if (!data?.length) throw new Error('Only failed commands can be retried. Refresh command history.')
    return { success: true }
  }

  // Batch approval over the cloud: one queued request per draft, processed by
  // the desktop on its next sync. The desktop applies the same rules as on the
  // local network and drops any it will not submit.
  async approveDrafts(ids) {
    const accepted = []
    for (const id of ids) {
      await this.requestReviewAction(id, 'approve')
      accepted.push(id)
    }
    return { started: true, queued: true, accepted, refused: [] }
  }

  async requestReviewAction(id, action) {
    if (!['approve', 'reject'].includes(action)) throw new Error('Invalid review action.')
    const { data: existing, error: readError } = await supabase.from('review_requests').select('id, status')
      .eq('user_id', this.userId).eq('application_cloud_id', id).maybeSingle()
    if (readError) throw new Error(readError.message)
    if (existing) {
      if (['queued', 'accepted', 'running'].includes(existing.status)) return { success: true, queued: true }
      throw new Error('A previous command exists. Check command history and retry there if needed.')
    }
    const { error } = await supabase.from('review_requests').insert({
      user_id: this.userId, application_cloud_id: id, action,
    })
    if (error) throw new Error(/review_requests/.test(error.message)
      ? 'Remote review needs the review_requests table — re-run supabase/schema.sql.' : error.message)
    return { success: true, queued: true }
  }
}
