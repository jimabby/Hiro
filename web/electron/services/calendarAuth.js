// OAuth for Google Calendar and Microsoft Graph.
//
// Authorization Code with PKCE against a loopback redirect — the flow both
// providers document for native apps, and the only one that does not require
// Hiro to hold a confidential secret. There is no Hiro server in the path: the
// browser redirects to a short-lived HTTP listener on 127.0.0.1 that exists only
// for the seconds the user spends on the consent screen.
//
// The user registers their OWN OAuth client and pastes the id in. That is more
// setup than a "Sign in with Google" button, and it is the honest option for a
// desktop app: a client secret shipped inside a downloadable binary is not a
// secret, and a shared client id would put every Hiro user's calendar access
// behind one revocable credential controlled by someone else.

const http = require('http')
const crypto = require('crypto')
const configService = require('./config')
const logger = require('./logger')

const PROVIDERS = {
  google: {
    label: 'Google Calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      // Read/write events. Deliberately not the full `calendar` scope, which
      // would also allow creating and deleting whole calendars.
      'https://www.googleapis.com/auth/calendar.events',
      // Needed only to show the user a list of their calendars to pick from.
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ],
    // Google issues a refresh token only when both of these are present, and
    // only on a consent screen the user has actually been shown.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    // Google's "Desktop app" clients are issued a secret that it requires on the
    // token exchange even though PKCE makes it non-confidential.
    needsSecret: true,
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  outlook: {
    label: 'Outlook Calendar',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'Calendars.ReadWrite', 'User.Read'],
    extraAuthParams: {},
    // Microsoft public clients must NOT send a secret; doing so makes the
    // request fail as a misconfigured confidential client.
    needsSecret: false,
    consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
}

// Access tokens live for an hour and are not worth persisting — the refresh
// token is the durable credential, and it is stored encrypted by config.js.
let cached = null // { provider, token, expiresAt }

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makePkce() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function providerFor(name) {
  const p = PROVIDERS[name]
  if (!p) throw new Error(`Unknown calendar provider: ${name}`)
  return p
}

function describeProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    needsSecret: p.needsSecret,
    consoleUrl: p.consoleUrl,
    scopes: p.scopes,
  }))
}

// The consent page redirects here. A fixed port would collide with whatever else
// the machine is running, so the port is assigned by the OS and the redirect URI
// is built from it — which is why the OAuth client must be registered with
// "http://127.0.0.1" as an allowed loopback redirect (both providers match
// loopback redirects ignoring the port, precisely for this).
function resultPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + '<body style="font-family:system-ui;background:#0f1117;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">'
    + `<div style="text-align:center"><h1 style="font-size:20px">${title}</h1>`
    + `<p style="color:#9aa0b4">${message}</p></div>`
}

// Resolves once the listener is up, because the redirect URI cannot be built —
// and therefore the consent URL cannot be opened — until the port is known.
async function startCallbackListener(expectedState, timeoutMs = 5 * 60 * 1000) {
  let settle = null
  const code = new Promise((resolve, reject) => { settle = { resolve, reject } })

  let done = false
  const finish = (fn, arg) => {
    if (done) return
    done = true
    clearTimeout(timer)
    // Close after the response has been written, so the browser gets its page.
    server.close(() => fn(arg))
  }

  const server = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') } catch { res.writeHead(400).end(); return }
    if (url.pathname !== '/callback') { res.writeHead(404).end('Not found'); return }

    const html = { 'Content-Type': 'text/html' }
    const error = url.searchParams.get('error')
    if (error) {
      res.writeHead(200, html).end(resultPage('Calendar not connected', `The provider reported: ${error}. You can close this tab.`))
      finish(settle.reject, new Error(`Authorization was refused: ${error}`))
      return
    }
    // A mismatched state means this redirect did not come from the request Hiro
    // started — the check CSRF protection exists for.
    if (!url.searchParams.get('code') || url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, html).end(resultPage('Calendar not connected', 'The response did not match the request. Please try again.'))
      finish(settle.reject, new Error('The authorization response did not match the request that started it.'))
      return
    }
    res.writeHead(200, html).end(resultPage('Calendar connected', 'You can close this tab and go back to Hiro.'))
    finish(settle.resolve, url.searchParams.get('code'))
  })

  const timer = setTimeout(
    () => finish(settle.reject, new Error('Timed out waiting for the browser. Nothing was connected.')),
    timeoutMs
  )
  server.on('error', (err) => finish(settle.reject, err))

  // Loopback only: the listener must never be reachable from the network.
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  // Nothing awaits `code` until the browser has been opened; without this the
  // timeout rejection would be an unhandled rejection in between.
  code.catch(() => {})
  return { port, code, cancel: () => finish(settle.reject, new Error('Cancelled.')) }
}

