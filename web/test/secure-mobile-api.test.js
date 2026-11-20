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
// Ask Hiro, as the phone reaches it.
const askCalls = []
const askThreads = new Map([[5, { id: 5, title: 'CV review', updated_at: 'x', documents: { resumeName: 'Data CV', resumeText: 'Jane Doe EXPERIENCE Acme', jobText: 'Spark role' }, messages: [{ id: 1, role: 'user', content: 'Review it', actions: [], error: false }] }]])
cfg.resumes = [{ id: 'r1', name: 'Data CV', text: 'Jane Doe EXPERIENCE Acme' }, { id: 'r2', name: 'Empty', text: '' }]
stub({
  './askHiro': {
    askInThread: async (question, threadId, opts) => {
      askCalls.push({ question, threadId, opts })
      if (question === 'fail') throw Object.assign(new Error('Set up an AI provider in Settings to use Ask Hiro.'), { threadId: 9 })
      return { reply: 'Here you go.', actions: [{ type: 'draft', kind: 'resume', checked: true, flags: [] }], threadId: threadId || 6 }
    },
  },
  './config': {
    load: () => cfg,
    update: patch => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    encryptSecret: value => `wrapped:${value}`,
    decryptSecret: value => String(value).replace(/^wrapped:/, ''),
    CONFIG_DIR: '/tmp/hiro-secure-test',
  },
  './database': {
    listAskThreads: () => [...askThreads.values()].map(t => ({ id: t.id, title: t.title })),
    getAskThread: (id) => askThreads.get(Number(id)) || null,
    deleteAskThread: (id) => { askThreads.delete(Number(id)); return { success: true } },
    getStats: () => ({ totalAllTime: 17 }),
    // Ids 1–99 exist; anything else is a deleted row.
    applicationExists: (id) => Number(id) >= 1 && Number(id) < 100,
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
    async function pairDevice(scopes, name, platform = 'test') {
      const session = api.startPairing({ scopes })
      const hi = await (await fetch(`http://127.0.0.1:${PORT}/api/pair/hello`)).json()
      const ch = await pairChannel.openChannel(hi, session.code)
      // A device asking for more than it was granted is ignored.
      const body = JSON.stringify(await pairChannel.sealRequest(ch, { code: session.code, deviceName: name, platform, scopes: ['read', 'write', 'scan'] }))
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

    // ── Ask Hiro from the phone ─────────────────────────────────────
    const phone = await pairDevice(['read', 'write'], 'Pixel', 'android')
    api._resetThrottle()
    check('a paired phone lists conversations', (await signedCall(phone.token, 'GET', '/api/ask/threads')).body, [{ id: 5, title: 'CV review' }])
    const opened = (await signedCall(phone.token, 'GET', '/api/ask/threads/5')).body
    check('a conversation names its résumé without sending the text back',
      [opened.documents.resumeName, opened.documents.hasResume, opened.documents.resumeWords, 'resumeText' in opened.documents], ['Data CV', true, 4, false])
    check('saved résumés are offered by name, and empty ones are not', (await signedCall(phone.token, 'GET', '/api/ask/resumes')).body, [{ id: 'r1', name: 'Data CV', words: 4 }])

    const asked = await signedCall(phone.token, 'POST', '/api/ask', { question: 'Tailor it', threadId: 5 })
    check('a question is answered', [asked.status, asked.body.reply, asked.body.threadId], [200, 'Here you go.', 5])
    check('drafts come back with their checks', asked.body.actions[0].type, 'draft')
    check('without a choice, the thread keeps what it is about', askCalls.at(-1).opts, {})

    await signedCall(phone.token, 'POST', '/api/ask', { question: 'Now this job', threadId: 5, jobText: 'Rust role' })
    check('a new job ad keeps the thread\'s résumé', askCalls.at(-1).opts.documents, { resumeName: 'Data CV', resumeText: 'Jane Doe EXPERIENCE Acme', jobText: 'Rust role' })
    await signedCall(phone.token, 'POST', '/api/ask', { question: 'Start over', resumeId: 'r1' })
    check('a saved résumé is looked up on the desktop by id', askCalls.at(-1).opts.documents, { resumeName: 'Data CV', resumeText: 'Jane Doe EXPERIENCE Acme', jobText: '' })
    await signedCall(phone.token, 'POST', '/api/ask', { question: 'No résumé', threadId: 5, resumeId: '' })
    check('an empty id removes the résumé', askCalls.at(-1).opts.documents.resumeText, '')
    check('an unknown résumé is refused', (await signedCall(phone.token, 'POST', '/api/ask', { question: 'x', resumeId: 'gone' })).status, 400)
    check('an empty question is refused', (await signedCall(phone.token, 'POST', '/api/ask', { question: '  ' })).status, 400)
    const failedAsk = await signedCall(phone.token, 'POST', '/api/ask', { question: 'fail' })
    check('the assistant\'s own explanation reaches the phone', [failedAsk.status, /AI provider/.test(failedAsk.body.error), failedAsk.body.threadId], [422, true, 9])
    check('a conversation can be deleted from the phone', [(await signedCall(phone.token, 'POST', '/api/ask/threads/5/delete', {})).body.success, askThreads.has(5)], [true, false])

    const callsBefore = askCalls.length
    const extension = await pairDevice(['read', 'write'], 'Browser extension')
    api._resetThrottle()
    const notPhone = await signedCall(extension.token, 'POST', '/api/ask', { question: 'Spend money' })
    check('a device that is not a phone cannot ask (it spends on the desktop\'s AI key)', notPhone.status, 403)
    check('and nothing was asked', askCalls.length, callsBefore)
    const readOnlyPhone = await pairDevice(['read'], 'Read-only Pixel', 'android')
    api._resetThrottle()
    check('a read-only phone cannot ask', (await signedCall(readOnlyPhone.token, 'POST', '/api/ask', { question: 'x' })).status, 403)

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
