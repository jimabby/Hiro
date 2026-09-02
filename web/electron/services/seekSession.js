const { chromium } = require('playwright')
const { launchOptions } = require('./scraper/utils')
const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')

const STORAGE_PATH = path.join(CONFIG_DIR, 'seek-storage.json')
// Legacy path — checked for backward compat
const COOKIES_PATH = path.join(CONFIG_DIR, 'seek-cookies.json')

function hasSession() {
  if (fs.existsSync(STORAGE_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'))
      const cookies = s.cookies || []
      const now = Date.now() / 1000
      return cookies.some(c => c.domain?.includes('seek.com.au') && (!c.expires || c.expires < 0 || c.expires > now))
    } catch { return false }
  }
  // Fall back to legacy cookies file
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'))
      const now = Date.now() / 1000
      return cookies.some(c => c.domain?.includes('seek.com.au') && (!c.expires || c.expires > now))
    } catch { return false }
  }
  return false
}

// Keep hasCookies as an alias so existing callers don't break
function hasCookies() { return hasSession() }

function getStoragePath() { return STORAGE_PATH }

function clearCookies() {
  if (fs.existsSync(STORAGE_PATH)) fs.unlinkSync(STORAGE_PATH)
  if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH)
}

async function loginWithBrowser(onStatus) {
  onStatus('Opening Seek login window...')

  const browser = await chromium.launch(launchOptions({
    headless: false,
    channel: 'chrome',
    args: ['--window-size=1024,700', '--disable-blink-features=AutomationControlled'],
  }))

  // try/finally so the headed Chrome always closes — a throw from
  // newContext/goto (offline, Chrome channel missing) must not leak it.
  try {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 700 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    await page.goto('https://www.seek.com.au', { waitUntil: 'domcontentloaded' })

    onStatus('Please sign in using the Sign in button (top right). The window will close automatically once logged in.')

    // Phase 1: wait for user to start the sign-in flow (navigate to auth page)
    let signInStarted = false
    const phase1End = Date.now() + 5 * 60 * 1000
    while (Date.now() < phase1End && !signInStarted) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const url = page.url()
        if (url.includes('id.seek.com') || url.includes('/login') || url.includes('/oauth') || url.includes('/sign-in')) {
          signInStarted = true
          onStatus('Sign-in detected, waiting for you to complete login...')
        }
      } catch {}
    }

    if (!signInStarted) {
      return { success: false, error: 'No sign-in attempt detected. Please click Sign in on the Seek page.' }
    }

    // Phase 2: wait for redirect back to seek.com.au (login complete)
    let loggedIn = false
    const phase2End = Date.now() + 3 * 60 * 1000
    while (Date.now() < phase2End && !loggedIn) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const url = page.url()
        if (
          url.includes('seek.com.au') &&
          !url.includes('id.seek.com') &&
          !url.includes('/login') &&
          !url.includes('/oauth')
        ) {
          loggedIn = true
        }
      } catch {}
    }

    if (!loggedIn) {
      return { success: false, error: 'Login timed out. Please try again.' }
    }

    // Wait for page to fully settle and all cookies to be written
    await new Promise(r => setTimeout(r, 4000))

    try {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
      // Save full storage state (all cookies from all domains + localStorage)
      await context.storageState({ path: STORAGE_PATH })
      onStatus('Seek login successful. Session saved.')
    } catch (err) {
      return { success: false, error: `Failed to save session: ${err.message}` }
    }

    return { success: true }
  } finally {
    await browser.close().catch(() => {})
  }
}

module.exports = { hasCookies, hasSession, getStoragePath, clearCookies, loginWithBrowser }