async function exchange(provider, params) {
  const p = providerFor(provider)
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Both providers put the useful part in error_description; the bare `error`
    // is usually just "invalid_grant", which explains nothing.
    throw new Error(body.error_description || body.error || `Token endpoint returned HTTP ${res.status}`)
  }
  return body
}

// Open the consent screen and wait for the redirect. Returns once a refresh
// token has been stored, or throws with a message the UI can show verbatim.
async function connect({ provider, clientId, clientSecret }) {
  const p = providerFor(provider)
  const id = String(clientId || '').trim()
  if (!id) throw new Error('Paste the OAuth client ID first.')
  const secret = String(clientSecret || '').trim()
  if (p.needsSecret && !secret) {
    throw new Error(`${p.label} desktop clients are issued a client secret — paste it as well.`)
  }

  const { verifier, challenge } = makePkce()
  const state = base64url(crypto.randomBytes(16))

  const listener = await startCallbackListener(state)
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`

  const authUrl = new URL(p.authUrl)
  authUrl.search = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: p.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...p.extraAuthParams,
  }).toString()

  let code
  try {
    const { shell } = require('electron')
    await shell.openExternal(authUrl.href)
    code = await listener.code
  } catch (err) {
    listener.cancel()
    throw err
  }

  const tokens = await exchange(provider, {
    client_id: id,
    ...(p.needsSecret ? { client_secret: secret } : {}),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })

  if (!tokens.refresh_token) {
    // Without one, sync works until the access token expires in an hour and then
    // silently stops — better to fail now and say why.
    throw new Error(
      'The provider did not return a refresh token, so Hiro could not stay connected. '
      + 'Remove Hiro from your account\'s third-party app list and connect again so the consent screen is shown in full.'
    )
  }

  configService.update({
    calendarProvider: provider,
    calendarClientId: id,
    calendarClientSecret: p.needsSecret ? secret : '',
    calendarRefreshToken: tokens.refresh_token,
    calendarSyncEnabled: true,
    // A new grant invalidates any incremental cursor from the previous one.
    calendarSyncCursor: '',
  })
  cached = {
    provider,
    token: tokens.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(tokens.expires_in) || 3600) - 60) * 1000,
  }
  logger.append(`Calendar: connected to ${p.label}.`)
  return { success: true, provider, label: p.label }
}

async function getAccessToken() {
  const cfg = configService.load()
  const provider = cfg.calendarProvider
  if (!provider || !cfg.calendarRefreshToken) return null
  if (cached && cached.provider === provider && cached.expiresAt > Date.now()) return cached.token

  const p = providerFor(provider)
  const tokens = await exchange(provider, {
    client_id: cfg.calendarClientId,
    ...(p.needsSecret ? { client_secret: cfg.calendarClientSecret } : {}),
    refresh_token: cfg.calendarRefreshToken,
    grant_type: 'refresh_token',
    ...(provider === 'outlook' ? { scope: p.scopes.join(' ') } : {}),
  })
  // Microsoft rotates refresh tokens on every use; dropping the new one means
  // the next refresh fails with invalid_grant and the user has to reconnect.
  if (tokens.refresh_token && tokens.refresh_token !== cfg.calendarRefreshToken) {
    configService.update({ calendarRefreshToken: tokens.refresh_token })
  }
  cached = {
    provider,
    token: tokens.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(tokens.expires_in) || 3600) - 60) * 1000,
  }
  return cached.token
}

function disconnect() {
  cached = null
  configService.update({
    calendarProvider: '',
    calendarClientId: '',
    calendarClientSecret: '',
    calendarRefreshToken: '',
    calendarSyncEnabled: false,
    calendarSyncCursor: '',
    calendarId: '',
    lastCalendarSyncAt: null,
  })
  logger.append('Calendar: disconnected.')
  return { success: true }
}

function isConnected() {
  const cfg = configService.load()
  return !!(cfg.calendarProvider && cfg.calendarRefreshToken)
}

module.exports = { connect, disconnect, getAccessToken, isConnected, describeProviders, PROVIDERS }
