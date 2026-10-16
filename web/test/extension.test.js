const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createChecker } = require('./helpers')

const root = path.join(__dirname, '..', '..', 'extension')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8')
const protocolSource = fs.readFileSync(path.join(root, 'protocol.js'), 'utf8')
const protocol = require(path.join(root, 'protocol.js'))
const pairSource = fs.readFileSync(path.join(root, 'pairChannel.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8')
const { check, done } = createChecker()

check('extension uses Manifest V3', manifest.manifest_version, 3)
check('desktop access is optional rather than installed globally', manifest.optional_host_permissions, ['http://*/*'])
check('extension does not request all browsing data', JSON.stringify(manifest).includes('<all_urls>'), false)
// Session storage by default; local storage only when the user opts in, so a
// browser that restarts daily does not mint a new device token every day.
check('pairing secret uses session storage by default', popup.includes('chrome.storage.session'), true)
check('remembering the pairing is an explicit opt-in', html.includes('id="remember"') && /storageFor\(conn\.remember\)/.test(popup), true)
check('the remember box is unticked by default', /id="remember"[^>]*checked/.test(html), false)
check('forgetting clears both storage areas',
  /chrome\.storage\.session\.remove\(STORAGE_KEY\)/.test(popup) && /chrome\.storage\.local\.remove\(STORAGE_KEY\)/.test(popup), true)
// "Forget" used to delete only the local copy and leave a valid token behind.
check('forgetting revokes the token on the desktop', popup.includes("securePost('/api/devices/self/revoke'"), true)
check('every desktop request has a timeout', /await fetch\(/.test(popup), false)
check('the desktop address is parsed, not split on colons', /split\(\/\[\/:\]\/\)/.test(popup), false)
check('imports use signed requests', protocolSource.includes('X-Hiro-Signature'), true)
check('imports use encrypted envelopes', protocolSource.includes('secure: 2'), true)
check('popup has no inline script blocked by MV3 CSP', /<script(?![^>]*src=)/i.test(html), false)
check('extension scripts parse', (() => { try { new Function(protocolSource); new Function(popup); new Function(pairSource); return true } catch { return false } })(), true)

// Pairing is the one exchange that hands over a long-lived credential, and it
// speaks plain HTTP. It must not do that in the clear.
check('the pairing channel ships with the extension', fs.existsSync(path.join(root, 'pairChannel.js')), true)
check('the popup loads it', html.includes('pairChannel.js'), true)
check('pairing agrees a key rather than sending the code', popup.includes('/api/pair/hello'), true)
check('the pairing request is encrypted', popup.includes('HiroPairChannel.sealRequest'), true)
check('the token is read out of an encrypted reply', popup.includes('HiroPairChannel.openResponse'), true)
check('no cleartext pairing body remains', /body: JSON\.stringify\(\{ code:/.test(popup), false)

;(async () => {
  const token = 'a'.repeat(64), value = { title: 'Engineer', description: 'Private text' }
  const envelope = await protocol.encrypt(token, value)
  check('extension encryption round-trips with Web Crypto', await protocol.decrypt(token, envelope), value)
  const combined = Buffer.from(envelope.data, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(token).digest(), combined.subarray(0, 12))
  decipher.setAuthTag(combined.subarray(-16))
  const desktopPlain = JSON.parse(Buffer.concat([decipher.update(combined.subarray(12, -16)), decipher.final()]).toString())
  check('extension ciphertext matches the desktop wire format', desktopPlain, value)
  const headers = await protocol.signedHeaders(token, 'POST', '/api/import-job', JSON.stringify(envelope))
  check('extension produces a SHA-256 HMAC signature', /^[0-9a-f]{64}$/.test(headers['X-Hiro-Signature']), true)
  const input = ['POST', '/api/import-job', headers['X-Hiro-Timestamp'], headers['X-Hiro-Nonce'], JSON.stringify(envelope)].join('\n')
  check('extension signature matches the desktop protocol', headers['X-Hiro-Signature'], crypto.createHmac('sha256', token).update(input).digest('hex'))

  // ── Address parsing ─────────────────────────────────────────────
  // Splitting on ':' turned an IPv6 address into its first group.
  const parse = protocol.parseDesktopAddress
  check('an IPv4 address parses', parse('192.168.1.10'), { host: '192.168.1.10', port: null, origin: 'http://192.168.1.10/*' })
  check('a port typed into the address is kept', parse('192.168.1.10:4900').port, 4900)
  check('a scheme is tolerated', parse('http://desk.local/').host, 'desk.local')
  check('a bare IPv6 address is bracketed', parse('fd00::5'), { host: '[fd00::5]', port: null, origin: 'http://[fd00::5]/*' })
  check('a bracketed IPv6 address with a port parses', parse('[fe80::1]:4823'), { host: '[fe80::1]', port: 4823, origin: 'http://[fe80::1]/*' })
  let parseError = null
  try { parse('') } catch (err) { parseError = err.message }
  check('an empty address is refused', /desktop address/.test(parseError || ''), true)
  parseError = null
  try { parse('https://desk.local') } catch (err) { parseError = err.message }
  check('only plain http is accepted', /valid desktop address/.test(parseError || ''), true)

  // ── Request timeout ─────────────────────────────────────────────
  let seenSignal = null
  await protocol.fetchWithTimeout('http://x/', {}, 50, async (_url, opts) => { seenSignal = opts.signal; return { ok: true } })
  check('a request carries an abort signal', !!seenSignal, true)
  let timeoutError = null
  // AbortSignal.timeout's timer does not hold Node's event loop open.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await protocol.fetchWithTimeout('http://x/', {}, 20, (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
    }))
  } catch (err) { timeoutError = err.message }
  clearTimeout(keepAlive)
  check('a desktop that never answers times out with an explanation', /did not answer/.test(timeoutError || ''), true)
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
