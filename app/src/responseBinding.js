// Binding an encrypted reply from the desktop to the request it answers.
//
// Before this, a reply was AES-GCM under a key derived from the device token
// and nothing else — the same key the phone encrypts its requests with, and no
// associated data. Anyone on the LAN could therefore hand the phone:
//   - an old reply to a different request (a stale /api/offers for a fresh
//     one, or yesterday's /api/scan "queued" for today's), or
//   - the phone's own encrypted request body, reflected back as a "reply".
// Both decrypted cleanly.
//
// Now the phone asks for a bound reply with the X-Hiro-Response-Binding header,
// and a desktop that understands it seals the reply with the request's method,
// path and nonce as GCM associated data, under a direction label requests
// never use. The envelope says so with `bound: 1`. A reply bound to anything
// else fails authentication.
//
// Downgrade: an older desktop ignores the header and replies unbound, and the
// phone has to keep working with it. So the phone accepts an unbound reply
// only until it has seen this desktop send a bound one; from then on (the fact
// is saved with the connection) an unbound reply is refused. The first bound
// reply is itself authenticated, so a man in the middle cannot fake the
// upgrade — only suppress it on a connection that has never seen one.
//
// CommonJS, no react-native imports: the desktop's test suite requires this
// file to compute the same associated data, which pins the two together.

const BINDING_HEADER = 'X-Hiro-Response-Binding'
const BINDING_VERSION = '1'
const LABEL = 'hiro-response-v1'

// The exact associated data both sides feed to AES-GCM. `path` is the request
// target as signed — path plus query string, exactly as sent.
function responseAad(method, path, nonce) {
  return [LABEL, String(method).toUpperCase(), String(path), String(nonce)].join('\n')
}

// Decide how to open a reply envelope.
//   pinned — this connection has seen a bound reply from this desktop before.
// Returns { mode: 'bound' | 'legacy' } or throws with a message worth showing.
function responseMode(envelope, { pinned = false } = {}) {
  if (envelope?.secure !== 2) {
    const err = new Error('Desktop returned an unencrypted response. Re-pair this phone to upgrade the connection.')
    err.untrusted = true
    throw err
  }
  if (envelope.bound === 1) return { mode: 'bound' }
  if (pinned) {
    const err = new Error('The desktop’s reply was not bound to this request, but this desktop has sent bound replies before. '
      + 'Something on the network may be replaying old replies — check you are on the right Wi-Fi.')
    err.untrusted = true
    throw err
  }
  return { mode: 'legacy' }
}

module.exports = { BINDING_HEADER, BINDING_VERSION, responseAad, responseMode }
