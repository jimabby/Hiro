const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')

const COOKIES_PATH = path.join(CONFIG_DIR, 'seek-cookies.json')

function hasCookies() {
  if (!fs.existsSync(COOKIES_PATH)) return false
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'))
    if (!cookies.length) return false
    // Check at least one non-expired session cookie exists
    const now = Date.now() / 1000
    return cookies.some(c => c.domain?.includes('seek.com.au') && (!c.expires || c.expires > now))
  } catch {
    return false
  }
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) return []
  try {
    return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'))
  } catch {
    return []
  }
}

function clearCookies() {
  if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH)
}

async function loginWithBrowser(onStatus) {
  onStatus('Opening Seek login window...')

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1024,700'],
  })

  const context = await browser.newContext({ viewport: { width: 1024, height: 700 } })
  const page = await context.newPage()
  await page.goto('https://www.seek.com.au/login', { waitUntil: 'domcontentloaded' })

  onStatus('Please log into Seek in the browser window. It will close automatically when done.')

  let loggedIn = false
  const timeout = Date.now() + 5 * 60 * 1000

  while (Date.now() < timeout) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const url = page.url()
      if (
        url.includes('seek.com.au') &&
        !url.includes('/login') &&
        !url.includes('/register') &&
        !url.includes('/oauth')
      ) {
        loggedIn = true
        break
      }
    } catch { /* page navigating */ }
  }

  if (!loggedIn) {
    await browser.close()
    return { success: false, error: 'Login timed out (5 minutes). Please try again.' }
  }

  try {
    await new Promise(r => setTimeout(r, 1500))
    const cookies = await context.cookies()
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2))
    onStatus('Seek login successful. Cookies saved.')
  } catch (err) {
    await browser.close()
    return { success: false, error: `Failed to save cookies: ${err.message}` }
  }

  await browser.close()
  return { success: true }
}

module.exports = { hasCookies, loadCookies, clearCookies, loginWithBrowser }
