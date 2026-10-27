const $ = id => document.getElementById(id)
let connection = null

// Where the pairing lives. Session storage by default — closing the browser
// forgets it — and local storage only when the user ticked "Remember pairing on
// this device", because each re-pair mints a new device token and a browser that
// restarts daily otherwise piles up a token a day on the desktop.
const STORAGE_KEY = 'hiroConnection'
const storageFor = remember => remember ? chrome.storage.local : chrome.storage.session

async function loadConnection() {
  const { [STORAGE_KEY]: session } = await chrome.storage.session.get(STORAGE_KEY)
  if (session) return session
  const { [STORAGE_KEY]: remembered } = await chrome.storage.local.get(STORAGE_KEY)
  return remembered || null
}

async function saveConnection(conn) {
  // Never in both: unticking the box must not leave a copy on disk.
  await storageFor(!conn.remember).remove(STORAGE_KEY)
  await storageFor(conn.remember).set({ [STORAGE_KEY]: conn })
}

async function clearConnection() {
  await chrome.storage.session.remove(STORAGE_KEY)
  await chrome.storage.local.remove(STORAGE_KEY)
}

function message(text, kind = '') { $('message').textContent = text; $('message').className = kind }

function baseUrl(conn) { return `http://${conn.host}:${conn.port}` }

