// The calendar OAuth loopback listener and token exchange.
//
// The listener used to reject the whole sign-in on the first hit to /callback
// whose state did not match — so anything able to reach 127.0.0.1 (a web page
// firing a request at the port, another local process) could cancel a sign-in
// the user was halfway through. And the token exchange had no timeout, so a
// token endpoint that accepted the connection and never answered held the
// connect button, or a calendar sync, forever.

const { stub, service, createChecker } = require('./helpers')

stub({
  './config': { load: () => ({}), update: () => {}, CONFIG_DIR: '/tmp/hiro-cal-auth' },
  './logger': { append: () => {} },
})

const calendarAuth = service('calendarAuth.js')
const { check, done } = createChecker()

;(async () => {
  const listener = await calendarAuth.startCallbackListener('right-state', 5000)
  const base = `http://127.0.0.1:${listener.port}/callback`
  let settled = null
  listener.code.then(v => { settled = { code: v } }, e => { settled = { error: e.message } })

  const stray = await fetch(`${base}?state=wrong&code=forged`)
  check('a callback with the wrong state is refused', stray.status, 400)
  const noState = await fetch(`${base}?error=access_denied`)
  check('so is an error with no state at all', noState.status, 400)
  await new Promise(r => setTimeout(r, 20))
  check('and neither one ends the sign-in', settled, null)

  const real = await fetch(`${base}?state=right-state&code=the-real-code`)
  check('the genuine redirect is accepted', real.status, 200)
  check('and delivers its code', await listener.code, 'the-real-code')

  // A provider-reported error with the right state still ends the flow.
  const refusing = await calendarAuth.startCallbackListener('s2', 5000)
  const outcome = refusing.code.then(() => 'resolved', e => e.message)
  await fetch(`http://127.0.0.1:${refusing.port}/callback?state=s2&error=access_denied`)
  check('a real refusal from the provider is reported', /access_denied/.test(await outcome), true)

  // ── Token exchange timeout ────────────────────────────────────
  let seenSignal = null
  global.fetch = (_url, opts) => new Promise((_, reject) => {
    seenSignal = opts.signal
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
  })
  const keepAlive = setTimeout(() => {}, 2000) // AbortSignal.timeout does not hold the loop open
  let error = null
  try { await calendarAuth.exchange('google', { grant_type: 'refresh_token' }, { timeoutMs: 30 }) } catch (err) { error = err }
  clearTimeout(keepAlive)
  check('the token exchange carries a timeout signal', !!seenSignal, true)
  check('a token endpoint that never answers times out', /did not answer/.test(error?.message || ''), true)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
