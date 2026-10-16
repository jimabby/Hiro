// Exercises the complete new-phone path over a real HTTP socket: redeem a
// one-time code, sign a request, decrypt the response, send an encrypted write,
// and prove the same nonce cannot be replayed.
const crypto = require('crypto')
const path_ = require('path')
const { stub, service, createChecker } = require('./helpers')
// The browser extension's own implementation, run in Node.
const pairChannel = require(path_.join(__dirname, '..', '..', 'extension', 'pairChannel.js'))
// The phone's response-binding format (plain CommonJS, no React Native).
const responseBinding = require(path_.join(__dirname, '..', '..', 'app', 'src', 'responseBinding.js'))

const PORT = 48232
const cfg = { mobileApiEnabled: true, mobileApiPort: PORT, mobileApiToken: 'l'.repeat(32), mobileDevices: [] }
let statusWrite = null
let imported = null
stub({
  './config': {
    load: () => cfg,
    update: patch => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    encryptSecret: value => `wrapped:${value}`,
    decryptSecret: value => String(value).replace(/^wrapped:/, ''),
    CONFIG_DIR: '/tmp/hiro-secure-test',
  },
  './database': {
    getStats: () => ({ totalAllTime: 17 }),
    updateApplicationStatus: (id, status) => { statusWrite = { id, status }; return { success: true } },
    insertAttentionJob: value => { imported = value; return { success: true, id: 22 } },
  },
  './scheduler': { getScanInfo: () => ({ running: false }) },
  './logger': { append: () => {}, tail: () => [] },
})

const api = service('mobileApi.js')
const { check, done } = createChecker()
const key = token => crypto.createHash('sha256').update(token).digest()

function encrypt(token, value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(token), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return JSON.stringify({ secure: 2, data: Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64') })
}

function decrypt(token, envelope, aad = null) {
  const combined = Buffer.from(envelope.data, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(token), combined.subarray(0, 12))
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(combined.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(12, -16)), decipher.final()]).toString())
}

function headers(token, method, path, raw, timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex')) {
  const input = [method, path, timestamp, nonce, raw].join('\n')
  return {
    'Content-Type': 'application/json',
    'X-Hiro-Timestamp': timestamp,
    'X-Hiro-Nonce': nonce,
    'X-Hiro-Signature': crypto.createHmac('sha256', token).update(input).digest('hex'),
  }
}

