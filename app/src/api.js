// HTTP client for the Hiro desktop companion API (web/electron/services/mobileApi.js)

const TIMEOUT_MS = 8000

export class HiroClient {
  constructor({ host, port, token }) {
    this.baseUrl = `http://${host}:${port}`
    this.token = token
    this.canScan = true // LAN client can reach the desktop to trigger scans
  }

  async request(path, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      })
      const body = await res.json()
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

  getAttention() { return this.request('/api/attention') }
  getPerDay(days = 7) { return this.request(`/api/perday?days=${days}`) }

  // Queue a scan on the desktop. `opts` may include { keywords, location } to
  // override the desktop's saved search for this run.
  requestScan(opts = {}) {
    return this.request('/api/scan', { method: 'POST', body: JSON.stringify(opts) })
  }
  getScanStatus() { return this.request('/api/scan/status') }
}
