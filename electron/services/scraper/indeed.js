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
    const salary = salaryMin ? `&salary=${salaryMin}` : ''
    const url = `https://au.indeed.com/jobs?q=${query}&l=${location}${salary}`

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 4000)

    const jobCards = await page.$$('.job_seen_beacon, .resultContent')

    for (const card of jobCards.slice(0, 20)) {
      try {
        const title = await card.$eval('h2.jobTitle span[title], h2.jobTitle a', el => el.textContent.trim()).catch(() => '')
        const company = await card.$eval('[data-testid="company-name"], .companyName', el => el.textContent.trim()).catch(() => '')
        const salary = await card.$eval('[data-testid="attribute_snippet_testid"], .salaryOnly', el => el.textContent.trim()).catch(() => '')
        const href = await card.$eval('h2.jobTitle a', el => el.href).catch(() => '')

        if (title && company && href) {
          jobs.push({ job_title: title, company, salary, job_url: href, platform: 'Indeed' })
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
  const context = await browser.newContext({ userAgent: randomUserAgent() })
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(1500, 3000)
    const description = await page.$eval('#jobDescriptionText', el => el.innerText).catch(() => '')
    return description
  } finally {
    await browser.close()
  }
}

async function apply(jobUrl, tailoredResume, screeningAnswers, cfg) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: randomUserAgent() })
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 3000)

    const applyBtn = await page.$('#indeedApplyButton, [id*="applyButton"], a[href*="apply"]')
    if (!applyBtn) return { success: false, reason: 'No apply button found' }

    await applyBtn.click()
    await randomDelay(2000, 4000)

    const currentUrl = page.url()
    if (!currentUrl.includes('indeed.com')) {
      return { success: false, reason: 'Redirected to external application site' }
    }

    // Handle multi-step Indeed application
    let maxSteps = 8
    while (maxSteps-- > 0) {
      await randomDelay(1000, 2000)

      // Fill text areas (cover letter, additional info)
      const textareas = await page.$$('textarea:visible')
      for (const ta of textareas) {
        const val = await ta.inputValue()
        if (!val) {
          await humanType(page, ta, tailoredResume.slice(0, 2000))
          await randomDelay(300, 600)
        }
      }

      // Answer screening questions
      for (const qa of screeningAnswers) {
        const labels = await page.$$('label')
        for (const label of labels) {
          const labelText = await label.textContent()
          if (labelText && qa.question && labelText.toLowerCase().includes(qa.question.slice(0, 20).toLowerCase())) {
            const forAttr = await label.getAttribute('for')
            if (forAttr) {
              const input = await page.$(`#${forAttr}`)
              if (input) {
                const tag = await input.evaluate(el => el.tagName.toLowerCase())
                if (tag === 'select') {
                  await input.selectOption({ label: qa.answer }).catch(() => {})
                } else {
                  await input.fill(qa.answer).catch(() => {})
                }
                await randomDelay(200, 500)
              }
            }
          }
        }
      }

      // Try to go next or submit
      const nextBtn = await page.$('button[data-testid="continue-button"], button:has-text("Continue"), button:has-text("Next")')
      const submitBtn = await page.$('button[data-testid="submit-application-button"], button:has-text("Submit")')

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

    return { success: false, reason: 'Could not complete application flow' }
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    await browser.close()
  }
}

module.exports = { scrape, getJobDescription, apply }
