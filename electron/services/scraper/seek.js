const { chromium } = require('playwright')
const { randomDelay, humanType, randomUserAgent } = require('./utils')

// Node.js substitute for the browser-only CSS.escape()
function cssEscape(str) {
  return str.replace(/([^\w-])/g, '\\$1')
}

function stripMarkdown(text) {
  return (text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\*\s+/gm, '- ')
    .replace(/^-{3,}\s*$/gm, '')
    .trim()
}
const seekSession = require('../seekSession')
const aiAdapter = require('../ai/index')
const database = require('../database')

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

async function buildResumePath(tailoredResume, candidateName) {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx')
  const safeName = (candidateName || 'Resume').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
  const fileName = `Resume - ${safeName}.docx`
  const tempPath = path.join(os.tmpdir(), fileName)
  const cleanText = stripMarkdown(tailoredResume)
  const lines = cleanText.split('\n')
  const paragraphs = []
  let firstLineDone = false
  for (const line of lines) {
    if (!firstLineDone && !line.trim()) continue
    if (!firstLineDone) {
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: line.trim(), bold: true, size: 32 })],
      }))
      firstLineDone = true
    } else if (line.trim() && /^[A-Z][A-Z\s\/&-]{2,}$/.test(line.trim())) {
      paragraphs.push(new Paragraph({
        spacing: { before: 200, after: 60 },
        children: [new TextRun({ text: line.trim(), bold: true, size: 22 })],
      }))
    } else {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line, size: 22 })],
      }))
    }
  }
  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buffer = await Packer.toBuffer(doc)
  fs.writeFileSync(tempPath, buffer)
  return tempPath
}

