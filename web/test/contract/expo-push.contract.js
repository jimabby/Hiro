// Does Expo's push service still reply in the shape push.js parses?
//
// Needs no credentials: the endpoint accepts unauthenticated sends, so a
// deliberately invalid token exercises the whole request/response contract without
// a phone, an Expo account, or a real notification.
//
// What breaks silently if this changes: push.js reads `body.data[]`, each entry's
// `status`, and `details.error === 'DeviceNotRegistered'` to clear dead tokens. A
// renamed field means every send is counted as a failure, or worse, a dead token is
// never cleared and every later send wastes a slot on it.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
const note = (msg) => console.log(`      ${msg}`)

async function post(messages, ms = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  // A well-formed but unregistered token. Expo accepts the request and reports the
  // per-message outcome in a ticket, which is the contract under test.
  const fake = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'
  let res
  try {
    res = await post([{ to: fake, title: 'Hiro contract test', body: 'ignore me', sound: 'default' }])
  } catch (err) {
    console.log(`SKIP  could not reach ${EXPO_PUSH_URL} (${err.message})`)
    return
  }

  check('the endpoint accepts an unauthenticated send', res.status, 200)
  check('the reply has a data array', Array.isArray(res.body?.data), true)
  if (!Array.isArray(res.body?.data)) return

  check('one ticket per message', res.body.data.length, 1)
  const ticket = res.body.data[0]
  note(`ticket: ${JSON.stringify(ticket)}`)
  // push.js branches on exactly this field.
  check('each ticket carries a status', typeof ticket?.status, 'string')
  check('the status is one Hiro recognises', ['ok', 'error'].includes(ticket.status), true)

  if (ticket.status === 'error') {
    // The error shape push.js reads to decide whether to clear a stored token.
    check('an error ticket carries details', typeof ticket.details, 'object')
    check('and names the error', typeof ticket.details?.error, 'string')
    note(`error code: ${ticket.details?.error}`)
    // This exact string is what dropDeadToken() keys off. If Expo renames it,
    // dead tokens accumulate forever.
    check('the unregistered-device code is still DeviceNotRegistered',
      ticket.details.error, 'DeviceNotRegistered')
  }

  // ── Batching ────────────────────────────────────────────────
  // push.js chunks at 100. A lowered ceiling would start rejecting whole batches.
  const many = Array.from({ length: 100 }, () => ({ to: fake, title: 'x', body: 'y' }))
  const batch = await post(many, 30000)
  check('a 100-message batch is accepted', batch.status, 200)
  check('and returns 100 tickets', batch.body?.data?.length, 100)

  // ── A malformed token is rejected, not silently dropped ─────
  const bad = await post([{ to: 'not-a-push-token', title: 'x', body: 'y' }])
  // Expo reports this either as a 400 with an errors array or as an error ticket;
  // both are handled, and either way it must not look like a success.
  const looksSuccessful = bad.status === 200 && bad.body?.data?.[0]?.status === 'ok'
  check('a malformed token is not reported as delivered', looksSuccessful, false)

  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(err => { console.error(err); process.exitCode = 1 })
