// "Sign in with OpenRouter" — the one way to let a user bring their own AI
// account rather than paste a key.
//
// Claude and ChatGPT subscriptions cannot be used by third-party apps (Anthropic
// forbids it; OpenAI's "Sign in with ChatGPT" is invite-only), but OpenRouter
// offers an OAuth PKCE flow that ends with an API key billed to the user's own
// OpenRouter account — and that one key reaches Claude, GPT, Gemini and the
// rest. See https://openrouter.ai/docs (OAuth PKCE).
//
// Flow: a loopback listener on a free port, the browser sent to
// openrouter.ai/auth with a PKCE challenge and a state, the redirect caught on
// /callback, and the code exchanged for a key. Same shape as calendarAuth.js.

const crypto = require('crypto')
const http = require('http')
const configService = require('./config')
const logger = require('./logger')
const { providerKeys } = require('./ai/configured')

const AUTH_URL = 'https://openrouter.ai/auth'
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'
const TIMEOUT_MS = 5 * 60 * 1000
const EXCHANGE_TIMEOUT_MS = 20000

const base64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function makePkce() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function resultPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + '<body style="font-family:system-ui;background:#0f1117;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">'
    + `<div style="text-align:center"><h1 style="font-size:20px">${title}</h1>`
    + `<p style="color:#9aa0b4">${message}</p></div>`
}

let active = null // the sign-in in progress, so a second click cancels the first

// Listens on BOTH loopback addresses: OpenRouter requires a "localhost"
// callback, and a browser may resolve that to ::1 before 127.0.0.1. Never on a
// network interface.
async function startListener(expectedState, timeoutMs) {
  let settle
  const code = new Promise((resolve, reject) => { settle = { resolve, reject } })
  code.catch(() => {})
  const servers = []
  let done = false
  const finish = (fn, arg) => {
    if (done) return
    done = true
    clearTimeout(timer)
    let open = servers.length
    if (!open) return fn(arg)
    for (const s of servers) s.close(() => { if (--open === 0) fn(arg) })
  }

  const handler = (req, res) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { res.writeHead(400).end(); return }
    if (url.pathname !== '/callback') { res.writeHead(404).end('Not found'); return }
    const html = { 'Content-Type': 'text/html' }
    // Checked first and only refused: anything on this machine can reach the
    // port, and must not be able to cancel a sign-in halfway through.
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, html).end(resultPage('Not signed in', 'The response did not match the request. Please try again from Hiro.'))
      return
    }
    const c = url.searchParams.get('code')
    if (!c) {
      res.writeHead(400, html).end(resultPage('Not signed in', 'OpenRouter sent no authorization code. Please try again.'))
      finish(settle.reject, new Error('OpenRouter sent no authorization code.'))
      return
    }
    res.writeHead(200, html).end(resultPage('Signed in to OpenRouter', 'You can close this tab and go back to Hiro.'))
    finish(settle.resolve, c)
  }

  const timer = setTimeout(() => finish(settle.reject, new Error('Timed out waiting for the browser. Nothing was changed.')), timeoutMs)

  const first = http.createServer(handler)
  const port = await new Promise((resolve, reject) => {
    first.once('error', reject)
    first.listen(0, '127.0.0.1', () => resolve(first.address().port))
  })
  servers.push(first)
  first.on('error', err => finish(settle.reject, err))
  // Best effort: a machine without IPv6 loopback just uses the IPv4 one.
  await new Promise((resolve) => {
    const second = http.createServer(handler)
    second.once('error', () => resolve())
    second.listen(port, '::1', () => { servers.push(second); resolve() })
  })

  return { port, code, cancel: () => finish(settle.reject, new Error('Cancelled.')) }
}

async function exchange(code, verifier, { fetchImpl = fetch, timeoutMs = EXCHANGE_TIMEOUT_MS } = {}) {
  let res
  try {
    res = await fetchImpl(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('OpenRouter did not answer. Try again.')
    throw err
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.key) {
    const detail = body?.error?.message || body?.message || `HTTP ${res.status}`
    throw new Error(`OpenRouter did not issue a key: ${detail}`)
  }
  return body.key
}

// Stores the key as the OpenRouter key and makes OpenRouter the active
// provider — the user pressed the button with OpenRouter selected.
function storeKey(key) {
  const cfg = configService.load()
  const keys = { ...providerKeys(cfg), openrouter: key }
  configService.update({ aiApiKeys: keys, aiProvider: 'openrouter', aiApiKey: key })
}

async function signIn({ openExternal, timeoutMs = TIMEOUT_MS, fetchImpl } = {}) {
  if (active) active.cancel()
  const { verifier, challenge } = makePkce()
  const state = base64url(crypto.randomBytes(16))
  const listener = await startListener(state, timeoutMs)
  active = listener
  const authUrl = new URL(AUTH_URL)
  authUrl.search = new URLSearchParams({
    callback_url: `http://localhost:${listener.port}/callback`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    key_label: 'Hiro',
  }).toString()

  try {
    const open = openExternal || (url => require('electron').shell.openExternal(url))
    await open(authUrl.href)
    const code = await listener.code
    const key = await exchange(code, verifier, { fetchImpl })
    storeKey(key)
    logger.append('AI: signed in to OpenRouter; OpenRouter is now the AI provider.')
    return { success: true }
  } catch (err) {
    listener.cancel()
    return { success: false, error: err.message }
  } finally {
    if (active === listener) active = null
  }
}

function cancel() {
  if (active) active.cancel()
}

module.exports = { signIn, cancel, exchange, makePkce, AUTH_URL, EXCHANGE_URL }
