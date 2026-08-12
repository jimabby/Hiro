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
  try { await supabase.auth.signOut() } catch { /* session already invalid */ }
}

// The stats/chart derivations live in src/stats.js as pure functions. They used
// to be inline here, which is how they drifted from the desktop's getStats() —
// the phone went on counting skipped and held rows as applications long after the
// desktop stopped. Extracted so a test can pin the two together.
import { deriveStats, derivePerDay, isUnsent } from './stats'
import { isDueOrOverdue } from './dates'
import { decryptCloudPayload } from './cloudCrypto'

const VALID_STATUSES = ['applied', 'interview', 'offer', 'rejected', 'pending', 'no_response', 'skipped', 'held']

// Columns the list/stats screens actually need. Selecting * pulled every
// cover letter, tailored resume, and job description over cellular on each
// refresh (the LAN API slims list responses the same way).
const BASE_COLUMNS = 'id, local_id, job_title, company, platform, salary, match_score, match_explanation, status, applied_at, updated_at, comment'
// Added later than the rest. A project that has not re-run schema.sql does not
// have them, and naming a missing column fails the WHOLE select — which would
// take the applications list down rather than degrade the follow-up feature. So
// they are requested separately and dropped on the first failure.
const PIPELINE_COLUMNS = 'next_action_at, next_action_note'
const SLIM_COLUMNS = `${BASE_COLUMNS}, ${PIPELINE_COLUMNS}`
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
    // Scans still run on the desktop, but they CAN be requested through the
    // cloud: we insert into scan_requests and the desktop picks it up on its
    // next sync cycle (~2 minutes).
    this.canScan = true
    this._cache = null // short-lived shared fetch: stats + chart + list reuse one download
    // Narrowed to BASE_COLUMNS once if this project's schema predates the
    // pipeline columns; see _fetchAll.
    this._columns = null
  }

  // Screens key off `id`; the cloud row's stable per-user key is `local_id`.
  _map(row) {
    return { ...row, id: row.local_id ?? row.id }
  }

  async _fetchAll() {
    const fetch = (columns) => selectAll(() => supabase
      .from('applications')
      .select(columns)
      .eq('user_id', this.userId)
      .order('applied_at', { ascending: false }))

    let { data, error } = await fetch(this._columns || SLIM_COLUMNS)
    // PostgREST reports an unknown column as PGRST204 / 42703. Remember the
    // narrower set so every later read does not pay for the same failure.
    if (error && (error.code === 'PGRST204' || error.code === '42703' || /next_action/.test(error.message || ''))) {
      this._columns = BASE_COLUMNS
      ;({ data, error } = await fetch(BASE_COLUMNS))
    }
    if (error) throw new Error(error.message)
    return (data || []).map(r => this._map(r))
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
      .eq('local_id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    if (data.encrypted_payload) Object.assign(data, await decryptCloudPayload(data.encrypted_payload) || {})
    return this._map(data)
  }

  async updateStatus(id, status) {
    if (!VALID_STATUSES.includes(status)) throw new Error('Invalid application status.')
    const { error } = await supabase
      .from('applications')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('local_id', id)
    if (error) throw new Error(error.message)
    this._cache = null // next read must see the edit
    return { success: true }
  }

  async updateComment(id, comment) {
    comment = String(comment || '').slice(0, 5000)
    const { error } = await supabase
      .from('applications')
      .update({ comment, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('local_id', id)
    if (error) throw new Error(error.message)
    this._cache = null
    return { success: true }
  }

  // ── Follow-up pipeline ─────────────────────────────────────────
  // The next-action date and note the desktop's Pipeline board runs on. Writable
  // from here because deciding "chase them Thursday" is exactly the sort of thing
  // done away from the desk. `date` is a local YYYY-MM-DD, or null to clear.
  async setNextAction(id, { date, note } = {}) {
    const { error } = await supabase
      .from('applications')
      .update({
        next_action_at: date || null,
        next_action_note: note || '',
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', this.userId)
      .eq('local_id', id)
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
    return this.setNextAction(id, { date: null, note: '' })
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
      .select('local_id, job_title, company, platform, salary, salary_min, salary_max, job_url, match_score, talking_points, reason, closing_date, found_at')
      .eq('user_id', this.userId)
      .order('found_at', { ascending: false })
    if (error) return []
    return (data || []).map(r => this._map(r))
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
      .select('local_id, application_local_id, scheduled_at, has_time, source, note, job_title, company, platform')
      .eq('user_id', this.userId)
      .gte('scheduled_at', today)
      .order('scheduled_at', { ascending: true })
      .limit(limit)
    if (error) return []
    return (data || []).map(r => ({
      ...r,
      id: r.local_id,
      application_id: r.application_local_id,
    }))
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
        .eq('user_id', this.userId)
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
  async requestScan({ keywords = '', location = '' } = {}) {
    keywords = String(keywords).trim().slice(0, 500)
    location = String(location).trim().slice(0, 160)
    const { error } = await supabase
      .from('scan_requests')
      .insert({ user_id: this.userId, keywords, location })
    if (error) {
      if (/scan_requests/.test(error.message)) {
        throw new Error('Cloud scan requests need the scan_requests table — re-run supabase/schema.sql in your project.')
      }
      throw new Error(error.message)
    }
    return { cloud: true }
  }

  async requestReviewAction(id, action) {
    if (!['approve', 'reject'].includes(action)) throw new Error('Invalid review action.')
    const { error } = await supabase.from('review_requests').upsert({
      user_id: this.userId, application_local_id: Number(id), action,
    }, { onConflict: 'user_id,application_local_id' })
    if (error) throw new Error(/review_requests/.test(error.message)
      ? 'Remote review needs the review_requests table — re-run supabase/schema.sql.' : error.message)
    return { success: true, queued: true }
  }
}
