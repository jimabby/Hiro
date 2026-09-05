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
import { isDueOrOverdue, todayLocal, daysBetweenDates } from './dates'
import { decryptCloudPayload } from './cloudCrypto'

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
const BASE_COLUMNS = `${LEGACY_COLUMNS}, encrypted_meta`
const SLIM_COLUMNS = `${BASE_COLUMNS}, ${PIPELINE_COLUMNS}`
// Widest first, then drop one late addition at a time. Each tier is tried once
// and the working one is remembered, so a project on an older schema pays for
// the discovery a single time rather than on every refresh.
const COLUMN_TIERS = [SLIM_COLUMNS, BASE_COLUMNS, LEGACY_COLUMNS]
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

  // Merge a row's encrypted metadata back over its blanked plaintext columns.
  //
  // Tolerant in both directions of version skew, which matters because the
  // desktop and the phone update independently: a row written by an older
  // desktop has no encrypted_meta and its plaintext columns are already correct,
  // so this is a no-op. A row this device cannot decrypt keeps whatever the
  // columns hold rather than failing the whole list — one unreadable row must
  // never be able to blank the screen.
  async _withMeta(row) {
    if (!row?.encrypted_meta) return row
    try {
      Object.assign(row, await decryptCloudPayload(row.encrypted_meta) || {})
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
      .order('applied_at', { ascending: false }))

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
      .eq('local_id', id)
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
        Object.assign(data, await decryptCloudPayload(data.encrypted_payload) || {})
      } catch (err) {
        if (!err.obsoleteEnvelope) throw err
        data.documents_pending = 'Documents are still encrypted with a retired key. Open Hiro on the desktop to re-upload them.'
      }
    }
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
      .select('local_id, job_title, company, platform, salary, salary_min, salary_max, job_url, match_score, talking_points, reason, closing_date, found_at, encrypted_meta')
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
      .select('local_id, application_local_id, scheduled_at, has_time, source, source_zone, source_local, note, job_title, company, platform, encrypted_meta')
      .eq('user_id', this.userId)
      .gte('scheduled_at', today)
      .order('scheduled_at', { ascending: true })
      .limit(limit)
    if (error) return []
    return Promise.all((data || []).map(async (row) => {
      const r = await this._withMeta(row)
      return { ...r, id: r.local_id, application_id: r.application_local_id }
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
        .select('local_id, application_local_id, job_title, company, platform, currency, base_salary, bonus, comparable_comp, comp_is_advertised, respond_by, start_date, decision, excitement, encrypted_meta')
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
        id: r.local_id,
        application_id: r.application_local_id,
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
    const comps = live.map(o => o.comparableComp).filter(v => v != null)
    return {
      offers: decrypted,
      live: live.length,
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
