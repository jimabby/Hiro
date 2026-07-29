// Supabase client + a data client that mirrors HiroClient's interface so the
// existing screens work unchanged whether the data comes from the desktop over
// LAN or from the cloud. Configure via app/.env:
//   EXPO_PUBLIC_SUPABASE_URL=...
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=...
import 'react-native-url-polyfill/auto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'

const url = process.env.EXPO_PUBLIC_SUPABASE_URL
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY

export const isConfigured = !!(url && anonKey)

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        storage: AsyncStorage,
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

// Statuses that mean the employer replied. Mirrors RESPONDED_STATUSES in
// web/electron/services/database.js — keep the two in sync.
const RESPONDED_STATUSES = ['interview', 'offer', 'rejected', 'pending']

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Columns the list/stats screens actually need. Selecting * pulled every
// cover letter, tailored resume, and job description over cellular on each
// refresh (the LAN API slims list responses the same way).
const SLIM_COLUMNS = 'id, local_id, job_title, company, platform, salary, match_score, match_explanation, status, applied_at, updated_at, comment'

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
  }

  // Screens key off `id`; the cloud row's stable per-user key is `local_id`.
  _map(row) {
    return { ...row, id: row.local_id ?? row.id }
  }

  async _fetchAll() {
    const { data, error } = await supabase
      .from('applications')
      .select(SLIM_COLUMNS)
      .eq('user_id', this.userId)
      .order('applied_at', { ascending: false })
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
    return data ? this._map(data) : null
  }

  async updateStatus(id, status) {
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
    const { error } = await supabase
      .from('applications')
      .update({ comment, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('local_id', id)
    if (error) throw new Error(error.message)
    this._cache = null
    return { success: true }
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

  // Stats and per-day are derived client-side from the application list.
  async getStats() {
    const apps = await this._all()
    const now = new Date()
    const today = startOfDay(now).getTime()
    const weekAgo = today - 6 * 86400000
    // 'held' is drafted-but-not-sent, same as 'skipped' for any rate: counting
    // it would make holding a job for review look like an application that
    // never got a reply. Mirrors UNSENT_STATUSES on the desktop.
    const counted = apps.filter(a => a.status !== 'skipped' && a.status !== 'held')
    // Keep these definitions identical to the desktop's getStats(): an offer
    // implies the interview stage was reached, and a rejection is still a reply.
    const interviews = apps.filter(a => a.status === 'interview' || a.status === 'offer').length
    const responded = apps.filter(a => RESPONDED_STATUSES.includes(a.status)).length

    const byStatus = {}
    const byPlatform = {}
    for (const a of apps) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1
      byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1
    }
    const appliedTime = a => new Date(a.applied_at || a.updated_at || 0).getTime()

    return {
      totalToday: apps.filter(a => appliedTime(a) >= today).length,
      totalThisWeek: apps.filter(a => appliedTime(a) >= weekAgo).length,
      totalAllTime: apps.length,
      interviews,
      // Match the desktop's definitions so both agree.
      responseRate: counted.length ? Math.round((responded / counted.length) * 100) : 0,
      interviewRate: counted.length ? Math.round((interviews / counted.length) * 100) : 0,
      // Mirrored from the desktop. Still null when the table doesn't exist yet
      // (older schema, or a desktop that hasn't pushed) so the UI hides the tile
      // rather than showing a misleading 0.
      attentionCount: await this._attentionCount(),
      byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
      byPlatform: Object.entries(byPlatform).map(([platform, count]) => ({ platform, count })),
    }
  }

  async getPerDay(days = 7) {
    const apps = await this._all()
    const out = []
    const today = startOfDay(new Date())
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000)
      const next = new Date(d.getTime() + 86400000)
      // Label with the LOCAL date — toISOString() is UTC and shifts the label
      // to the previous day in UTC+ timezones.
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const count = apps.filter(a => {
        const t = new Date(a.applied_at || a.updated_at || 0).getTime()
        return t >= d.getTime() && t < next.getTime()
      }).length
      out.push({ date, count })
    }
    return out
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
}
