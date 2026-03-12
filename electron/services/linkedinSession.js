const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./config')

const COOKIES_PATH = path.join(CONFIG_DIR, 'linkedin-cookies.json')

function hasCookies() {
  if (!fs.existsSync(COOKIES_PATH)) return false
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'))
    // Check li_at cookie (LinkedIn session token) hasn't expired
    const liAt = cookies.find(c => c.name === 'li_at')
    if (!liAt) return false
    if (liAt.expires && liAt.expires < Date.now() / 1000) return false
    return true
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

// Opens a visible browser for the user to log into LinkedIn, saves cookies when done
async function loginWithBrowser(onStatus) {
  onStatus('Opening LinkedIn login window...')

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1024,700'],
  })

  const context = await browser.newContext({
    viewport: { width: 1024, height: 700 },
  })

  const page = await context.newPage()
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' })

  onStatus('Please log into LinkedIn in the browser window. The window will close automatically when done.')

  // Poll until user reaches the feed / home page (logged in)
  let loggedIn = false
  const timeout = Date.now() + 5 * 60 * 1000 // 5 min timeout

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
    } catch {
      // page may have navigated
    }
  }

  if (!loggedIn) {
    await browser.close()
    return { success: false, error: 'Login timed out (5 minutes). Please try again.' }
  }

  // Save cookies
  try {
    await new Promise(r => setTimeout(r, 1500)) // wait for session to settle
    const cookies = await context.cookies()
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2))
    onStatus('LinkedIn login successful. Cookies saved.')
  } catch (err) {
    await browser.close()
    return { success: false, error: `Failed to save cookies: ${err.message}` }
  }

  await browser.close()
  return { success: true }
}

module.exports = { hasCookies, loadCookies, clearCookies, loginWithBrowser }
