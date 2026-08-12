// HTTP client for the Hiro desktop companion API (web/electron/services/mobileApi.js)
import { encryptPayload, decryptPayload, signedHeaders } from './secureProtocol'

const TIMEOUT_MS = 8000

// Exchange a one-time pairing code for a token belonging to this phone alone.
//
// Unauthenticated by necessity — it is how a token is obtained — so it is the
// one call that cannot go through HiroClient. The desktop only accepts it from
// a private-range address, only while a code is live, and only once.
export async function pairWithDesktop({ host, port, code, deviceName, platform }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`http://${host}:${port}/api/pair`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, platform }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body // { token, device, host }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Connection timed out — is the desktop app running?')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class HiroClient {
  constructor({ host, port, token, secure = false }) {
    this.baseUrl = `http://${host}:${port}`
    this.token = token
    // Connections created by the one-time pairing flow use authenticated,
    // encrypted envelopes. Saved/manual connections from older Hiro releases
    // remain bearer-token compatible until the user re-pairs.
    this.secure = secure
    this.canScan = true // LAN client can reach the desktop to trigger scans
  }

  async request(path, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const method = options.method || 'GET'
      const plainBody = options.body ? JSON.parse(options.body) : null
      const rawBody = this.secure
        ? (plainBody == null ? '' : JSON.stringify(await encryptPayload(this.token, plainBody)))
        : (options.body || '')
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        method,
        body: rawBody || undefined,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.secure
            ? signedHeaders(this.token, method, path, rawBody)
            : { Authorization: `Bearer ${this.token}` }),
          ...(options.headers || {}),
        },
      })
      const envelope = await res.json()
      const body = this.secure ? await decryptPayload(this.token, envelope) : envelope
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Connection timed out — is the desktop app running?')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  ping() { return this.request('/api/ping') }
  getStats() { return this.request('/api/stats') }

  getApplications({ status, platform, search } = {}) {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (platform) params.set('platform', platform)
    if (search) params.set('search', search)
    const qs = params.toString()
    return this.request(`/api/applications${qs ? `?${qs}` : ''}`)
  }

  getApplication(id) { return this.request(`/api/applications/${id}`) }

  updateStatus(id, status) {
    return this.request(`/api/applications/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  }

  updateComment(id, comment) {
    return this.request(`/api/applications/${id}/comment`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    })
  }

  // The follow-up date and note from the desktop's Pipeline board. Editable from
  // the phone: deciding "chase them Thursday" is exactly the kind of thing done
  // away from the desk. `date` is a local YYYY-MM-DD, or null to clear.
  setNextAction(id, { date, note } = {}) {
    return this.request(`/api/applications/${id}/next-action`, {
      method: 'POST',
      body: JSON.stringify({ date: date ?? null, note: note ?? '' }),
    })
  }

  completeNextAction(id) {
    return this.request(`/api/applications/${id}/next-action/done`, { method: 'POST' })
  }

  getAttention() { return this.request('/api/attention') }
  getPerDay(days = 7) { return this.request(`/api/perday?days=${days}`) }

  // Follow-ups due today or overdue. An older desktop build has no such route,
  // so a 404 resolves to an empty list rather than breaking the dashboard.
  async getDueActions() {
    try {
      return await this.request('/api/next-actions')
    } catch {
      return []
    }
  }

  // Upcoming interviews — same panel the desktop shows. An older desktop build
  // has no such route, so a 404 resolves to an empty list rather than an error.
  async getUpcomingInterviews(limit = 25) {
    try {
      return await this.request(`/api/interviews?limit=${limit}`)
    } catch {
      return []
    }
  }

  // Queue a scan on the desktop. `opts` may include { keywords, location } to
  // override the desktop's saved search for this run.
  requestScan(opts = {}) {
    return this.request('/api/scan', { method: 'POST', body: JSON.stringify(opts) })
  }
  getScanStatus() { return this.request('/api/scan/status') }
  cancelScan() { return this.request('/api/scan/cancel', { method: 'POST' }) }

  // Recent desktop activity-log lines (oldest → newest) — powers the live
  // scan feed on the Dashboard. LAN only; CloudClient has no equivalent.
  getLogs(limit = 40) { return this.request(`/api/logs?limit=${limit}`) }
}
