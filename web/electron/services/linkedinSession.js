const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')

const STORAGE_PATH = path.join(CONFIG_DIR, 'linkedin-storage.json')
// Legacy cookies path — kept for backward-compat check
const COOKIES_PATH = path.join(CONFIG_DIR, 'linkedin-cookies.json')

function hasSession() {
  if (fs.existsSync(STORAGE_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'))
      const cookies = s.cookies || []
      const now = Date.now() / 1000
      const liAt = cookies.find(c => c.name === 'li_at' && c.domain?.includes('linkedin.com'))
      if (liAt && (!liAt.expires || liAt.expires < 0 || liAt.expires > now)) return true
    } catch {}
  }
  // Fall back to legacy cookies file
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'))
      const liAt = cookies.find(c => c.name === 'li_at')
      if (liAt && (!liAt.expires || liAt.expires > Date.now() / 1000)) return true
    } catch {}
  }
  return false
}

function hasCookies() { return hasSession() }

function getStoragePath() { return STORAGE_PATH }

// loadCookies kept for any legacy callers
function loadCookies() {
  if (fs.existsSync(STORAGE_PATH)) return [] // storageState used instead
  if (!fs.existsSync(COOKIES_PATH)) return []
  try { return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8')) } catch { return [] }
}

function clearCookies() {
  if (fs.existsSync(STORAGE_PATH)) fs.unlinkSync(STORAGE_PATH)
  if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH)
}

async function loginWithBrowser(onStatus) {
  onStatus('Opening LinkedIn login window...')

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',  // Use real Chrome to avoid Google OAuth "insecure browser" block
    args: ['--window-size=1024,700', '--disable-blink-features=AutomationControlled'],
  })

  // Everything below runs inside try/finally: if newContext/goto throws (or
  // any other path exits early), the headed Chrome must still be closed —
  // otherwise every failed login leaks a browser process.
  try {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 700 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })

    const page = await context.newPage()
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' })

    onStatus('Please log into LinkedIn in the browser window. The window will close automatically when done.')

    // Wait until user reaches a logged-in page
    let loggedIn = false
    const timeout = Date.now() + 5 * 60 * 1000

    while (Date.now() < timeout) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        const url = page.url()
        if (
          url.includes('linkedin.com/feed') ||
          url.includes('linkedin.com/in/') ||
          url.includes('linkedin.com/mynetwork') ||
          url.includes('linkedin.com/jobs')
        ) {
          loggedIn = true
          break
        }
      } catch {}
    }

    if (!loggedIn) {
      return { success: false, error: 'Login timed out (5 minutes). Please try again.' }
    }

    // Let session cookies fully settle
    await new Promise(r => setTimeout(r, 2000))

    try {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
      await context.storageState({ path: STORAGE_PATH })
      onStatus('LinkedIn login successful. Session saved.')
    } catch (err) {
      return { success: false, error: `Failed to save session: ${err.message}` }
    }

    return { success: true }
  } finally {
    await browser.close().catch(() => {})
  }
}

module.exports = { hasCookies, hasSession, loadCookies, getStoragePath, clearCookies, loginWithBrowser }
