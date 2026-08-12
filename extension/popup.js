const $ = id => document.getElementById(id)
let connection = null

function message(text, kind = '') { $('message').textContent = text; $('message').className = kind }
async function securePost(path, body) {
  const raw = JSON.stringify(await HiroProtocol.encrypt(connection.token, body))
  const signed = await HiroProtocol.signedHeaders(connection.token, 'POST', path, raw)
  const res = await fetch(`http://${connection.host}:${connection.port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...signed }, body: raw,
  })
  const payload = await HiroProtocol.decrypt(connection.token, await res.json())
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

async function showImporter(conn) {
  connection = conn; $('pairing').hidden = true; $('importer').hidden = false
  await fillCurrentJob()
}

$('pair').addEventListener('click', async () => {
  $('pair').disabled = true; message('Pairing…')
  try {
    const host = await requestDesktopPermission($('host').value), port = Number($('port').value) || 4823
    const res = await fetch(`http://${host}:${port}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value.trim(), deviceName: 'Browser extension', platform: 'extension' }) })
    const body = await res.json(); if (!res.ok) throw new Error(body.error || `Pairing failed (${res.status})`)
    const conn = { host, port, token: body.token }
    await chrome.storage.session.set({ hiroConnection: conn })
    await showImporter(conn); message('Paired for this browser session.', 'success')
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
    if (hiroConnection) await showImporter(hiroConnection)
  } catch (err) { message(err.message, 'error') }
})()