;(async () => {
  try {
    await api.start()
    const pairing = api.startPairing()

    // The pairing exchange runs over an encrypted channel, because the reply
    // carries a 90-day token and this is plain HTTP. The client half here is the
    // real extension implementation (WebCrypto), so this exercises the same code
    // a browser runs — see pair-channel.test.js for the three-way agreement.
    const helloRes = await fetch(`http://127.0.0.1:${PORT}/api/pair/hello`)
    const hello = await helloRes.json()
    check('the desktop offers a pairing channel', helloRes.status, 200)
    check('the hello is unauthenticated but tagged', typeof hello.tag, 'string')

    const channel = await pairChannel.openChannel(hello, pairing.code)
    const sealed = await pairChannel.sealRequest(channel, {
      code: pairing.code, deviceName: 'Test phone', platform: 'test',
    })
    const pairBody = JSON.stringify(sealed)
    check('the pairing code does not travel in the clear', pairBody.includes(pairing.code), false)

    const pairRes = await fetch(`http://127.0.0.1:${PORT}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pairBody,
    })
    const pairEnvelope = await pairRes.json()
    check('one-time pairing succeeds', pairRes.status, 200)
    const paired = await pairChannel.openResponse(channel, pairEnvelope)
    check('the device token does not travel in the clear',
      JSON.stringify(pairEnvelope).includes(paired.token), false)
    check('desktop keeps only a wrapped device secret', cfg.mobileDevices[0].tokenEnc.startsWith('wrapped:'), true)

    // The code is single-use, so the whole exchange is spent — a captured
    // request cannot be replayed to mint a second token.
    const replayPair = await fetch(`http://127.0.0.1:${PORT}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pairBody,
    })
    check('a replayed pairing request is refused', replayPair.status >= 400, true)
    check('and no second device was created', cfg.mobileDevices.length, 1)

    const path = '/api/stats'
    const signed = headers(paired.token, 'GET', path, '')
    const statsRes = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: signed })
    const statsEnvelope = await statsRes.json()
    check('signed request succeeds', statsRes.status, 200)
    check('response is encrypted', statsEnvelope.secure, 2)
    check('encrypted response decrypts', decrypt(paired.token, statsEnvelope).totalAllTime, 17)

    const writePath = '/api/applications/9/status'
    const raw = encrypt(paired.token, { status: 'interview' })
    const writeRes = await fetch(`http://127.0.0.1:${PORT}${writePath}`, {
      method: 'POST', headers: headers(paired.token, 'POST', writePath, raw), body: raw,
    })
    check('encrypted write succeeds', writeRes.status, 200)
    check('encrypted write reaches database', statusWrite, { id: 9, status: 'interview' })

    const importPath = '/api/import-job'
    const importRaw = encrypt(paired.token, { url: 'https://jobs.example/42', title: 'Platform Engineer', company: 'Example' })
    const importRes = await fetch(`http://127.0.0.1:${PORT}${importPath}`, {
      method: 'POST', headers: headers(paired.token, 'POST', importPath, importRaw), body: importRaw,
    })
    check('secure extension import succeeds', importRes.status, 200)
    check('extension import reaches Needs Attention', imported.job_title, 'Platform Engineer')

    // Response binding: a phone that asks gets a reply sealed to this request's
    // method, path and nonce. The AAD is computed with the PHONE's own module,
    // so a drift between the two halves fails here.
    const bindNonce = crypto.randomBytes(16).toString('hex')
    const boundRes = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      headers: { ...headers(paired.token, 'GET', path, '', String(Date.now()), bindNonce), 'X-Hiro-Response-Binding': '1' },
    })
    const boundEnvelope = await boundRes.json()
    check('a bound reply is marked bound', boundEnvelope.bound, 1)
    const aad = responseBinding.responseAad('GET', path, bindNonce)
    check('it opens with the phone-computed binding', decrypt(paired.token, boundEnvelope, aad).totalAllTime, 17)
    const opensWith = a => { try { decrypt(paired.token, boundEnvelope, a); return true } catch { return false } }
    check('it does not open without the binding', opensWith(null), false)
    check('it does not open for another nonce', opensWith(responseBinding.responseAad('GET', path, 'other')), false)
    check('it does not open for another path', opensWith(responseBinding.responseAad('GET', '/api/offers', bindNonce)), false)
    check('a client that does not ask still gets the legacy envelope', statsEnvelope.bound, undefined)

    const replay = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: signed })
    check('replayed nonce is rejected', replay.status, 401)

    // ── Per-device activity ─────────────────────────────────────────
    await new Promise(r => setTimeout(r, 20))
    const firstDevice = cfg.mobileDevices[0]
    const activity = api.deviceActivity(firstDevice.id)
    // stats, the status write, the import and the bound stats read; the replay
    // was refused before any device was identified, so it belongs to nobody.
    check('each request is recorded against its device', activity.map(a => a.path), ['/api/stats', '/api/import-job', '/api/applications/9/status', '/api/stats'])
    check('newest first, with method, status and address',
      [activity[0].method, activity[0].status, activity[0].ip.includes('127.0.0.1'), typeof activity[0].at], ['GET', 200, true, 'string'])
    check('the import is recorded as a write',
      [activity[1].method, activity[1].status], ['POST', 200])
    check('the query string is never recorded',
      activity.every(a => !a.path.includes('?')), true)

    // ── Scopes, chosen on the desktop when the code is generated ────
    async function pairDevice(scopes, name) {
      const session = api.startPairing({ scopes })
      const hi = await (await fetch(`http://127.0.0.1:${PORT}/api/pair/hello`)).json()
      const ch = await pairChannel.openChannel(hi, session.code)
      // A device asking for more than it was granted is ignored.
      const body = JSON.stringify(await pairChannel.sealRequest(ch, { code: session.code, deviceName: name, platform: 'test', scopes: ['read', 'write', 'scan'] }))
      const res = await fetch(`http://127.0.0.1:${PORT}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      return pairChannel.openResponse(ch, await res.json())
    }
    async function signedCall(token, method, p, value) {
      const raw = value === undefined ? '' : encrypt(token, value)
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: headers(token, method, p, raw), body: raw || undefined })
      const envelope = await res.json().catch(() => null)
      return { status: res.status, body: envelope?.secure === 2 ? decrypt(token, envelope) : envelope }
    }

    const reader = await pairDevice(['read'], 'Read-only phone')
    check('the pairing reply states the granted scopes', reader.device.scopes, ['read'])
    check('a read-only device can read', (await signedCall(reader.token, 'GET', '/api/stats')).status, 200)
    const refused = await signedCall(reader.token, 'POST', '/api/applications/9/status', { status: 'offer' })
    check('a read-only device cannot write', refused.status, 403)
    check('and is told which permission it lacks', refused.body.scope, 'write')
    check('a read-only device cannot start a scan', (await signedCall(reader.token, 'POST', '/api/scan', {})).status, 403)
    check('ping reports the device its scopes', (await signedCall(reader.token, 'GET', '/api/ping')).body.scopes, ['read'])

    const readerId = cfg.mobileDevices.find(d => d.name === 'Read-only phone').id
    check('scopes can be changed after pairing', api.setDeviceScopes(readerId, ['read', 'write']).scopes, ['read', 'write'])
    check('and take effect on the next request',
      (await signedCall(reader.token, 'POST', '/api/applications/9/status', { status: 'offer' })).status, 200)
    check('the device list shows them', api.listDevices().find(d => d.id === readerId).scopes, ['read', 'write'])
    check('a device paired before scopes existed keeps all three', api.listDevices().find(d => d.id === firstDevice.id).scopes, ['read', 'write', 'scan'])

    // ── Rotation without re-pairing ─────────────────────────────────
    const beforeExpiry = cfg.mobileDevices.find(d => d.id === readerId).expiresAt
    await new Promise(r => setTimeout(r, 5))
    const rotated = await signedCall(reader.token, 'POST', '/api/rotate')
    check('a signed rotation succeeds', rotated.status, 200)
    check('it returns a new token', typeof rotated.body.token === 'string' && rotated.body.token !== reader.token, true)
    check('with the device it belongs to', rotated.body.device.id, readerId)
    check('and a later expiry', new Date(rotated.body.expiresAt) > new Date(beforeExpiry), true)
    await new Promise(r => setTimeout(r, 20))
    check('the new token works', (await signedCall(rotated.body.token, 'GET', '/api/stats')).status, 200)
    check('the old token is retired once the reply went out', (await signedCall(reader.token, 'GET', '/api/stats')).status, 401)
    check('the device keeps its scopes across rotation',
      api.listDevices().find(d => d.id === readerId).scopes, ['read', 'write'])
    check('no second device was created', cfg.mobileDevices.filter(d => d.name === 'Read-only phone').length, 1)
    api._resetThrottle()

    const bearerRotate = await fetch(`http://127.0.0.1:${PORT}/api/rotate`, {
      method: 'POST', headers: { Authorization: `Bearer ${rotated.body.token}` },
    })
    check('rotation over the unsigned bearer path is refused', bearerRotate.status, 400)

    // ── A device can revoke itself ──────────────────────────────────
    const revoked = await signedCall(rotated.body.token, 'POST', '/api/devices/self/revoke', {})
    check('self-revocation succeeds', [revoked.status, revoked.body.success], [200, true])
    check('the device is gone from the list', cfg.mobileDevices.some(d => d.id === readerId), false)
    check('and its token no longer works', (await signedCall(rotated.body.token, 'GET', '/api/stats')).status, 401)
    check('its activity log went with it', api.deviceActivity(readerId), [])
    check('other devices are untouched', cfg.mobileDevices.some(d => d.id === firstDevice.id), true)
    api._resetThrottle()
  } finally {
    await api.stop()
    done()
  }
})()
