// Drives the real LAN API server over HTTP: the bearer token gates access, and
// repeated failures from one peer lock it out rather than allowing unlimited
// guesses on a shared network.

const { stub, service, createChecker } = require('./helpers')

const statusWrites = []
const rejects = []
const nextActions = []
const completed = []
const TOKEN = 'a'.repeat(32)
const PORT = 48231
const cfg = { mobileApiEnabled: true, mobileApiPort: PORT, mobileApiToken: TOKEN }

const realPairing = require('../electron/services/pairing')
let deviceSecretCalls = 0
const pairingSpy = {
  ...realPairing,
  deviceSecrets: (...args) => { deviceSecretCalls++; return realPairing.deviceSecrets(...args) },
}

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
    // Mirrors the real setNextAction, which validates the date rather than
    // storing whatever it is handed — the route has to pass that refusal on as a
    // 400 rather than reporting success.
    setNextAction: (id, { date, note }) => {
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { success: false, reason: 'Date must be YYYY-MM-DD.' }
      }
      nextActions.push({ id, date, note })
      return { success: true }
    },
    completeNextAction: (id) => { completed.push(id); return { success: true } },
    getDueNextActions: () => [{ id: 1, job_title: 'Dev', company: 'Acme', next_action_at: '2026-08-01', next_action_note: 'Chase the recruiter' }],
  },
  './scheduler': { getScanInfo: () => ({ running: false }), requestScan: () => ({ id: 'x' }), cancelScan: () => {} },
  './logger': { append: () => {}, tail: () => [] },
  // The real pairing module, with the expensive call counted. deviceSecrets is
  // what unwraps every registered device token through the OS keychain, so it
  // stands in for "how much work did this request cost us".
  './pairing': pairingSpy,
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

  // A locked-out peer must cost nothing to refuse.
  //
  // The lockout used to be checked inside authCheck, which runs AFTER the
  // signature is verified — and verifying a signature reads the config (a file
  // parse plus seven keychain unwraps) and then HMACs the request once per
  // registered device. So the lockout gated the reply and not the work, and
  // anything on the LAN could keep the desktop busy doing keychain round trips
  // for the price of sending garbage.
  deviceSecretCalls = 0
  const forged = await fetch(`http://127.0.0.1:${PORT}/api/stats`, {
    headers: {
      'X-Hiro-Timestamp': String(Date.now()),
      'X-Hiro-Nonce': 'f'.repeat(32),
      'X-Hiro-Signature': 'd'.repeat(64),
    },
  })
  check('a forged signature is refused while locked out', forged.status, 429)
  check('and its signature was never verified', deviceSecretCalls, 0)
  check('the lockout is still reported as retryable', !!forged.headers.get('Retry-After'), true)

  // Re-pairing clears it, so a user fixing a stale token isn't stuck waiting.
  mobileApi.regenerateToken()
  check('regenerating the token clears the lockout', await call(cfg.mobileApiToken), 200)

  // With no lockout in force, a signed request IS verified — the gate above must
  // not have turned signature checking off altogether.
  deviceSecretCalls = 0
  await fetch(`http://127.0.0.1:${PORT}/api/stats`, {
    headers: {
      'X-Hiro-Timestamp': String(Date.now()),
      'X-Hiro-Nonce': 'e'.repeat(32),
      'X-Hiro-Signature': 'd'.repeat(64),
    },
  })
  check('an unthrottled signed request is still verified', deviceSecretCalls, 1)
  mobileApi.regenerateToken() // that forged attempt counted as a failure; reset

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

  // ── Follow-up dates over the LAN ────────────────────────────────
  // Deciding "chase them Thursday" is exactly the sort of thing done away from
  // the desk, and it needs no browser session — so the phone can write it.
  check('a next action can be set from the phone',
    (await post('/api/applications/1/next-action', { date: '2026-08-14', note: 'Chase' })).status, 200)
  check('the write reached the database', nextActions, [{ id: 1, date: '2026-08-14', note: 'Chase' }])

  // setNextAction refuses a malformed date rather than storing it; that has to
  // surface as a 400, not a silent success the phone reports as saved.
  const badDate = await post('/api/applications/1/next-action', { date: 'next thursday' })
  check('a malformed date is a 400', badDate.status, 400)
  check('with the reason from the database layer', /YYYY-MM-DD/.test(badDate.body.reason), true)

  // Clearing is a null date, which must be allowed through.
  check('a next action can be cleared',
    (await post('/api/applications/1/next-action', { date: null })).status, 200)

  check('an action can be marked done',
    (await post('/api/applications/2/next-action/done', {})).status, 200)
  check('completion reached the database', completed, [2])

  const dueRes = await get('/api/next-actions')
  check('due follow-ups are served', dueRes.status, 200)
  check('and carry their note', dueRes.body[0].next_action_note, 'Chase the recruiter')

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

  // ── Only private-range peers are served ─────────────────────────
  // The listener binds to every interface, so a machine with a public address
  // or a forwarded port would otherwise offer a cleartext bearer token to the
  // internet.
  const priv = mobileApi.isPrivateAddress
  check('loopback allowed', priv('127.0.0.1'), true)
  check('IPv6 loopback allowed', priv('::1'), true)
  check('10/8 allowed', priv('10.1.2.3'), true)
  check('192.168/16 allowed', priv('192.168.1.5'), true)
  check('172.16/12 allowed', priv('172.20.0.9'), true)
  check('IPv4-mapped IPv6 allowed', priv('::ffff:192.168.1.5'), true)
  check('link-local allowed', priv('169.254.10.1'), true)
  check('IPv6 unique-local allowed', priv('fd12::1'), true)
  check('scoped link-local allowed', priv('fe80::1%en0'), true)

  check('public IPv4 refused', priv('8.8.8.8'), false)
  check('172.32 is public, refused', priv('172.32.0.1'), false)
  check('public IPv6 refused', priv('2001:4860:4860::8888'), false)
  check('IPv4-mapped public refused', priv('::ffff:8.8.8.8'), false)
  check('unknown peer refused', priv('unknown'), false)

  done()
})()
