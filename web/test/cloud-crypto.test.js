const { service, createChecker } = require('./helpers')
const crypto = service('cloudCrypto'), { check, done } = createChecker()

const key = crypto.deriveKey('User@Example.com', 'correct horse battery staple')
const same = crypto.deriveKey(' user@example.com ', 'correct horse battery staple')
check('key derivation is account-stable', key, same)

const encrypted = crypto.encrypt(key, { resume: 'private text', screening: ['yes'] })
check('ciphertext hides the document', encrypted.includes('private text'), false)
check('encrypted payload round-trips', crypto.decrypt(key, encrypted), { resume: 'private text', screening: ['yes'] })
check('wrong key is rejected', (() => { try { crypto.decrypt(crypto.deriveKey('x@y.z', 'wrong'), encrypted); return false } catch { return true } })(), true)

// ─── Domain separation ───────────────────────────────────────────
// The whole point of the v3 scheme: what Supabase receives must not be enough
// to derive what decrypts the documents.

const email = 'user@example.com', password = 'correct horse battery staple'
const { dataKey, authSecret } = crypto.deriveAccountKeys(email, password)

check('deriveAccountKeys agrees with deriveKey', dataKey, crypto.deriveKey(email, password))
check('deriveAccountKeys agrees with deriveAuthSecret', authSecret, crypto.deriveAuthSecret(email, password))
check('the auth secret is not the data key', authSecret === dataKey, false)
check('the auth secret is not the password', authSecret.includes(password), false)
// The server stores the auth secret. If that value could be used as the data
// key, the split would be decorative.
check('the auth secret cannot decrypt', (() => {
  try { crypto.decrypt(Buffer.from(authSecret, 'hex').toString('base64'), encrypted); return false } catch { return true }
})(), true)
check('the auth secret is account-stable', crypto.deriveAuthSecret(' USER@example.com ', password), authSecret)
check('a different password gives a different auth secret',
  crypto.deriveAuthSecret(email, password + '!') === authSecret, false)

// ─── Envelope versioning ─────────────────────────────────────────
// v2 payloads were keyed by material the server also held, so they are retired
// rather than read. The flag is what lets a sync skip the row instead of
// aborting the entire pull.
check('current payloads are v3', JSON.parse(encrypted).v, 3)
const v2 = JSON.stringify({ v: 2, data: JSON.parse(encrypted).data })
const obsolete = (() => { try { crypto.decrypt(key, v2); return null } catch (err) { return err } })()
check('a v2 payload is refused', !!obsolete, true)
check('a refused payload is flagged as obsolete, not corrupt', obsolete.obsoleteEnvelope, true)

done()
