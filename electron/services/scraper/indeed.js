const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromium.use(StealthPlugin())
const { randomDelay, randomUserAgent, buildResumePDF } = require('./utils')
const indeedSession = require('../indeedSession')
const aiAdapter = require('../ai/index')
const database = require('../database')

function cssEscape(str) {
  return str.replace(/([^\w-])/g, '\\$1')
}

// Extract the most recent job title + company from resume text
// Looks for a job line whose next non-empty line is a date range containing "present"
function extractRecentJob(resumeText) {
  const clean = (resumeText || '').replace(/\*\*/g, '').replace(/^\*\s+/gm, '')
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean)

  for (let i = 0; i < lines.length - 1; i++) {
    const nextLine = lines[i + 1] || ''
    if (/\bpresent\b|\bcurrent\b/i.test(nextLine) && /\b\d{4}\b/.test(nextLine)) {
      const jobLine = lines[i]
      const atMatch = jobLine.match(/^(.+?)\s+at\s+(.+?)(?:,.*)?$/)
      if (atMatch) return { title: atMatch[1].trim(), company: atMatch[2].trim() }
      const commaMatch = jobLine.match(/^(.+?),\s+(.+?)(?:,.*)?$/)
      if (commaMatch) return { title: commaMatch[1].trim(), company: commaMatch[2].trim() }
      const pipeMatch = jobLine.match(/^(.+?)\s*[|–\-]\s*(.+?)(?:,.*)?$/)
      if (pipeMatch) return { title: pipeMatch[1].trim(), company: pipeMatch[2].trim() }
    }
  }
  return { title: '', company: '' }
}


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

    const jobCards = await page.$$('.job_seen_beacon, .resultContent, [data-testid="slider_item"]')

    for (const card of jobCards.slice(0, 20)) {
      try {
        const title = await card.$eval(
          'h2.jobTitle span[title], h2.jobTitle a span, h2 a span',
          el => el.textContent.trim()
        ).catch(() => '')
        const company = await card.$eval(
          '[data-testid="company-name"], .companyName, [class*="companyName"]',
          el => el.textContent.trim()
        ).catch(() => '')
        const salary = await card.$eval(
          '[data-testid="attribute_snippet_testid"], .salaryOnly, [class*="salary"]',
          el => el.textContent.trim()
        ).catch(() => '')
        const href = await card.$eval('h2.jobTitle a, h2 a', el => el.href).catch(() => '')

        if (title && company && href) {
          jobs.push({ job_title: title, company, salary, job_url: href, platform: 'Indeed' })
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
    const description = await page.$eval(
      '#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]',
      el => el.innerText
    ).catch(() => '')
    return description
  } finally {
    await browser.close()
  }
}

async function apply(jobUrl, tailoredResume, coverLetter, cfg) {
  const browser = await chromium.launch({ headless: false, slowMo: 50 })

  const storagePath = indeedSession.getStoragePath()
  const fs = require('fs')
  const contextOptions = { userAgent: randomUserAgent() }
  if (fs.existsSync(storagePath)) contextOptions.storageState = storagePath

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  const candidateName = (cfg?.masterResume || tailoredResume || '')
    .split('\n').find(l => l.trim())?.trim()?.replace(/\*\*/g, '') || 'Resume'

  let resumePath = null
  if (tailoredResume) {
    resumePath = await buildResumePDF(tailoredResume, candidateName).catch(() => null)
  }

  // Extract most recent job title + company for work history fields
  const recentJob = extractRecentJob(cfg?.masterResume || tailoredResume || '')

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 4000)

    // Find the Indeed Apply button
    const applySelectors = [
      '#indeedApplyButton',
      'button[id*="apply"]',
      'a[id*="apply"]',
      'button:has-text("Apply now")',
      'button:has-text("Easy Apply")',
      'a:has-text("Apply now")',
    ]
    let applyBtn = null
    for (const sel of applySelectors) {
      applyBtn = await page.$(sel).catch(() => null)
      if (applyBtn) break
    }
    if (!applyBtn) return { success: false, reason: 'No apply button found' }

    await page.keyboard.press('Escape').catch(() => {})
    await randomDelay(300, 500)
    await applyBtn.evaluate(el => el.click())
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await randomDelay(2000, 3000)

    const currentUrl = page.url()
    if (!currentUrl.includes('indeed.com')) {
      return { success: false, reason: 'Redirected to external application site' }
    }
    if (currentUrl.includes('/account/login') || currentUrl.includes('secure.indeed.com')) {
      return { success: false, reason: 'Indeed session expired — please re-login in Settings → Indeed Account' }
    }

    await page.waitForSelector('form, [role="main"], [data-testid="ia-container"]', { timeout: 10000 }).catch(() => {})
    await randomDelay(1500, 2000)

    const submitSelectors = [
      'button[data-testid="submit-application-button"]',
      'button[data-testid="IA-Submit"]',
      'button:has-text("Submit your application")',
      'button:has-text("Submit application")',
      'button:has-text("Send application")',
    ]
    const nextSelectors = [
      'button[data-testid="continue-button"]',
      'button[data-testid="ia-continue-btn"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Review your application")',
    ]

    for (let step = 0; step < 10; step++) {
      await randomDelay(1500, 2500)

      // Indeed sometimes uses iframes — work in whichever frame has the form
      const frames = page.frames()
      const workFrame = frames.find(f => f.url().includes('indeed.com') && f !== page.mainFrame()) || page

      // Upload tailored resume if file input present
      if (resumePath) {
        const fileInput = await workFrame.$('input[type="file"]').catch(() => null)
        if (fileInput) {
          await fileInput.setInputFiles(resumePath).catch(() => {})
          await randomDelay(1000, 2000)
        }
      }

      // Fill most-recent job title (work history step)
      if (recentJob.title) {
        const titleInputSelectors = [
          'input[id*="jobTitle" i]', 'input[name*="jobTitle" i]',
          'input[aria-label*="job title" i]', 'input[aria-label*="position" i]',
          'input[placeholder*="job title" i]', 'input[placeholder*="most recent" i]',
        ]
        for (const sel of titleInputSelectors) {
          const el = await workFrame.$(sel).catch(() => null)
          if (el) {
            const val = await el.inputValue().catch(() => '')
            if (!val.trim()) {
              await el.fill(recentJob.title).catch(() => {})
              await randomDelay(200, 400)
            }
            break
          }
        }
      }

      // Fill most-recent company name (work history step)
      if (recentJob.company) {
        const companyInputSelectors = [
          'input[id*="company" i]', 'input[name*="company" i]',
          'input[aria-label*="company" i]', 'input[aria-label*="employer" i]',
          'input[placeholder*="company" i]',
        ]
        for (const sel of companyInputSelectors) {
          const el = await workFrame.$(sel).catch(() => null)
          if (el) {
            const val = await el.inputValue().catch(() => '')
            if (!val.trim()) {
              await el.fill(recentJob.company).catch(() => {})
              await randomDelay(200, 400)
            }
            break
          }
        }
      }

      // Fill cover letter (instant paste, overwrite any pre-filled content)
      const coverText = (coverLetter || tailoredResume || '').slice(0, 3000)
      const coverFieldSelectors = [
        'textarea[id*="coverletter" i]', 'textarea[name*="coverletter" i]',
        'textarea[aria-label*="cover letter" i]', 'textarea[placeholder*="cover letter" i]',
        '[data-testid*="coverletter"] textarea',
      ]
      for (const sel of coverFieldSelectors) {
        const field = await workFrame.$(sel).catch(() => null)
        if (field) {
          await field.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) })
          await field.fill(coverText)
          await field.dispatchEvent('input')
          await field.dispatchEvent('change')
          await randomDelay(300, 500)
          break
        }
      }

      // Dynamically detect and answer screening questions on this step
      if (cfg.aiProvider && cfg.aiApiKey) {
        const labels = await workFrame.$$('label').catch(() => [])
        for (const labelEl of labels) {
          const questionText = await labelEl.evaluate(el => el.textContent?.trim()).catch(() => '')
          if (!questionText || questionText.length < 3) continue
          if (/cover.?letter/i.test(questionText)) continue

          const forId = await labelEl.evaluate(el => el.getAttribute('for')).catch(() => null)
          let input = null
          if (forId) {
            input = await workFrame.$(`#${cssEscape(forId)}`).catch(() => null)
          }
          if (!input) {
            input = await labelEl.$('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select').catch(() => null)
          }
          if (!input) continue

          const tag = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
          if (!tag) continue

          const currentVal = await input.inputValue().catch(() => '')
          if (currentVal.trim()) continue

          let answer = ''
          const cached = database.getCachedAnswer(questionText)
          if (cached) {
            answer = cached
          } else {
            let aiAnswer = ''
            try {
              aiAnswer = await aiAdapter.answerScreeningQuestion(
                cfg.aiProvider, cfg.aiApiKey,
                questionText, cfg.jobDescription || '', cfg.masterResume || '', cfg.geminiModel
              )
            } catch {}

            const isUncertain = !aiAnswer || aiAnswer.trim().length < 3 ||
              /i'm not sure|i don't know|unclear|unsure|cannot determine|not enough information/i.test(aiAnswer)

            if (isUncertain && cfg.askQuestion) {
              const userAnswer = await cfg.askQuestion(questionText).catch(() => '')
              if (userAnswer) { answer = userAnswer; database.saveCachedAnswer(questionText, userAnswer) }
            } else if (aiAnswer) {
              answer = aiAnswer
              database.saveCachedAnswer(questionText, aiAnswer)
            }
          }

          if (!answer) continue

          if (tag === 'select') {
            await input.selectOption({ label: answer }).catch(() => {})
          } else {
            await input.fill(answer).catch(() => {})
          }
          await randomDelay(300, 700)
        }
      }

      // Check for submit button
      let submitBtn = null
      for (const sel of submitSelectors) {
        submitBtn = await workFrame.$(sel).catch(() => null)
        if (submitBtn) break
      }
      if (submitBtn) {
        await submitBtn.scrollIntoViewIfNeeded().catch(() => {})
        await randomDelay(1000, 2000)
        await submitBtn.evaluate(el => el.click())
        await randomDelay(2000, 4000)
        return { success: true }
      }

      // Click next/continue to advance the wizard
      let nextBtn = null
      for (const sel of nextSelectors) {
        nextBtn = await workFrame.$(sel).catch(() => null)
        if (nextBtn) break
      }
      if (!nextBtn) break
      await nextBtn.scrollIntoViewIfNeeded().catch(() => {})
      await nextBtn.evaluate(el => el.click())
    }

    return { success: false, reason: 'Submit button not found' }
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    await browser.close()
  }
}

module.exports = { scrape, getJobDescription, apply }