async function apply(jobUrl, tailoredResume, coverLetter, cfg) {
  // Run headed so the user can watch if debugging is needed
  const browser = await chromium.launch({ headless: false, slowMo: 50 })

  // Restore full Seek session (all cookies + localStorage) from saved storage state
  const storagePath = seekSession.getStoragePath()
  const fs = require('fs')
  const contextOptions = { userAgent: randomUserAgent() }
  if (fs.existsSync(storagePath)) contextOptions.storageState = storagePath

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  // Extract candidate name from master resume first line for a clean filename
  const candidateName = (cfg?.masterResume || tailoredResume || '')
    .split('\n').find(l => l.trim())?.trim() || 'Resume'

  // Pre-build resume docx for upload
  let resumePath = null
  if (tailoredResume) {
    resumePath = await buildResumePath(tailoredResume, candidateName).catch(() => null)
  }

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 4000)

    // Look for Quick Apply button — try multiple selectors as Seek's DOM changes
    const applySelectors = [
      '[data-automation="job-detail-apply"]',
      '[data-automation="apply-button"]',
      'a[data-automation="job-detail-apply"]',
      'button:has-text("Quick apply")',
      'a:has-text("Quick apply")',
      'button:has-text("Apply")',
    ]
    let quickApply = null
    for (const sel of applySelectors) {
      quickApply = await page.$(sel).catch(() => null)
      if (quickApply) break
    }
    if (!quickApply) return { success: false, reason: 'No apply button found' }

    // Dismiss any overlays that might intercept clicks (cookie banners, dropdowns)
    await page.keyboard.press('Escape').catch(() => {})
    await randomDelay(300, 500)
    await quickApply.evaluate(el => el.click())
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await randomDelay(2000, 3000)

    // Check destination URL
    const currentUrl = page.url()
    if (!currentUrl.includes('seek.com.au')) {
      return { success: false, reason: 'Redirected to external application site' }
    }
    if (currentUrl.includes('/login') || currentUrl.includes('/oauth') || currentUrl.includes('/sign-in') || currentUrl.includes('id.seek.com')) {
      return { success: false, reason: 'Seek session expired — please re-login in Settings → Seek Session' }
    }

    // Wait for the application form to appear
    await page.waitForSelector('form, [role="dialog"], [data-automation="apply-form"]', { timeout: 10000 }).catch(() => {})

    // Double-check we're not on a login page after the form wait
    if (page.url().includes('/login') || page.url().includes('/oauth')) {
      return { success: false, reason: 'Seek session expired — please re-login in Settings → Seek Session' }
    }
    await randomDelay(1500, 2000)

    const submitSelectors = [
      '[data-automation="submit-application"]',
      '[data-automation="submit-action"]',
      'button:has-text("Submit application")',
      'button:has-text("Send application")',
    ]
    const nextSelectors = [
      'button:has-text("Review and apply")',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Review")',
      '[data-automation="continue-button"]',
      '[data-automation="next-button"]',
    ]

    // Navigate through multi-step form up to 8 steps
    for (let step = 0; step < 8; step++) {
      await randomDelay(1500, 2500)

      // Upload tailored resume if there's a file input on this step
      if (resumePath) {
        const fileInput = await page.$('input[type="file"]').catch(() => null)
        if (fileInput) {
          await fileInput.setInputFiles(resumePath).catch(() => {})
          await randomDelay(500, 1000)
        }
      }

      // Fill cover letter field — always overwrite any pre-filled content
      const coverFieldSelectors = [
        '[data-automation="coverLetterField"]',
        '[data-automation="cover-letter-field"]',
        '[data-automation="cover-letter"] textarea',
        'textarea[name="coverLetter"]',
        'textarea[name="cover_letter"]',
        'textarea[placeholder*="cover"]',
        'textarea[placeholder*="Cover"]',
        'textarea[aria-label*="cover"]',
        'textarea[aria-label*="Cover"]',
      ]
      const coverText = (coverLetter || tailoredResume).slice(0, 3000)
      let coverFilled = false
      for (const sel of coverFieldSelectors) {
        const field = await page.$(sel).catch(() => null)
        if (field) {
          await field.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) })
          await field.fill(coverText)
          await field.dispatchEvent('input')
          await field.dispatchEvent('change')
          await randomDelay(300, 500)
          coverFilled = true
          break
        }
      }
      // Also try contenteditable rich text editor (Seek sometimes uses these)
      if (!coverFilled) {
        const richText = await page.$('[contenteditable="true"]').catch(() => null)
        if (richText) {
          await richText.evaluate((el, text) => {
            el.textContent = text
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }, coverText)
          await randomDelay(300, 500)
        }
      }

      // Dynamically detect and answer screening questions on this step
      if (cfg.aiProvider && cfg.aiApiKey) {
        const labels = await page.$$('label').catch(() => [])
        for (const labelEl of labels) {
          const questionText = await labelEl.evaluate(el => el.textContent?.trim()).catch(() => '')
          if (!questionText || questionText.length < 3) continue
          // Skip cover letter labels (handled above)
          if (/cover.?letter/i.test(questionText)) continue

          // Find the associated input/textarea/select
          const forId = await labelEl.evaluate(el => el.getAttribute('for')).catch(() => null)
          let input = null
          if (forId) {
            input = await page.$(`#${cssEscape(forId)}`).catch(() => null)
          }
          if (!input) {
            input = await labelEl.$('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select').catch(() => null)
          }
          if (!input) continue

          const tag = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
          if (!tag) continue

          // Skip already filled fields
          const currentVal = await input.inputValue().catch(() => '')
          if (currentVal.trim()) continue

          let answer = ''

          // 1. Check cache first — use saved answer immediately
          const cached = database.getCachedAnswer(questionText)
          if (cached) {
            answer = cached
          } else {
            // 2. Ask AI
            let aiAnswer = ''
            try {
              aiAnswer = await aiAdapter.answerScreeningQuestion(
                cfg.aiProvider, cfg.aiApiKey,
                questionText,
                cfg.jobDescription || '',
                cfg.masterResume || '',
                cfg.geminiModel
              )
            } catch {}

            const isUncertain = !aiAnswer || aiAnswer.trim().length < 3 ||
              /i'm not sure|i don't know|unclear|unsure|cannot determine|not enough information/i.test(aiAnswer)

            if (isUncertain && cfg.askQuestion) {
              // 3. AI unsure — pause and ask the user
              const userAnswer = await cfg.askQuestion(questionText).catch(() => '')
              if (userAnswer) {
                answer = userAnswer
                database.saveCachedAnswer(questionText, userAnswer)
              }
            } else if (aiAnswer) {
              answer = aiAnswer
              database.saveCachedAnswer(questionText, aiAnswer)
            }
          }

          if (!answer) continue

          if (tag === 'select') {
            await input.selectOption({ label: answer }).catch(() => {})
          } else {
            await input.click()
            await humanType(page, input, answer)
          }
          await randomDelay(300, 700)
        }
      }

      // Check for final submit button
      let submitBtn = null
      for (const sel of submitSelectors) {
        submitBtn = await page.$(sel).catch(() => null)
        if (submitBtn) break
      }
      if (submitBtn) {
        await submitBtn.scrollIntoViewIfNeeded().catch(() => {})
        await randomDelay(1000, 2000)
        await submitBtn.evaluate(el => el.click())
        await randomDelay(2000, 4000)
        return { success: true }
      }

      // Look for Next/Continue button to advance the wizard
      let nextBtn = null
      for (const sel of nextSelectors) {
        nextBtn = await page.$(sel).catch(() => null)
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
