const { chromium } = require('playwright')
const { randomDelay, randomUserAgent, buildResumeFile, verifySubmission, confirmSubmission, gotoResultsPage, createSelectorProbe } = require('./utils')

// Which selectors matched on the most recent scrape — see seek.js.
let lastSelectorReport = null
function getSelectorReport() { return lastSelectorReport }
const linkedinSession = require('../linkedinSession')
const aiAdapter = require('../ai/index')
const database = require('../database')

// See seek.js — one page of results goes stale within days once already-seen
// listings are skipped.
const MAX_PAGES = 10

// Node.js substitute for the browser-only CSS.escape(). A leading digit needs
// the numeric escape form; a plain backslash produces a selector querySelector
// rejects outright.
function cssEscape(str) {
  const s = String(str)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const code = s.charCodeAt(i)
    if (i === 0 && code >= 0x30 && code <= 0x39) out += '\\3' + ch + ' '
    else if (/[\w-]/.test(ch)) out += ch
    else out += '\\' + ch
  }
  return out
}

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
      const pipeMatch = jobLine.match(/^(.+?)\s*[|]\s*(.+?)(?:,.*)?$/)
      if (pipeMatch) return { title: pipeMatch[1].trim(), company: pipeMatch[2].trim() }
    }
  }
  return { title: '', company: '' }
}


async function scrape(cfg) {
  const { jobKeywords, jobLocation } = cfg
  const browser = await chromium.launch({ headless: true })

  const storagePath = linkedinSession.getStoragePath()
  const fs = require('fs')
  const contextOptions = { userAgent: randomUserAgent() }
  if (fs.existsSync(storagePath)) contextOptions.storageState = storagePath

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const jobs = []
  const seen = new Set()
  const pages = Math.min(MAX_PAGES, Math.max(1, Number(cfg.scrapePages) || 1))
  const probe = createSelectorProbe('LinkedIn')
  lastSelectorReport = null

  try {
    const query = encodeURIComponent(jobKeywords)
    const location = encodeURIComponent(jobLocation || 'Australia')
    const base = `https://www.linkedin.com/jobs/search/?keywords=${query}&location=${location}&f_AL=true`

    for (let pageNum = 0; pageNum < pages; pageNum++) {
      // LinkedIn pages by result offset in 25s.
      const url = pageNum === 0 ? base : `${base}&start=${pageNum * 25}`
      // LinkedIn is the most likely of the three to answer with an auth wall
      // rather than results — gotoResultsPage turns that into a clear error.
      await gotoResultsPage(page, url, 'LinkedIn')

      const jobCards = await page.$$('.jobs-search__results-list li, .base-card, .job-card-container')
      probe.record('job-card', jobCards.length > 0)
      if (jobCards.length === 0) break

      let added = 0
      for (const card of jobCards) {
        try {
          const title = probe.seen('cardTitle', await card.$eval(
            '.base-search-card__title, h3.base-search-card__title, .job-card-list__title, .job-card-container__link',
            el => el.textContent.trim()
          ).catch(() => ''))
          const company = probe.seen('cardSubtitle', await card.$eval(
            '.base-search-card__subtitle, h4.base-search-card__subtitle, .job-card-container__company-name',
            el => el.textContent.trim()
          ).catch(() => ''))
          // Unprobed: LinkedIn rarely publishes pay on the card at all.
          const salary = await card.$eval(
            '.job-search-card__salary-info, .job-card-container__metadata-item--salary',
            el => el.textContent.trim()
          ).catch(() => '')
          const href = probe.seen('cardLink', await card.$eval(
            'a.base-card__full-link, a[href*="/jobs/view/"], a.job-card-list__title',
            el => el.href
          ).catch(() => ''))

          if (title && company && href && !seen.has(href)) {
            seen.add(href)
            jobs.push({ job_title: title, company, salary, job_url: href, platform: 'LinkedIn' })
            added++
          }
        } catch { /* skip malformed card */ }
      }

      if (added === 0) break
      if (pageNum < pages - 1) await randomDelay(2500, 6000)
    }
  } finally {
    lastSelectorReport = probe.report()
    await browser.close()
  }

  return jobs
}

