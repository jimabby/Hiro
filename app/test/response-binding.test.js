// Replies bound to their request. The cryptography is AES-256-GCM with the
// request's method, path and nonce as associated data; Node's crypto stands in
// for expo-crypto here (same algorithm, same combined iv|ciphertext|tag layout),
// and the desktop's own half is exercised in web/test/secure-mobile-api.test.js.
const crypto = require('crypto')
const { createChecker } = require('./helpers')
const { responseAad, responseMode, BINDING_HEADER } = require('../src/responseBinding')
const { check, done } = createChecker()

const token = 't'.repeat(43)
const key = crypto.createHash('sha256').update(token).digest()

function seal(body, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad != null) c.setAAD(Buffer.from(aad, 'utf8'))
  const data = Buffer.concat([c.update(JSON.stringify(body)), c.final()])
  return Buffer.concat([iv, data, c.getAuthTag()]).toString('base64')
}
function open(data, aad) {
  const buf = Buffer.from(data, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  if (aad != null) d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(buf.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]).toString())
}
const opens = (data, aad) => { try { open(data, aad); return true } catch { return false } }

check('header name', BINDING_HEADER, 'X-Hiro-Response-Binding')
check('AAD format is fixed', responseAad('get', '/api/offers', 'abc'), 'hiro-response-v1\nGET\n/api/offers\nabc')

const aad = responseAad('GET', '/api/offers', 'n1')
const reply = seal({ offers: [1] }, aad)
check('a bound reply opens for its own request', open(reply, aad), { offers: [1] })
check('…not for another nonce (replayed reply)', opens(reply, responseAad('GET', '/api/offers', 'n2')), false)
check('…not for another path', opens(reply, responseAad('GET', '/api/stats', 'n1')), false)
check('…not for another method', opens(reply, responseAad('POST', '/api/offers', 'n1')), false)
check('…not without binding', opens(reply, null), false)
// The phone's own encrypted request body, reflected back as a "reply".
const request = seal({ status: 'offer' }, null)
check('a reflected request does not open as a bound reply', opens(request, aad), false)

check('bound envelope → bound mode', responseMode({ secure: 2, bound: 1, data: reply }), { mode: 'bound' })
check('unbound envelope from a desktop never seen binding → legacy', responseMode({ secure: 2, data: request }), { mode: 'legacy' })
let err = null
try { responseMode({ secure: 2, data: request }, { pinned: true }) } catch (e) { err = e }
check('unbound envelope after binding was seen → refused (downgrade)', !!err?.untrusted, true)
err = null
try { responseMode({ offers: [] }) } catch (e) { err = e }
check('cleartext 200 is refused', !!err?.untrusted, true)

done()
