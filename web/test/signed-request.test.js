// Why a signed request was refused, and which refusals count against the lockout.
//
// The bug this suite pins down: verifySignedRequest used to return a bare null
// for every rejection, and the caller then fell through to the bearer-token
// path — which, for a phone paired with the encrypted protocol, means falling
// through with no bearer token at all. So every rejection counted as a failed
// authentication.
//
// That is right for a bad signature and catastrophic for a wrong clock. A phone
// whose time had drifted past five minutes failed, counted, failed, counted, and
// after ten polls locked ITSELF out for five minutes — then did it again, and
// again, while being told "too many failed attempts". The one action that would
// fix it is not one that message would ever suggest.

const crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')

const DEVICE_TOKEN = 'd'.repeat(64)
const cfg = { mobileApiToken: 'l'.repeat(32), mobileDevices: [] }

stub({
  './config': {
    load: () => cfg,
    update: patch => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    encryptSecret: v => v,
    decryptSecret: v => v,
    CONFIG_DIR: '/tmp/hiro-signed-test',
  },
  './pairing': {
    deviceSecrets: () => [{ token: DEVICE_TOKEN, device: { id: 'dev1', name: 'Test phone' } }],
    touchDevice: () => {},
    verifyDeviceToken: () => null,
    listDevices: () => [],
    pruneExpiredDevices: () => ({ removed: 0 }),
    normaliseTtlDays: () => 90,
    getActiveCode: () => null,
  },
  './database': {},
  './scheduler': {},
  './logger': { append: () => {}, tail: () => [] },
})

const api = service('mobileApi.js')
const { check, done } = createChecker()

function signedRequest({ method = 'GET', url = '/api/stats', body = '', token = DEVICE_TOKEN, at = Date.now(), nonce = null } = {}) {
  const timestamp = String(at)
  const n = nonce || crypto.randomBytes(16).toString('hex')
  const input = [method, url, timestamp, n, body].join('\n')
  return {
    method,
    url,
    headers: {
      'x-hiro-timestamp': timestamp,
      'x-hiro-nonce': n,
      'x-hiro-signature': crypto.createHmac('sha256', token).update(input).digest('hex'),
    },
  }
}

// ── A well-formed request from a paired device ───────────────────
const good = api.verifySignedRequest(signedRequest(), '')
check('a correctly signed request is accepted', good.ok, true)
check('and is reported as a signed request', good.signed, true)
check('and names the device it came from', good.candidate.device.id, 'dev1')

// ── No signature headers at all ──────────────────────────────────
// Not a rejection: an unsigned request has nothing to verify, and the bearer
// path handles it. Reporting this as a failure would count every legacy client's
// every request against the lockout.
const unsigned = api.verifySignedRequest({ method: 'GET', url: '/api/stats', headers: {} }, '')
check('an unsigned request is not a signed request', unsigned.signed, false)
check('and is not reported as a failure', unsigned.ok, undefined)

// ── A wrong clock ────────────────────────────────────────────────
const slow = api.verifySignedRequest(signedRequest({ at: Date.now() - 9 * 60 * 1000 }), '')
check('a clock nine minutes slow is refused', slow.ok, false)
check('and the reason is the clock, not the credential', slow.reason, 'clock')
check('and the skew is reported so it can be explained', Math.round(slow.skewMs / 60000), 9)

const fast = api.verifySignedRequest(signedRequest({ at: Date.now() + 9 * 60 * 1000 }), '')
check('a clock nine minutes fast is refused too', fast.reason, 'clock')
check('and the skew is signed the other way', fast.skewMs < 0, true)

// Inside the window is fine — this is the case that must NOT be broken by
// tightening the one above.
check('a clock four minutes out is still accepted',
  api.verifySignedRequest(signedRequest({ at: Date.now() - 4 * 60 * 1000 }), '').ok, true)

// ── The message a person gets ────────────────────────────────────
// The whole point of separating the reasons: the holder of the phone can act on
// this one, and "too many failed attempts" gave them nothing to act on.
const explanation = api.describeSignatureFailure(slow)
check('the clock failure names the clock', /clock/i.test(explanation), true)
check('and says which way it is wrong', /behind/.test(explanation), true)
check('and says what to do about it', /automatic date/i.test(explanation), true)
check('an ahead clock is described as ahead',
  /ahead of/.test(api.describeSignatureFailure(fast)), true)

// ── Replay ───────────────────────────────────────────────────────
const nonce = crypto.randomBytes(16).toString('hex')
const first = signedRequest({ nonce })
check('a nonce works once', api.verifySignedRequest(first, '').ok, true)
const replayed = api.verifySignedRequest(first, '')
check('and not twice', replayed.ok, false)
check('and the reason is a replay, not a bad signature', replayed.reason, 'replay')
check('which is explained as normal after a retry',
  /already used once/.test(api.describeSignatureFailure(replayed)), true)

// ── An actually bad signature ────────────────────────────────────
// This one IS an authentication failure and must stay one.
const forged = api.verifySignedRequest(signedRequest({ token: 'wrong-token-entirely' }), '')
check('a signature from the wrong key is refused', forged.ok, false)
check('and is reported as a signature failure', forged.reason, 'signature')
check('which gets no special explanation', api.describeSignatureFailure(forged), 'Unauthorized')

// ── The body is part of what is signed ───────────────────────────
const withBody = signedRequest({ method: 'POST', url: '/api/scan', body: '{"keywords":"data"}' })
check('a signature over the body verifies against that body',
  api.verifySignedRequest(withBody, '{"keywords":"data"}').ok, true)
const tampered = signedRequest({ method: 'POST', url: '/api/scan', body: '{"keywords":"data"}' })
check('and fails against a different one',
  api.verifySignedRequest(tampered, '{"keywords":"tampered"}').reason, 'signature')

// ── Malformed headers ────────────────────────────────────────────
check('a signature with no nonce is malformed', api.verifySignedRequest({
  method: 'GET', url: '/x', headers: { 'x-hiro-timestamp': String(Date.now()), 'x-hiro-signature': 'abc' },
}, '').reason, 'malformed')
check('a non-numeric timestamp is malformed', api.verifySignedRequest({
  method: 'GET', url: '/x', headers: { 'x-hiro-timestamp': 'soon', 'x-hiro-nonce': 'n', 'x-hiro-signature': 'abc' },
}, '').reason, 'malformed')

done()