async function securePost(path, body) {
  const raw = JSON.stringify(await HiroProtocol.encrypt(connection.token, body))
  const signed = await HiroProtocol.signedHeaders(connection.token, 'POST', path, raw)
  const res = await HiroProtocol.fetchWithTimeout(`${baseUrl(connection)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signed, [HiroProtocol.BINDING_HEADER]: HiroProtocol.BINDING_VERSION },
    body: raw,
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
  // The reply must answer THIS request — see openReply in protocol.js. Once a
  // bound reply has been seen, the pairing remembers it, so a later unbound
  // one (a reflected request, a replayed reply) is refused.
  const { payload, bound } = await HiroProtocol.openReply(connection.token, envelope, {
    method: 'POST', path, nonce: signed['X-Hiro-Nonce'], pinned: !!connection.responseBinding,
  })
  if (bound && !connection.responseBinding) {
    connection = { ...connection, responseBinding: true }
    await saveConnection(connection).catch(() => {})
  }
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

  // Pay, from schema.org baseSalary. It comes in several shapes:
  //   { "@type": "MonetaryAmount", currency, value: 120000 }
  //   { "@type": "MonetaryAmount", currency, value: { "@type": "QuantitativeValue",
  //       minValue, maxValue, unitText: "YEAR" } }
  //   a bare number or string, or an array of any of these (the first is used).
  // It is written out as the text the desktop's salary parser already reads —
  // "AUD $120,000 – $150,000 per year" — so the desktop derives the annual
  // min/max itself, including for hourly and daily rates.
  // Self-contained, like the rest of this function: it runs inside the page
  // (chrome.scripting.executeScript), where nothing from popup.js exists.
  function salaryText(raw) {
    const amount = Array.isArray(raw) ? raw[0] : raw
    if (amount == null || amount === '') return ''
    if (typeof amount !== 'object') return clean(amount).slice(0, 120)
    const currency = clean(amount.currency || amount.value?.currency).toUpperCase().slice(0, 3)
    const value = amount.value ?? amount
    const num = v => {
      const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.]/g, ''))
      return Number.isFinite(n) && n > 0 ? n : null
    }
    let min, max
    if (value && typeof value === 'object') {
      min = num(value.minValue); max = num(value.maxValue)
      if (min == null && max == null) min = max = num(value.value)
    } else {
      min = max = num(value)
    }
    if (min == null && max == null) return ''
    const symbol = { USD: '$', AUD: '$', CAD: '$', NZD: '$', SGD: '$', HKD: '$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹' }[currency] || ''
    const fmt = n => `${symbol}${Math.round(n).toLocaleString('en-US')}`
    const range = min != null && max != null && min !== max ? `${fmt(min)} – ${fmt(max)}` : fmt(min ?? max)
    const unit = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' }[clean(value?.unitText || amount.unitText).toUpperCase()]
    return [currency, range, unit ? `per ${unit}` : ''].filter(Boolean).join(' ').slice(0, 120)
  }

  // Closing date, from validThrough — kept as the YYYY-MM-DD the listing
  // states (the employer's own date), not converted through this browser's
  // time zone, which could move a deadline by a day.
  function closingDate(raw) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(raw))
    return m ? m[1] : ''
  }

  return {
    title: title.slice(0, 200), company: company.slice(0, 200), description, url: location.href,
    salary: salaryText(jsonLd.baseSalary || jsonLd.estimatedSalary), closingDate: closingDate(jsonLd.validThrough),
  }
}

// The import form's inputs, by id — also the keys extractJob returns and the
// field names the desktop's importJob reads.
const FORM_FIELDS = ['title', 'company', 'salary', 'closingDate', 'description', 'url']

async function fillCurrentJob() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a web job listing first.')
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJob })
  for (const key of FORM_FIELDS) $(key).value = result[key] || ''
}

// Ask for access to exactly the desktop's address. Parsed with URL, so an IPv6
// address ("fd00::5", "[fd00::5]:4823") is requested as itself rather than cut
// off at its first colon.
async function requestDesktopPermission(input) {
  const address = HiroProtocol.parseDesktopAddress(input)
  const granted = await chrome.permissions.request({ origins: [address.origin] })
  if (!granted) throw new Error('Hiro needs permission to reach that desktop address.')
  return address
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
    const address = await requestDesktopPermission($('host').value)
    const host = address.host, port = Number($('port').value) || address.port || 4823
    const code = $('code').value.trim()
    const remember = !!$('remember').checked
    const base = `http://${host}:${port}`

    const helloRes = await HiroProtocol.fetchWithTimeout(`${base}/api/pair/hello`)
    const hello = await helloRes.json()
    if (!helloRes.ok) throw new Error(hello.error || `Pairing failed (${helloRes.status})`)

    // Throws when the tag does not verify — a mistyped code, or something on the
    // network answering in the desktop's place.
    const channel = await HiroPairChannel.openChannel(hello, code)
    const sealed = await HiroPairChannel.sealRequest(channel, {
      code, deviceName: 'Browser extension', platform: 'extension',
    })

    const res = await HiroProtocol.fetchWithTimeout(`${base}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealed),
    })
    const body = await res.json(); if (!res.ok) throw new Error(body.error || `Pairing failed (${res.status})`)
    const paired = await HiroPairChannel.openResponse(channel, body)
    const conn = { host, port, token: paired.token, remember, expiresAt: paired.device?.expiresAt || null }
    await saveConnection(conn)
    await showImporter(conn)
    // Pairing succeeded whatever the current tab happens to be. If the fill
    // could not run, say what to do next rather than reporting the pairing as
    // failed — the two outcomes used to be indistinguishable.
    const done = remember ? 'Paired. This browser will stay paired until you forget it.' : 'Paired for this browser session.'
    const fillProblem = await tryFillCurrentJob()
    message(fillProblem ? `${done} ${fillProblem}` : done, fillProblem ? '' : 'success')
  } catch (err) { message(err.message, 'error') } finally { $('pair').disabled = false }
})

$('import').addEventListener('click', async () => {
  $('import').disabled = true; message('Importing…')
  try {
    await securePost('/api/import-job', Object.fromEntries(FORM_FIELDS.map(key => [key, $(key).value])))
    message('Added to Needs Attention.', 'success')
  } catch (err) { message(err.message, 'error') } finally { $('import').disabled = false }
})

// Forgetting revokes the token on the desktop first. It used to delete only the
// local copy, which left a valid 90-day token behind for every pairing ever
// forgotten. If the desktop cannot be reached the local copy is still dropped —
// the user asked for that — and they are told the desktop still lists it.
$('forget').addEventListener('click', async () => {
  $('forget').disabled = true; message('Forgetting…')
  let revoked = false
  let problem = ''
  try {
    if (connection) {
      const result = await securePost('/api/devices/self/revoke', {})
      revoked = !!result?.success
    }
  } catch (err) { problem = err.message }
  await clearConnection(); connection = null
  $('importer').hidden = true; $('pairing').hidden = false; $('forget').disabled = false
  message(revoked
    ? 'Pairing forgotten and revoked on the desktop.'
    : `Pairing forgotten here, but the desktop could not be told${problem ? ` (${problem})` : ''}. Revoke "Browser extension" in Hiro → Settings → Mobile App.`,
  revoked ? 'success' : '')
})

;(async () => {
  try {
    const saved = await loadConnection()
    if (!saved) return
    await showImporter(saved)
    const fillProblem = await tryFillCurrentJob()
    if (fillProblem) message(fillProblem)
  } catch (err) { message(err.message, 'error') }
})()
