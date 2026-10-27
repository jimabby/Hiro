import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
// HTTP client for the Hiro desktop companion API (web/electron/services/mobileApi.js)
import { encryptPayload, decryptPayload, signedHeaders } from './secureProtocol'
// Pure, CommonJS, and separately tested — see src/httpJson.js.
import { readJson } from './httpJson'
import { openChannel, sealRequest, openResponse } from './pairProtocol'
import { BINDING_HEADER, BINDING_VERSION, responseMode } from './responseBinding'

const TIMEOUT_MS = 8000
// Pairing stretches the code with 200k rounds of PBKDF2 in JavaScript, which on
// an older phone is a second or two on top of two network round trips. The
// ordinary 8s budget is too tight for that.
const PAIR_TIMEOUT_MS = 30000

async function withTimeout(url, options, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Connection timed out — is the desktop app running?')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// Exchange a one-time pairing code for a token belonging to this phone alone.
//
// Unauthenticated by necessity — it is how a token is obtained — so it is the
// one call that cannot go through HiroClient. The desktop only accepts it from
// a private-range address, only while a code is live, and only once.
//
// Two round trips rather than one, because the reply carries a 90-day credential
// and this is plain HTTP. The first fetches the desktop's ephemeral public key,
// authenticated by an HMAC only the holder of the pairing code can check; the
// second sends the code and receives the token, both encrypted under the agreed
// key. See src/pairProtocol.js.
export async function pairWithDesktop({ host, port, code, deviceName, platform }) {
  const base = `http://${host}:${port}`

  const helloRes = await withTimeout(`${base}/api/pair/hello`, {}, PAIR_TIMEOUT_MS)
  const hello = await readJson(helloRes)
  if (!helloRes.ok) throw new Error(hello?.error || `HTTP ${helloRes.status}`)

  // Throws when the tag does not verify — a mistyped code, or something on the
  // network answering in the desktop's place.
  const channel = openChannel(hello, code)
  const sealed = await sealRequest(channel, { code, deviceName, platform })

  const res = await withTimeout(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sealed),
  }, PAIR_TIMEOUT_MS)
  const body = await readJson(res)
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return openResponse(channel, body) // { token, device, host }
}

// Rotate a device token once it is this close to expiring.
export const ROTATE_WITHIN_DAYS = 14

// Only "this desktop has no such route" means empty. A timeout, a revoked
// token or a 500 used to resolve the same way, so Offers showed an empty board —
// "no offers" — when the truth was "could not ask". Everything else propagates
// so the screen can say what went wrong.
async function orEmptyOn404(promise, empty) {
  try {
    return await promise
  } catch (err) {
    if (err?.status === 404) return empty
    throw err
  }
}

