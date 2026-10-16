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
  // The desktop address the user typed, as a URL host. Parsed with URL rather
  // than split on ':' — splitting turned "fd00::5" into "fd00" and asked for
  // permission to reach a host that does not exist. A bare IPv6 address is
  // bracketed first, which is the form URL (and a host permission) needs.
  function parseDesktopAddress(input) {
    let text = String(input || '').trim()
    if (!text) throw new Error('Enter the desktop address.')
    if (!/^https?:\/\//i.test(text)) {
      if (!text.startsWith('[') && (text.match(/:/g) || []).length >= 2) text = `[${text}]`
      text = `http://${text}`
    }
    let url
    try { url = new URL(text) } catch { throw new Error('That is not a valid desktop address.') }
    if (url.protocol !== 'http:' || !url.hostname) throw new Error('That is not a valid desktop address.')
    return { host: url.hostname, port: url.port ? Number(url.port) : null, origin: `http://${url.hostname}/*` }
  }

  // Every request to the desktop gives up after a while. A desktop that is
  // asleep, or an address that silently drops packets, otherwise left the popup
  // on "Importing…" until the browser's own minutes-long timeout.
  const REQUEST_TIMEOUT_MS = 10000
  async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch) {
    try {
      return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error('The desktop did not answer. Check it is on, Hiro is running and the mobile server is enabled.')
      }
      throw err
    }
  }

  const protocol = { encrypt, decrypt, signedHeaders, parseDesktopAddress, fetchWithTimeout, REQUEST_TIMEOUT_MS }
  root.HiroProtocol = protocol
  if (typeof module !== 'undefined') module.exports = protocol
})(globalThis)
