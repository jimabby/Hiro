// Approving held drafts from the phone: which drafts qualify, which devices may
// ask, and the endpoint end to end over a real socket with real pairing.

const crypto = require('crypto')
const path_ = require('path')
const { stub, service, createChecker } = require('./helpers')
const pairChannel = require(path_.join(__dirname, '..', '..', 'extension', 'pairChannel.js'))

const PORT = 48241
const cfg = { mobileApiEnabled: true, mobileApiPort: PORT, mobileApiToken: 'l'.repeat(32), mobileDevices: [] }
const ROWS = {
  1: { id: 1, status: 'held', platform: 'Seek', fabrication_flags: '[]' },
  2: { id: 2, status: 'held', platform: 'LinkedIn', fabrication_flags: null },
  3: { id: 3, status: 'held', platform: 'Seek', fabrication_flags: '[{"kind":"credential","value":"AWS"}]' },
  4: { id: 4, status: 'held', platform: 'ATS', fabrication_flags: '[]' },
  5: { id: 5, status: 'applied', platform: 'Seek', fabrication_flags: '[]' },
}
stub({
  './config': {
    load: () => cfg,
    update: patch => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    encryptSecret: value => `wrapped:${value}`,
    decryptSecret: value => String(value).replace(/^wrapped:/, ''),
    CONFIG_DIR: '/tmp/hiro-phone-review-test',
  },
  './database': { getApplication: id => ROWS[id] || null, getStats: () => ({}) },
  './scheduler': { getScanInfo: () => ({ running: false }) },
  './logger': { append: () => {}, tail: () => [] },
})

const phoneReview = service('phoneReview')
const api = service('mobileApi.js')
const { check, done } = createChecker()

const key = token => crypto.createHash('sha256').update(token).digest()
function encrypt(token, value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(token), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return JSON.stringify({ secure: 2, data: Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64') })
}
function decrypt(token, envelope) {
  if (envelope.secure !== 2) return envelope
  const combined = Buffer.from(envelope.data, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(token), combined.subarray(0, 12))
  decipher.setAuthTag(combined.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(12, -16)), decipher.final()]).toString())
}
function headers(token, method, path, raw) {
  const timestamp = String(Date.now())
  const nonce = crypto.randomBytes(16).toString('hex')
  return {
    'Content-Type': 'application/json', 'X-Hiro-Timestamp': timestamp, 'X-Hiro-Nonce': nonce,
    'X-Hiro-Signature': crypto.createHmac('sha256', token).update([method, path, timestamp, nonce, raw].join('\n')).digest('hex'),
  }
}
async function pair(platform) {
  const pairing = api.startPairing()
  const hello = await (await fetch(`http://127.0.0.1:${PORT}/api/pair/hello`)).json()
  const channel = await pairChannel.openChannel(hello, pairing.code)
  const sealed = await pairChannel.sealRequest(channel, { code: pairing.code, deviceName: `Test ${platform}`, platform })
  const res = await fetch(`http://127.0.0.1:${PORT}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealed) })
  return (await pairChannel.openResponse(channel, await res.json())).token
}
async function approve(token, ids) {
  const path = '/api/held/approve'
  const raw = encrypt(token, { ids })
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: headers(token, 'POST', path, raw), body: raw })
  return { status: res.status, body: decrypt(token, await res.json()) }
}

;(async () => {
  // ─── Which drafts ──────────────────────────────────────────────
  check('a clean held draft may be approved', phoneReview.canApprove(ROWS[1]).ok, true)
  check('missing flags count as clean', phoneReview.canApprove(ROWS[2]).ok, true)
  check('a flagged draft stays on the desktop', phoneReview.canApprove(ROWS[3]).ok, false)
  check('a career-board draft cannot be approved here', phoneReview.canApprove(ROWS[4]).ok, false)
  check('an already-sent application cannot be approved', phoneReview.canApprove(ROWS[5]).ok, false)
  check('refusals are permanent, so a queue drops them', phoneReview.canApprove(ROWS[4]).permanent, true)
  const split = phoneReview.partition([1, 2, 3, 4, 5, 99, 1, 'x'])
  check('eligible ids, de-duplicated', split.accepted, [1, 2])
  check('every refusal says why', split.refused.map(r => r.id), [3, 4, 5, 99])
  check('at most ten at once', phoneReview.partition(Array.from({ length: 12 }, () => 1).map((_, i) => (i % 2) + 1)).accepted.length <= phoneReview.MAX_BATCH, true)

  // ─── Which devices ─────────────────────────────────────────────
  check('an iPhone may approve', phoneReview.deviceMayApprove({ platform: 'ios' }), true)
  check('an Android phone may approve', phoneReview.deviceMayApprove({ platform: 'android' }), true)
  check('the browser extension may not', phoneReview.deviceMayApprove({ platform: 'extension' }), false)
  check('the legacy shared token (no device) may not', phoneReview.deviceMayApprove(undefined), false)

  // ─── The endpoint ──────────────────────────────────────────────
  let started = null
  let busy = false
  api.setApproveHandler((ids, device) => {
    if (busy) return { ok: false, reason: 'busy' }
    started = { ids, device: device.name }
    return { ok: true }
  })
  try {
    await api.start()
    const phone = await pair('ios')
    const extension = await pair('extension')

    const ok = await approve(phone, [1, 3, 4])
    check('a phone\'s approval is accepted', ok.status, 202)
    check('only the eligible draft is started', started?.ids, [1])
    check('the refusals come back to the phone', ok.body.refused.map(r => r.id), [3, 4])

    started = null
    const ext = await approve(extension, [1])
    check('the extension is refused', ext.status, 403)
    check('…and nothing is started', started, null)

    started = null
    const none = await approve(phone, [3])
    check('nothing eligible starts nothing', none.body.started, false)
    check('…and nothing was submitted', started, null)

    busy = true
    const blocked = await approve(phone, [1])
    check('a busy desktop says so', blocked.status, 409)
  } finally {
    await api.stop()
  }
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
