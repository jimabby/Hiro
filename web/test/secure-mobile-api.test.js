// Exercises the complete new-phone path over a real HTTP socket: redeem a
// one-time code, sign a request, decrypt the response, send an encrypted write,
// and prove the same nonce cannot be replayed.
const crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')

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

function decrypt(token, envelope) {
  const combined = Buffer.from(envelope.data, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(token), combined.subarray(0, 12))
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
    const pairRes = await fetch(`http://127.0.0.1:${PORT}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'Test phone', platform: 'test' }),
    })
    const paired = await pairRes.json()
    check('one-time pairing succeeds', pairRes.status, 200)
    check('desktop keeps only a wrapped device secret', cfg.mobileDevices[0].tokenEnc.startsWith('wrapped:'), true)

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

    const replay = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: signed })
    check('replayed nonce is rejected', replay.status, 401)
  } finally {
    await api.stop()
    done()
  }
})()
