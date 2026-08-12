(function expose(root) {
  const encoder = new TextEncoder()
  function bytesToBase64(bytes) {
    let out = ''
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(out)
  }
  function base64ToBytes(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)) }
  function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('') }
  async function key(token, purpose) {
    if (purpose === 'HMAC') {
      return crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    }
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  async function encrypt(token, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(token, 'AES-GCM'), encoder.encode(JSON.stringify(value))))
    const combined = new Uint8Array(iv.length + encrypted.length)
    combined.set(iv); combined.set(encrypted, iv.length)
    return { secure: 2, data: bytesToBase64(combined) }
  }
  async function decrypt(token, envelope) {
    if (envelope?.secure !== 2) throw new Error('Desktop returned an unencrypted response. Re-pair the extension.')
    const combined = base64ToBytes(envelope.data), iv = combined.slice(0, 12), data = combined.slice(12)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(token, 'AES-GCM'), data)
    return JSON.parse(new TextDecoder().decode(plain))
  }
  async function signedHeaders(token, method, path, rawBody) {
    const timestamp = String(Date.now()), nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
    const input = [method, path, timestamp, nonce, rawBody].join('\n')
    const signature = hex(await crypto.subtle.sign('HMAC', await key(token, 'HMAC'), encoder.encode(input)))
    return { 'X-Hiro-Timestamp': timestamp, 'X-Hiro-Nonce': nonce, 'X-Hiro-Signature': signature }
  }
  const protocol = { encrypt, decrypt, signedHeaders }
  root.HiroProtocol = protocol
  if (typeof module !== 'undefined') module.exports = protocol
})(globalThis)