async function getJobDescription(jobUrl) {
  const browser = await chromium.launch({ headless: true })
  const storagePath = linkedinSession.getStoragePath()
  const fs = require('fs')
  const contextOptions = { userAgent: randomUserAgent() }
  if (fs.existsSync(storagePath)) contextOptions.storageState = storagePath
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(1500, 3000)
    const description = await page.$eval(
      '.description__text, .show-more-less-html__markup, .jobs-description__content',
      el => el.innerText
    ).catch(() => '')
    return description
  } finally {
    await browser.close()
  }
}

async function apply(jobUrl, tailoredResume, coverLetter, cfg) {
  if (!linkedinSession.hasCookies()) {
    return { success: false, reason: 'LinkedIn login required — go to Settings and click Login to LinkedIn' }
  }

  const browser = await chromium.launch({ headless: false, slowMo: 50 })

  const storagePath = linkedinSession.getStoragePath()
  const fs = require('fs')
  const contextOptions = { userAgent: randomUserAgent() }
  if (fs.existsSync(storagePath)) contextOptions.storageState = storagePath

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  let resumePath = null
  if (tailoredResume) {
    resumePath = await buildResumeFile(tailoredResume, cfg).catch(() => null)
  }

  const recentJob = extractRecentJob(cfg?.masterResume || tailoredResume || '')

  // Screening questions answered during this submission, so they can be stored
  // on the application. Deduped by question — a multi-step form can present the
  // same field twice, and the record should read as one answer, not two.
  const screeningQa = []
  function recordAnswer(question, answer, source) {
    const q = String(question || '').trim()
    if (!q || !answer) return
    if (screeningQa.some(e => e.question === q)) return
    screeningQa.push({ question: q, answer: String(answer), source })
  }

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(2000, 3000)

    // Verify session is active
    const isLoggedIn = await page.$('.global-nav__me, [data-control-name="identity_welcome_message"]').catch(() => null)
    if (!isLoggedIn) {
      linkedinSession.clearCookies()
      return { success: false, reason: 'LinkedIn session expired — please re-login in Settings' }
    }

    const easyApplyBtn = await page.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]').catch(() => null)
    if (!easyApplyBtn) return { success: false, reason: 'No Easy Apply button — external application required' }

    await easyApplyBtn.evaluate(el => el.click())
    await randomDelay(2000, 3000)

    await page.waitForSelector('.jobs-easy-apply-modal, [data-test-modal]', { timeout: 10000 }).catch(() => {})
    await randomDelay(1000, 1500)

    const submitSelectors = [
      'button[aria-label="Submit application"]',
      'button:has-text("Submit application")',
    ]
    const nextSelectors = [
      'button[aria-label="Continue to next step"]',
      'button[aria-label="Review your application"]',
      'button:has-text("Review")',
      'button:has-text("Next")',
    ]

    for (let step = 0; step < 10; step++) {
      await randomDelay(1500, 2500)

      // Upload tailored resume
      if (resumePath) {
        const fileInput = await page.$('.jobs-easy-apply-modal input[type="file"], input[type="file"]').catch(() => null)
        if (fileInput) {
          await fileInput.setInputFiles(resumePath).catch(() => {})
          await randomDelay(1000, 2000)
        }
      }

      // Fill recent job title (work history step)
      if (recentJob.title) {
        const titleSelectors = [
          'input[id*="jobTitle" i]', 'input[name*="jobTitle" i]',
          'input[aria-label*="title" i]', 'input[placeholder*="title" i]',
        ]
        for (const sel of titleSelectors) {
          const el = await page.$(`.jobs-easy-apply-modal ${sel}, ${sel}`).catch(() => null)
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

      // Fill recent company (work history step)
      if (recentJob.company) {
        const companySelectors = [
          'input[id*="company" i]', 'input[name*="company" i]',
          'input[aria-label*="company" i]', 'input[placeholder*="company" i]',
        ]
        for (const sel of companySelectors) {
          const el = await page.$(`.jobs-easy-apply-modal ${sel}, ${sel}`).catch(() => null)
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

      // Fill cover letter (instant paste)
      const coverText = (coverLetter || tailoredResume || '').slice(0, 3000)
      const coverSelectors = [
        'textarea[id*="cover" i]', 'textarea[name*="cover" i]',
        'textarea[aria-label*="cover letter" i]', 'textarea[placeholder*="cover letter" i]',
        '.jobs-easy-apply-modal textarea',
      ]
      for (const sel of coverSelectors) {
        const field = await page.$(sel).catch(() => null)
        if (field) {
          await field.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) })
          await field.fill(coverText)
          await field.dispatchEvent('input')
          await field.dispatchEvent('change')
          await randomDelay(300, 500)
          break
        }
      }

      // Dynamically detect and answer screening questions
      if (cfg.aiProvider && cfg.aiApiKey) {
        const labels = await page.$$('.jobs-easy-apply-modal label, label').catch(() => [])
        for (const labelEl of labels) {
          const questionText = await labelEl.evaluate(el => el.textContent?.trim()).catch(() => '')
          if (!questionText || questionText.length < 3) continue
          if (/cover.?letter/i.test(questionText)) continue

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

          const currentVal = await input.inputValue().catch(() => '')
          if (currentVal.trim()) continue

          let answer = ''
          let answerSource = ''
          const cached = database.getCachedAnswer(questionText)
          if (cached) {
            answer = cached
            answerSource = 'cache'
          } else {
            let aiAnswer = ''
            try {
              aiAnswer = await aiAdapter.answerScreeningQuestion(
                cfg.aiProvider, cfg.aiApiKey,
                questionText, cfg.jobDescription || '', cfg.masterResume || '', cfg.geminiModel
              )
            } catch {}

            const isUncertain = !aiAnswer || aiAnswer.trim().length < 3 ||
              /not sure|i don't know|unclear|unsure|cannot determine|not enough information/i.test(aiAnswer)

            if (isUncertain && cfg.askQuestion) {
              const userAnswer = await cfg.askQuestion(questionText).catch(() => '')
              if (userAnswer) { answer = userAnswer; answerSource = 'user'; database.saveCachedAnswer(questionText, userAnswer) }
            } else if (aiAnswer) {
              answer = aiAnswer
              answerSource = 'ai'
              database.saveCachedAnswer(questionText, aiAnswer)
            }
          }

          if (!answer) continue
          // Recorded so the saved application shows what was submitted for the
          // user, rather than leaving the detail panel's Q&A section empty.
          recordAnswer(questionText, answer, answerSource)

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
        submitBtn = await page.$(sel).catch(() => null)
        if (submitBtn) break
      }
      if (submitBtn) {
        await submitBtn.scrollIntoViewIfNeeded().catch(() => {})
        await randomDelay(1000, 2000)

        // Last checkpoint. The answers exist only now, so this is the earliest
        // honest preview of what the employer is about to receive.
        const approved = await confirmSubmission(cfg, {
          platform: 'LinkedIn', jobUrl, screeningQa,
        })
        if (!approved) {
          return { success: false, cancelledByUser: true, reason: 'Cancelled at the submission check — nothing was sent.', screeningQa }
        }

        await submitBtn.evaluate(el => el.click())
        await randomDelay(3000, 5000)
        const check = await verifySubmission(page)
        if (!check.ok) return { success: false, reason: check.reason, screeningQa }
        return { success: true, screeningQa }
      }

      // Click next/continue
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

module.exports = { scrape, getJobDescription, apply, getSelectorReport }
