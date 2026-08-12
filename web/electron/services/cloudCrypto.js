const crypto = require('crypto')
function deriveKey(email, password) { return crypto.pbkdf2Sync(password, `hiro-cloud:${String(email).trim().toLowerCase()}`, 120000, 32, 'sha256').toString('base64') }
function encrypt(key64, value) {
  if (!key64) return null
  const key = Buffer.from(key64, 'base64'), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return JSON.stringify({ v: 2, data: Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64') })
}
function decrypt(key64, payload) {
  if (!key64 || !payload) return null
  const env = typeof payload === 'string' ? JSON.parse(payload) : payload, key = Buffer.from(key64, 'base64')
  if (env.v !== 2) throw new Error('Cloud data uses an obsolete encryption format.')
  const combined = Buffer.from(env.data, 'base64'), iv = combined.subarray(0, 12), tag = combined.subarray(-16), data = combined.subarray(12, -16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
}
module.exports = { deriveKey, encrypt, decrypt }
