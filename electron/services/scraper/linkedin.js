const { chromium } = require('playwright')
const { randomDelay, humanType, randomUserAgent } = require('./utils')
const linkedinSession = require('../linkedinSession')

async function createContext(browser) {
  const context = await browser.newContext({ userAgent: randomUserAgent() })
  const cookies = linkedinSession.loadCookies()
  if (cookies.length > 0) await context.addCookies(cookies)
  return context
}

async function scrape(cfg) {
  const { jobKeywords, jobLocation } = cfg
  const browser = await chromium.launch({ headless: true })
  const context = await createContext(browser)
  const page = await context.newPage()
  const jobs = []

  try {
    const query = encodeURIComponent(jobKeywords)
    const location = encodeURIComponent(jobLocation || 'Australia')
    const url = `https://www.linkedin.com/jobs/search/?keywords=${query}&location=${location}&f_AL=true`

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 4000)

    const jobCards = await page.$$('.jobs-search__results-list li, .base-card, .job-card-container')

    for (const card of jobCards.slice(0, 20)) {
      try {
        const title = await card.$eval('.base-search-card__title, h3.base-search-card__title, .job-card-list__title, .job-card-container__link', el => el.textContent.trim()).catch(() => '')
        const company = await card.$eval('.base-search-card__subtitle, h4.base-search-card__subtitle, .job-card-container__company-name', el => el.textContent.trim()).catch(() => '')
        const salary = await card.$eval('.job-search-card__salary-info, .job-card-container__metadata-item--salary', el => el.textContent.trim()).catch(() => '')
        const href = await card.$eval('a.base-card__full-link, a[href*="/jobs/view/"], a.job-card-list__title', el => el.href).catch(() => '')

        if (title && company && href) {
          jobs.push({ job_title: title, company, salary, job_url: href, platform: 'LinkedIn' })
        }
      } catch { /* skip */ }
    }
  } finally {
    await browser.close()
  }

  return jobs
}

async function getJobDescription(jobUrl) {
  const browser = await chromium.launch({ headless: true })
  const context = await createContext(browser)
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(1500, 3000)
    const description = await page.$eval('.description__text, .show-more-less-html__markup, .jobs-description__content', el => el.innerText).catch(() => '')
    return description
  } finally {
    await browser.close()
  }
}

async function apply(jobUrl, tailoredResume, screeningAnswers, cfg) {
  if (!linkedinSession.hasCookies()) {
    return { success: false, reason: 'LinkedIn login required — go to Settings and click Login to LinkedIn' }
  }

  const browser = await chromium.launch({ headless: true })
  const context = await createContext(browser)
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 3000)

    const easyApplyBtn = await page.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]')
    if (!easyApplyBtn) return { success: false, reason: 'No Easy Apply button — external application required' }

    const isLoggedIn = await page.$('.global-nav__me, .nav__button-secondary').catch(() => null)
    if (!isLoggedIn) {
      linkedinSession.clearCookies()
      return { success: false, reason: 'LinkedIn session expired — please re-login in Settings' }
    }

    await easyApplyBtn.click()
    await randomDelay(2000, 3000)

    let maxSteps = 10
    while (maxSteps-- > 0) {
      await randomDelay(1000, 2000)

      const inputs = await page.$$('.jobs-easy-apply-modal input[type="text"]:visible, .jobs-easy-apply-modal textarea:visible')
      for (const input of inputs) {
        const val = await input.inputValue()
        if (!val) {
          const placeholder = await input.getAttribute('placeholder') || ''
          const match = screeningAnswers.find(qa => qa.question && placeholder.toLowerCase().includes(qa.question.slice(0, 15).toLowerCase()))
          if (match) await humanType(page, input, match.answer)
          await randomDelay(200, 500)
        }
      }

      const nextBtn = await page.$('button[aria-label="Continue to next step"], button:has-text("Next"), button:has-text("Review")')
      const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")')

      if (submitBtn) {
        await randomDelay(1000, 2000)
        await submitBtn.click()
        await randomDelay(2000, 3000)
        return { success: true }
      } else if (nextBtn) {
        await nextBtn.click()
      } else {
        break
      }
    }

    return { success: false, reason: 'Could not complete Easy Apply flow' }
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    await browser.close()
  }
}

module.exports = { scrape, getJobDescription, apply }
