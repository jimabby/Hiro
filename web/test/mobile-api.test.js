// Drives the real LAN API server over HTTP: the bearer token gates access, and
// repeated failures from one peer lock it out rather than allowing unlimited
// guesses on a shared network.

const { stub, service, createChecker } = require('./helpers')

const statusWrites = []
const rejects = []
const TOKEN = 'a'.repeat(32)
const PORT = 48231
const cfg = { mobileApiEnabled: true, mobileApiPort: PORT, mobileApiToken: TOKEN }

stub({
  './config': {
    load: () => cfg,
    update: (patch) => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': {
    getStats: () => ({ totalAllTime: 7 }),
    getUpcomingInterviews: (limit) => [{ id: 1, job_title: 'Dev', company: 'Acme', scheduled_at: '2026-08-14 14:30:00', _limit: limit }],
    getSalaryStats: () => ({ count: 3, median: 120000 }),
    updateApplicationStatus: (id, status) => { statusWrites.push({ id, status }); return { success: true } },
    // Review mode: the phone may look at what is held back and reject a bad
    // draft, but approving means submitting, which needs the desktop's browser.
    getHeldApplications: () => [{ id: 4, job_title: 'Held Role', company: 'Acme', match_score: 91 }],
    rejectHeldApplication: (id) => { rejects.push(id); return { success: true } },
    getAiUsageSummary: () => ({ month: { calls: 12, cost: 0.42 }, today: { calls: 3, cost: 0.1 } }),
    getApplicationsList: () => [],
  },
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

const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: { Authorization: `Bearer ${cfg.mobileApiToken}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const post = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.mobileApiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
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

  // ── Routes the phone needs for interviews and pay ───────────────
  const interviews = await get('/api/interviews?limit=5')
  check('interviews route served', interviews.status, 200)
  check('interviews limit is honoured', interviews.body[0]._limit, 5)
  // An out-of-range limit is clamped rather than passed through to a query.
  check('absurd limit clamped', (await get('/api/interviews?limit=99999')).body[0]._limit, 200)
  check('non-numeric limit falls back', (await get('/api/interviews?limit=abc')).body[0]._limit, 25)
  check('salary route served', (await get('/api/salary')).body.median, 120000)

  // ── Status vocabulary ───────────────────────────────────────────
  // Every status the desktop can write must be settable from the phone, or the
  // phone can display a status it isn't allowed to choose.
  for (const status of ['applied', 'interview', 'offer', 'rejected', 'pending', 'no_response', 'skipped', 'held']) {
    const res = await post('/api/applications/1/status', { status })
    check(`status '${status}' accepted`, res.status, 200)
  }
  check('unknown status rejected', (await post('/api/applications/1/status', { status: 'maybe' })).status, 400)
  check('missing status rejected', (await post('/api/applications/1/status', {})).status, 400)
  check('accepted statuses reached the database', statusWrites.length, 8)

  // ── Review queue over the LAN ───────────────────────────────────
  const heldRes = await get('/api/held')
  check('held drafts are served', heldRes.status, 200)
  check('held draft carries its match score', heldRes.body[0].match_score, 91)
  check('a held draft can be rejected from the phone', (await post('/api/held/4/reject', {})).status, 200)
  check('the rejection reached the database', rejects, [4])

  check('ai usage is served', (await get('/api/ai-usage')).body.month.cost, 0.42)

  check('unknown route still 404s', (await get('/api/nope')).status, 404)

  // ── Stopping actually stops ─────────────────────────────────────
  // close() alone leaves keep-alive sockets serving requests, so turning the
  // mobile API off in Settings did not cut off a connected phone.
  await mobileApi.stop()
  check('the server reports stopped', mobileApi.getInfo().running, false)
  let reachable = true
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/ping`, {
      headers: { Authorization: `Bearer ${cfg.mobileApiToken}` },
    })
  } catch {
    reachable = false
  }
  check('the port is no longer served', reachable, false)

  done()
})()
