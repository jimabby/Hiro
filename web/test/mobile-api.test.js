// Drives the real LAN API server over HTTP: the bearer token gates access, and
// repeated failures from one peer lock it out rather than allowing unlimited
// guesses on a shared network.

const { stub, service, createChecker } = require('./helpers')

const TOKEN = 'a'.repeat(32)
const PORT = 48231
const cfg = { mobileApiEnabled: true, mobileApiPort: PORT, mobileApiToken: TOKEN }

stub({
  './config': {
    load: () => cfg,
    update: (patch) => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': { getStats: () => ({ totalAllTime: 7 }) },
  './scheduler': { getScanInfo: () => ({ running: false }), requestScan: () => ({ id: 'x' }), cancelScan: () => {} },
  './logger': { append: () => {}, tail: () => [] },
})

const mobileApi = service('mobileApi.js')
const { check, done } = createChecker()

const call = async (token) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.status
}

;(async () => {
  await mobileApi.start()

  check('valid token accepted', await call(TOKEN), 200)
  check('wrong token rejected', await call('b'.repeat(32)), 401)
  check('wrong-length token rejected', await call('short'), 401)

  // Burn the remaining allowance (10 failures total, 2 already spent above).
  const statuses = []
  for (let i = 0; i < 9; i++) statuses.push(await call('c'.repeat(32)))
  check('earlier attempts are plain 401s', statuses[0], 401)
  check('locks out after repeated failures', statuses[statuses.length - 1], 429)

  // The lockout is per-peer and holds even for a correct token.
  check('valid token also blocked during lockout', await call(TOKEN), 429)

  // Re-pairing clears it, so a user fixing a stale token isn't stuck waiting.
  mobileApi.regenerateToken()
  check('regenerating the token clears the lockout', await call(cfg.mobileApiToken), 200)

  mobileApi.stop()
  done()
})()
