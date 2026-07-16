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

  // Stats and per-day are derived client-side from the application list.
  async getStats() {
    const apps = await this._all()
    const now = new Date()
    const today = startOfDay(now).getTime()
    const weekAgo = today - 6 * 86400000
    const counted = apps.filter(a => a.status !== 'skipped')
    const interviews = apps.filter(a => a.status === 'interview').length

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
      // Match the desktop's definition (interviews ÷ non-skipped) so both agree.
      responseRate: counted.length ? Math.round((interviews / counted.length) * 100) : 0,
      // Attention jobs never sync to the cloud — report "unknown" (null) so
      // the UI hides the tile instead of showing a misleading 0.
      attentionCount: null,
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

  // Attention jobs never sync to the cloud.
  async getAttention() { return [] }

  // No live desktop status over the cloud.
  async getScanStatus() { return null }

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