export class HiroClient {
  // `responseBinding` is true once this desktop has sent a reply bound to its
  // request (see src/responseBinding.js); `onResponseBinding` is called the
  // first time that happens so the caller can save it with the connection.
  // `expiresAt` (ISO, from the pairing response's device) and `onTokenRotated`
  // (persists the new connection) together enable rotating the token before it
  // expires — see rotateIfExpiringSoon. Without onTokenRotated nothing rotates,
  // because a new token that is not saved would lock the phone out.
  constructor(
    { host, port, token, secure = false, responseBinding = false, deviceId = null, expiresAt = null, onTokenRotated = null },
    { onResponseBinding, onTokenRotated: rotatedOption } = {},
  ) {
    this.baseUrl = `http://${host}:${port}`
    this.token = token
    this.expiresAt = expiresAt
    this.onTokenRotated = onTokenRotated || rotatedOption || null
    // Keyed by the desktop's id for this pairing when it is known, so a token
    // rotation does not strand requests queued under the old token; older
    // saved connections fall back to the token, as before.
    this.queueDestination = { key: `lan:${bytesToHex(sha256(utf8ToBytes(`${this.baseUrl}:${deviceId ? `device:${deviceId}` : token}`)))}`, label: `Desktop ${host}:${port}` }
    // Connections created by the one-time pairing flow use authenticated,
    // encrypted envelopes. Saved/manual connections from older Hiro releases
    // remain bearer-token compatible until the user re-pairs.
    this.secure = secure
    this.responseBinding = !!responseBinding
    this.onResponseBinding = onResponseBinding
    this.canScan = true // LAN client can reach the desktop to trigger scans
    this.canImport = true // and to import a shared job link
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
      const signed = this.secure ? signedHeaders(this.token, method, path, rawBody) : null
      let res
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          ...options,
          method,
          body: rawBody || undefined,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(signed
              ? { ...signed, [BINDING_HEADER]: BINDING_VERSION }
              : { Authorization: `Bearer ${this.token}` }),
            ...(options.headers || {}),
          },
        })
      } catch (err) {
        if (err.name === 'AbortError') throw err
        // The request never got an answer: no route, Wi-Fi off, desktop asleep.
        // Flagged so a caller can tell this apart from a refusal — see
        // src/requestErrors.js.
        err.network = true
        throw err
      }
      let envelope
      try {
        envelope = await readJson(res)
      } catch (err) {
        // Something other than the desktop answered (a captive portal). For
        // "should this wait and retry", that is the same as unreachable.
        err.network = true
        throw err
      }
      // The desktop can only encrypt a reply once it has verified the request
      // signature, so everything it rejects BEFORE that point — 403 from a
      // non-private address, 429 from the lockout, 401 from an expired device
      // token — necessarily comes back in the clear. Reading those through the
      // envelope check turned every one of them into "Desktop returned an
      // unencrypted response. Re-pair this phone", which is wrong advice for a
      // lockout and useless for a captive-portal 403.
      if (!res.ok && envelope?.secure !== 2) {
        const err = new Error(envelope?.error || `HTTP ${res.status}`)
        // 401 on a connection that WAS working means the token is no longer
        // accepted — expired or revoked. That one really does need re-pairing,
        // and the UI can offer it directly instead of guessing.
        err.needsPairing = res.status === 401
        err.status = res.status
        if (envelope?.scope) err.scope = envelope.scope
        throw err
      }
      const body = this.secure ? await this.openReply(envelope, method, path, signed) : envelope
      if (!res.ok) {
        // featureHub refusals (an import with a bad URL) say why in `reason`.
        const err = new Error(body?.error || body?.reason || `HTTP ${res.status}`)
        err.status = res.status
        // 403 { error, scope }: this device lacks that permission. See
        // messageFor() in src/requestErrors.js.
        if (body?.scope) err.scope = body.scope
        throw err
      }
      return body
    } catch (err) {
      if (err.name === 'AbortError') {
        // No reply within the budget. The desktop may still have acted on the
        // request, which is why writes that get retried carry an Idempotency-Key.
        const timeout = new Error('Connection timed out — is the desktop app running?')
        timeout.timeout = true
        throw timeout
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  // Check the reply answers THIS request. See src/responseBinding.js.
  async openReply(envelope, method, path, signed) {
    const { mode } = responseMode(envelope, { pinned: this.responseBinding })
    if (mode === 'legacy') return decryptPayload(this.token, envelope)
    const body = await decryptPayload(this.token, envelope, { method, path, nonce: signed['X-Hiro-Nonce'] })
    if (!this.responseBinding) {
      this.responseBinding = true
      try { this.onResponseBinding?.() } catch { /* best-effort: re-learned on the next bound reply */ }
    }
    return body
  }

  async ping() {
    const result = await this.request('/api/ping')
    // Best-effort: a failed rotation leaves the current token valid.
    this.rotateIfExpiringSoon().catch(() => {})
    return result
  }

  // POST /api/rotate (signed). Returns { token, device, expiresAt } and the
  // desktop retires the old token once the reply is sent.
  async rotateToken() {
    if (!this.secure) throw new Error('Token rotation needs a paired (signed) connection.')
    const res = await this.request('/api/rotate', { method: 'POST' })
    this.token = res.token
    this.expiresAt = res.expiresAt || res.device?.expiresAt || null
    if (this.onTokenRotated) await this.onTokenRotated({ token: this.token, expiresAt: this.expiresAt, device: res.device })
    return res
  }

  async rotateIfExpiringSoon(withinDays = ROTATE_WITHIN_DAYS) {
    if (!this.secure || !this.expiresAt || !this.onTokenRotated || this.rotating) return null
    const left = new Date(this.expiresAt).getTime() - Date.now()
    if (!Number.isFinite(left) || left > withinDays * 86400000) return null
    this.rotating = true
    try { return await this.rotateToken() } finally { this.rotating = false }
  }
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

  // Approve several held drafts at once. The desktop submits them and answers
  // straight away with which ids it accepted and why any were refused (a
  // flagged draft, a career-board job, one already sent). Paired phones only.
  approveDrafts(ids) {
    return this.request('/api/held/approve', { method: 'POST', body: JSON.stringify({ ids }) })
  }

  // The night-before interview brief, as the desktop has prepared it. LAN only:
  // the brief is built from documents and replies that are not synced.
  getChecklist(id) { return this.request(`/api/applications/${id}/checklist`) }
  updateChecklist(id, change) { return this.request(`/api/applications/${id}/checklist`, { method: 'POST', body: JSON.stringify(change) }) }

  getInterviewBrief(id) { return this.request(`/api/applications/${id}/brief`) }
  getPerDay(days = 7) { return this.request(`/api/perday?days=${days}`) }

  // Follow-ups due today or overdue. An older desktop build has no such route,
  // so a 404 resolves to an empty list rather than breaking the dashboard.
  async getDueActions() {
    return orEmptyOn404(this.request('/api/next-actions'), [])
  }

  // Upcoming interviews — same panel the desktop shows. An older desktop build
  // has no such route, so a 404 resolves to an empty list rather than an error.
  async getUpcomingInterviews(limit = 25) {
    return orEmptyOn404(this.request(`/api/interviews?limit=${limit}`), [])
  }

  // Live offers and their deadlines. Read-only: accepting, declining and the
  // negotiation draft stay on the desktop. An older desktop build has no such
  // route, so a 404 resolves to an empty board rather than an error.
  async getOffers() {
    return orEmptyOn404(this.request('/api/offers'), { offers: [], live: 0, best: null, spread: null, nextDeadline: null })
  }

  // The desktop's own task inbox (featureHub.taskInbox) — follow-ups,
  // checklist items, offer and closing deadlines in one read. Null from a
  // desktop too old to have the route, so the Today screen builds the list
  // itself instead (see src/todayLoader.js).
  async getTaskInbox() {
    const tasks = await orEmptyOn404(this.request('/api/tasks'), null)
    return Array.isArray(tasks) ? tasks : null
  }

  // Queue a scan on the desktop. `opts` may include { keywords, location } to
  // override the desktop's saved search for this run.
  //
  // `idempotencyKey` travels as the Idempotency-Key header. A request that
  // timed out may still have reached the desktop, and the queue retries it; a
  // desktop that honours the key answers the retry from the first delivery
  // instead of running a second scan.
  requestScan(opts = {}, { idempotencyKey } = {}) {
    return this.request('/api/scan', {
      method: 'POST',
      body: JSON.stringify(opts),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    })
  }

  // Add a job by its URL to the desktop's Needs Attention list — the same
  // route the browser extension uses. `job` is { url, title?, company? }; the
  // desktop answers { success, id } or 400 { success: false, reason }.
  importJob(job, { idempotencyKey } = {}) {
    return this.request('/api/import-job', {
      method: 'POST',
      body: JSON.stringify(job),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    })
  }
  getScanStatus() { return this.request('/api/scan/status') }
  cancelScan() { return this.request('/api/scan/cancel', { method: 'POST' }) }

  // Recent desktop activity-log lines (oldest → newest) — powers the live
  // scan feed on the Dashboard. LAN only; CloudClient has no equivalent.
  getLogs(limit = 40) { return this.request(`/api/logs?limit=${limit}`) }
}
