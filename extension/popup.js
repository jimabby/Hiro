const $ = id => document.getElementById(id)
let connection = null

function message(text, kind = '') { $('message').textContent = text; $('message').className = kind }
async function securePost(path, body) {
  const raw = JSON.stringify(await HiroProtocol.encrypt(connection.token, body))
  const signed = await HiroProtocol.signedHeaders(connection.token, 'POST', path, raw)
  const res = await fetch(`http://${connection.host}:${connection.port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...signed }, body: raw,
  })
  const envelope = await res.json()
  // Anything the desktop refuses before verifying the signature (403 non-local
  // peer, 429 lockout, 401 expired token) has to be unencrypted — it has no key
  // to answer with. Read those in the clear instead of failing the envelope
  // check, which reported every one of them as "re-pair the extension".
  if (!res.ok && envelope?.secure !== 2) {
    throw new Error(envelope?.error || (res.status === 401
      ? 'The desktop no longer accepts this extension — pair it again.'
      : `Desktop returned ${res.status}`))
  }
  const payload = await HiroProtocol.decrypt(connection.token, envelope)
  if (!res.ok) throw new Error(payload.error || payload.reason || `Desktop returned ${res.status}`)
  return payload
}

function extractJob() {
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(node => {
    try { const value = JSON.parse(node.textContent); return Array.isArray(value) ? value : [value] } catch { return [] }
  }).flatMap(value => value?.['@graph'] || [value]).find(value => value?.['@type'] === 'JobPosting') || {}
  const meta = (...names) => names.map(name => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content).find(Boolean) || ''
  const clean = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const title = clean(jsonLd.title || meta('og:title', 'twitter:title') || document.querySelector('h1')?.textContent || document.title)
  const company = clean(jsonLd.hiringOrganization?.name || meta('og:site_name') || '')
  const root = document.querySelector('[class*="description" i],[id*="description" i],main,article')
  const description = clean(jsonLd.description || meta('description', 'og:description') || root?.innerText).slice(0, 50000)
  return { title: title.slice(0, 200), company: company.slice(0, 200), description, url: location.href }
}

async function fillCurrentJob() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a web job listing first.')
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJob })
  for (const key of ['title', 'company', 'description', 'url']) $(key).value = result[key] || ''
}

async function requestDesktopPermission(host) {
  const hostname = String(host).trim().replace(/^https?:\/\//, '').split(/[/:]/)[0]
  if (!hostname) throw new Error('Enter the desktop address.')
  const granted = await chrome.permissions.request({ origins: [`http://${hostname}/*`] })
  if (!granted) throw new Error('Hiro needs permission to reach that desktop address.')
  return hostname
}

// Show the import form and, separately, try to fill it from the current tab.
//
// These are two things and used to be one. fillCurrentJob() throws when the
// active tab is not a web page ("Open a web job listing first."), and because
// the pair handler awaited this whole function inside its try, a successful
// pairing done from a blank tab or the extensions page reported itself as a red
// error and never printed "Paired". The token was stored and the form was up:
// nothing had gone wrong except the message.
//
// So the fill is best-effort and reports itself, and pairing reports on pairing.
async function showImporter(conn) {
  connection = conn
  $('pairing').hidden = true
  $('importer').hidden = false
}

// Returns the message to show if the fill could not happen, or null on success.
async function tryFillCurrentJob() {
  try {
    await fillCurrentJob()
    return null
  } catch (err) {
    return err.message
  }
}

// Two round trips, because the reply carries a long-lived device token over
// plain HTTP: the first fetches the desktop's ephemeral public key (authenticated
// by an HMAC only the holder of the pairing code can check), the second sends the
// code and receives the token, both encrypted under the agreed key. See
// pairChannel.js.
$('pair').addEventListener('click', async () => {
  $('pair').disabled = true; message('Pairing…')
  try {
    const host = await requestDesktopPermission($('host').value), port = Number($('port').value) || 4823
    const code = $('code').value.trim()
    const base = `http://${host}:${port}`

    const helloRes = await fetch(`${base}/api/pair/hello`)
    const hello = await helloRes.json()
    if (!helloRes.ok) throw new Error(hello.error || `Pairing failed (${helloRes.status})`)

    // Throws when the tag does not verify — a mistyped code, or something on the
    // network answering in the desktop's place.
    const channel = await HiroPairChannel.openChannel(hello, code)
    const sealed = await HiroPairChannel.sealRequest(channel, {
      code, deviceName: 'Browser extension', platform: 'extension',
    })

    const res = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealed),
    })
    const body = await res.json(); if (!res.ok) throw new Error(body.error || `Pairing failed (${res.status})`)
    const paired = await HiroPairChannel.openResponse(channel, body)
    const conn = { host, port, token: paired.token }
    await chrome.storage.session.set({ hiroConnection: conn })
    await showImporter(conn)
    // Pairing succeeded whatever the current tab happens to be. If the fill
    // could not run, say what to do next rather than reporting the pairing as
    // failed — the two outcomes used to be indistinguishable.
    const fillProblem = await tryFillCurrentJob()
    message(
      fillProblem ? `Paired for this browser session. ${fillProblem}` : 'Paired for this browser session.',
      fillProblem ? '' : 'success',
    )
  } catch (err) { message(err.message, 'error') } finally { $('pair').disabled = false }
})

$('import').addEventListener('click', async () => {
  $('import').disabled = true; message('Importing…')
  try {
    await securePost('/api/import-job', { title: $('title').value, company: $('company').value, description: $('description').value, url: $('url').value })
    message('Added to Needs Attention.', 'success')
  } catch (err) { message(err.message, 'error') } finally { $('import').disabled = false }
})

$('forget').addEventListener('click', async () => {
  await chrome.storage.session.remove('hiroConnection'); connection = null
  $('importer').hidden = true; $('pairing').hidden = false; message('Pairing forgotten.')
})

;(async () => {
  try {
    const { hiroConnection } = await chrome.storage.session.get('hiroConnection')
    if (!hiroConnection) return
    await showImporter(hiroConnection)
    const fillProblem = await tryFillCurrentJob()
    if (fillProblem) message(fillProblem)
  } catch (err) { message(err.message, 'error') }
})()
