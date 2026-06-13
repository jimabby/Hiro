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

// Reads/writes the shared `applications` table. Exposes the same methods the
// screens already call on HiroClient (getStats, getApplications, getApplication,
// updateStatus, updateComment, getPerDay) so screens need no changes.
export class CloudClient {
  constructor(userId) {
    this.userId = userId
    this.canScan = false // scans run on the desktop; the cloud can't trigger them
  }

  // Screens key off `id`; the cloud row's stable per-user key is `local_id`.
  _map(row) {
    return { ...row, id: row.local_id ?? row.id }
  }

  async getApplications({ status, platform, search } = {}) {
    let q = supabase
      .from('applications')
      .select('*')
      .eq('user_id', this.userId)
      .order('applied_at', { ascending: false })
    if (status) q = q.eq('status', status)
    if (platform) q = q.eq('platform', platform)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    let rows = (data || []).map(r => this._map(r))
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
    return { success: true }
  }

  async updateComment(id, comment) {
    const { error } = await supabase
      .from('applications')
      .update({ comment, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('local_id', id)
    if (error) throw new Error(error.message)
    return { success: true }
  }

  // Stats and per-day are derived client-side from the application list.
  async getStats() {
    const apps = await this.getApplications()
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
      attentionCount: 0,
      byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
      byPlatform: Object.entries(byPlatform).map(([platform, count]) => ({ platform, count })),
    }
  }

  async getPerDay(days = 7) {
    const apps = await this.getApplications()
    const out = []
    const today = startOfDay(new Date())
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000)
      const next = new Date(d.getTime() + 86400000)
      const date = d.toISOString().slice(0, 10)
      const count = apps.filter(a => {
        const t = new Date(a.applied_at || a.updated_at || 0).getTime()
        return t >= d.getTime() && t < next.getTime()
      }).length
      out.push({ date, count })
    }
    return out
  }

  // Scan triggering requires the desktop; over the cloud it's not available.
  async getScanStatus() { return null }
  async requestScan() { throw new Error('Scans run on the desktop — connect over LAN to trigger one.') }
}
