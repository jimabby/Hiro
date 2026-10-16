// What a failed request to the desktop or the cloud means for the thing that
// sent it: wait and try again, stop and re-pair, or give up.
//
// Every failure used to be read as "Desktop offline". A scan refused with 401
// (revoked token), 429 (lockout) or 400 (bad input) was queued as if the desktop
// were merely unreachable, and because the queue stops at its first failure, a
// request that would ALWAYS be refused sat at the head of it forever and held
// back every request behind it.
//
// CommonJS and free of react-native imports so the plain-Node suite can reach it
// — see test/run.js.

// Messages that mean the request never reached anything that could answer it.
// React Native's fetch rejects with "Network request failed"; browsers and
// supabase-js say "Failed to fetch"; api.js turns an abort into a timeout
// message that names the desktop.
const NETWORK_MESSAGE = /network request failed|failed to fetch|network ?error|timed out|timeout|offline|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|not on the internet|internet connection/i

// Returns one of:
//   'offline'  — never reached the destination, or no answer came back. Safe to
//                queue: the request carries an idempotency key, so a timeout
//                after the desktop DID act cannot run it twice.
//   'auth'     — 401: the credential is no longer accepted. Re-pair or sign in.
//   'busy'     — 408, 429, 5xx: the destination answered but cannot take it
//                now. Worth retrying later, but not a reason to call it offline.
//   'rejected' — any other 4xx, or a reply that could not be trusted. Retrying
//                the same request gets the same answer, so it is dropped.
function classifyError(err) {
  if (!err) return 'rejected'
  if (err.network || err.timeout) return 'offline'
  const status = Number(err.status)
  if (status === 401 || err.needsPairing) return 'auth'
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return 'busy'
  if (status >= 400 && status < 500) return 'rejected'
  // A response that failed to authenticate (tampered, reflected or replayed) is
  // not something waiting will fix.
  if (err.untrusted) return 'rejected'
  if (NETWORK_MESSAGE.test(String(err.message || ''))) return 'offline'
  // Anything else — a database error from Supabase, a missing table — answers
  // the same way however often it is asked. HiroClient flags every transport
  // failure explicitly (err.network / err.timeout), so nothing that really was
  // a dropped connection reaches this line from the LAN client.
  return 'rejected'
}

// What to tell the user. A 403 that names a scope means the desktop paired this
// phone without that permission (devices carry `read`, `scan`, `write`); the
// desktop's bare "Forbidden" said nothing about how to fix it. Never queued —
// it is a 4xx, so classifyError calls it 'rejected'.
const SCOPE_WORDS = { read: 'view your applications', scan: 'start scans', write: 'make changes' }
function messageFor(err) {
  if (err && Number(err.status) === 403 && err.scope) {
    const what = SCOPE_WORDS[err.scope] || `use "${err.scope}"`
    return `This phone isn’t allowed to ${what} — its pairing on the desktop doesn’t include the “${err.scope}” permission. `
      + 'Change it in the desktop app’s list of paired devices, or pair again with that permission.'
  }
  return err?.message || 'Request failed.'
}

// Kinds that justify holding a request for later.
function isRetryable(kind) {
  return kind === 'offline' || kind === 'busy'
}

// A key that lets the receiver recognise a retry of a request it already acted
// on. Random rather than derived from the request: two scans with the same
// keywords a minute apart are two scans.
function newIdempotencyKey(random = Math.random, now = Date.now) {
  let rand = ''
  for (let i = 0; i < 4; i++) rand += Math.floor(random() * 0x100000000).toString(16).padStart(8, '0')
  return `${now().toString(36)}-${rand}`
}

module.exports = { classifyError, isRetryable, newIdempotencyKey, messageFor }
