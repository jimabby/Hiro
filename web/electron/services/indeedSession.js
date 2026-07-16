const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromium.use(StealthPlugin())
const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')
const { randomUserAgent } = require('./scraper/utils')

const STORAGE_PATH = path.join(CONFIG_DIR, 'indeed-storage.json')

function hasSession() {
  if (!fs.existsSync(STORAGE_PATH)) return false
  try {
    const s = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'))
    const cookies = s.cookies || []
    const now = Date.now() / 1000
    return cookies.some(c => c.domain?.includes('indeed.com') && (!c.expires || c.expires < 0 || c.expires > now))
  } catch { return false }
}

function hasCookies() { return hasSession() }
function getStoragePath() { return STORAGE_PATH }
function clearCookies() {
  if (fs.existsSync(STORAGE_PATH)) fs.unlinkSync(STORAGE_PATH)
}

async function loginWithBrowser(onStatus) {
  onStatus('Opening Indeed login window...')
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--window-size=1024,700', '--disable-blink-features=AutomationControlled'],
  })
  // try/finally so the headed Chrome always closes — a throw from
  // newContext/goto (offline, Chrome channel missing) must not leak it.
  try {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 700 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    await page.goto('https://au.indeed.com', { waitUntil: 'domcontentloaded' })

    onStatus('Please click Sign in (top right) and log in. The window will close automatically.')

    // Phase 1: wait for user to navigate to the login page
    let signInStarted = false
    const phase1End = Date.now() + 5 * 60 * 1000
    while (Date.now() < phase1End && !signInStarted) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const url = page.url()
        if (url.includes('secure.indeed.com') || url.includes('/account/login') || url.includes('/auth')) {
          signInStarted = true
          onStatus('Sign-in detected — waiting for you to complete login...')
        }
      } catch {}
    }

    if (!signInStarted) {
      return { success: false, error: 'No sign-in attempt detected. Please click Sign in on the Indeed page.' }
    }

    // Phase 2: wait for redirect back to indeed.com main pages
    let loggedIn = false
    const phase2End = Date.now() + 3 * 60 * 1000
    while (Date.now() < phase2End && !loggedIn) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const url = page.url()
        if (
          url.includes('indeed.com') &&
          !url.includes('secure.indeed.com') &&
          !url.includes('/account/login') &&
          !url.includes('/auth')
        ) {
          loggedIn = true
        }
      } catch {}
    }

    if (!loggedIn) {
      return { success: false, error: 'Login timed out. Please try again.' }
    }

    // Let cookies settle
    await new Promise(r => setTimeout(r, 3000))

    try {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
      await context.storageState({ path: STORAGE_PATH })
      onStatus('Indeed login successful. Session saved.')
    } catch (err) {
      return { success: false, error: `Failed to save session: ${err.message}` }
    }

    return { success: true }
  } finally {
    await browser.close().catch(() => {})
  }
}

module.exports = { hasCookies, hasSession, getStoragePath, clearCookies, loginWithBrowser }
