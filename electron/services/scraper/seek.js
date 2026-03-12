const { chromium } = require('playwright')
const { randomDelay, humanType, randomUserAgent } = require('./utils')

async function scrape(cfg) {
  const { jobKeywords, jobLocation, salaryMin } = cfg
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: randomUserAgent() })
  const page = await context.newPage()

  const jobs = []

  try {
    const query = encodeURIComponent(jobKeywords)
    const location = encodeURIComponent(jobLocation || 'Australia')
    const url = `https://www.seek.com.au/${query}-jobs/in-${location}?salaryrange=${salaryMin || 0}-999999&salarytype=annual`

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 4000)

    const jobCards = await page.$$('[data-testid="job-card"]')

    for (const card of jobCards.slice(0, 20)) {
      try {
        const title = await card.$eval('[data-automation="jobTitle"]', el => el.textContent.trim()).catch(() => '')
        const company = await card.$eval('[data-automation="jobCompany"]', el => el.textContent.trim()).catch(() => '')
        const salary = await card.$eval('[data-automation="jobSalary"]', el => el.textContent.trim()).catch(() => '')
        const href = await card.$eval('a[data-automation="jobTitle"]', el => el.href).catch(() => '')

        if (title && company && href) {
          jobs.push({ job_title: title, company, salary, job_url: href, platform: 'Seek' })
        }
      } catch { /* skip malformed card */ }
    }
  } finally {
    await browser.close()
  }

  return jobs
}

async function getJobDescription(jobUrl) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: randomUserAgent() })
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(1500, 3000)
    const description = await page.$eval('[data-automation="jobAdDetails"]', el => el.innerText).catch(() => '')
    return description
  } finally {
    await browser.close()
  }
}

async function apply(jobUrl, tailoredResume, screeningAnswers, cfg) {
  // Seek's easy apply flow varies by employer — this handles the common case
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: randomUserAgent() })
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 4000)

    // Look for Quick Apply button
    const quickApply = await page.$('[data-automation="job-detail-apply"]')
    if (!quickApply) return { success: false, reason: 'No apply button found' }

    await quickApply.click()
    await randomDelay(2000, 3000)

    // Check if redirected to external site
    const currentUrl = page.url()
    if (!currentUrl.includes('seek.com.au')) {
      return { success: false, reason: 'Redirected to external application site' }
    }

    // Fill in cover letter / resume text if field exists
    const coverField = await page.$('textarea[name="coverLetter"], textarea[placeholder*="cover"], textarea[placeholder*="Cover"]')
    if (coverField) {
      await coverField.click()
      await humanType(page, coverField, tailoredResume.slice(0, 3000))
      await randomDelay(500, 1000)
    }

    // Answer screening questions
    for (const qa of screeningAnswers) {
      const label = await page.$(`label:has-text("${qa.question.slice(0, 30)}")`).catch(() => null)
      if (label) {
        const input = await label.$('input, textarea, select').catch(() => null)
        if (input) {
          const tag = await input.evaluate(el => el.tagName.toLowerCase())
          if (tag === 'select') {
            await input.selectOption({ label: qa.answer }).catch(() => {})
          } else {
            await humanType(page, input, qa.answer)
          }
          await randomDelay(300, 700)
        }
      }
    }

    // Submit
    const submitBtn = await page.$('[data-automation="submit-application"], button[type="submit"]')
    if (submitBtn) {
      await randomDelay(1000, 2000)
      await submitBtn.click()
      await randomDelay(2000, 4000)
      return { success: true }
    }

    return { success: false, reason: 'Submit button not found' }
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    await browser.close()
  }
}

module.exports = { scrape, getJobDescription, apply }
