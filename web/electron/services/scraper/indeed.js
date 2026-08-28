const { chromium } = require('playwright-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromium.use(StealthPlugin())
const { randomDelay, randomUserAgent, buildResumeFile, stripMarkdown, verifySubmission, confirmSubmission, gotoResultsPage, createSelectorProbe } = require('./utils')

// Which selectors matched on the most recent scrape — see seek.js.
let lastSelectorReport = null
function getSelectorReport() { return lastSelectorReport }
const indeedSession = require('../indeedSession')
const { resolveAnswer } = require('../screeningAnswers')

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
      const pipeMatch = jobLine.match(/^(.+?)\s*[-|–]\s*(.+?)(?:,.*)?$/)
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
  const seen = new Set()
  const pages = Math.min(MAX_PAGES, Math.max(1, Number(cfg.scrapePages) || 1))
  const probe = createSelectorProbe('Indeed')
  lastSelectorReport = null

  try {
    const query = encodeURIComponent(jobKeywords)
    const location = encodeURIComponent(jobLocation || 'Australia')
    const salary = salaryMin ? `&salary=${salaryMin}` : ''
    const base = `https://au.indeed.com/jobs?q=${query}&l=${location}${salary}`

    for (let pageNum = 0; pageNum < pages; pageNum++) {
      // Indeed pages by result offset in tens, not by page number.
      const url = pageNum === 0 ? base : `${base}&start=${pageNum * 10}`
      await gotoResultsPage(page, url, 'Indeed')

      const jobCards = await page.$$('.job_seen_beacon, .resultContent, [data-testid="slider_item"]')
      probe.record('job-card', jobCards.length > 0)
      if (jobCards.length === 0) break

      let added = 0
      for (const card of jobCards) {
        try {
          const title = probe.seen('jobTitle', await card.$eval(
            'h2.jobTitle span[title], h2.jobTitle a span, h2 a span',
            el => el.textContent.trim()
          ).catch(() => ''))
          const company = probe.seen('companyName', await card.$eval(
            '[data-testid="company-name"], .companyName, [class*="companyName"]',
            el => el.textContent.trim()
          ).catch(() => ''))
          // Unprobed: most Indeed listings genuinely omit pay.
          const salary = await card.$eval(
            '[data-testid="attribute_snippet_testid"], .salaryOnly, [class*="salary"]',
            el => el.textContent.trim()
          ).catch(() => '')
          const href = probe.seen('jobLink', await card.$eval('h2.jobTitle a, h2 a', el => el.href).catch(() => ''))

          if (title && company && href && !seen.has(href)) {
            seen.add(href)
            jobs.push({ job_title: title, company, salary, job_url: href, platform: 'Indeed' })
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

  let resumePath = null
  if (tailoredResume) {
    resumePath = await buildResumeFile(tailoredResume, cfg).catch(() => null)
  }

  // Extract most recent job title + company for work history fields
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
      const coverText = stripMarkdown(coverLetter || tailoredResume || '').slice(0, 3000)
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
        // Every answer handed back is recorded on `screeningQa` so the saved
        // application shows what was actually submitted for the user.
        // Shared with seek.js and linkedin.js — see services/screeningAnswers.js
        // for why the fabrication check on an answer cannot live in three copies.
        async function getAnswer(questionText, optionHint) {
          const { answer, source } = await resolveAnswer({
            question: questionText, optionHint, cfg, log: cfg.log,
          })
          if (answer) recordAnswer(questionText, answer, source)
          return answer
        }

        // ── Radio button groups ─────────────────────────────────────────────
        const fieldsetEls = await workFrame.$$('fieldset').catch(() => [])
        for (const fieldset of fieldsetEls) {
          const radios = await fieldset.$$('input[type="radio"]').catch(() => [])
          if (radios.length === 0) continue
          const anyChecked = await fieldset.$('input[type="radio"]:checked').catch(() => null)
          if (anyChecked) continue

          const questionText = await fieldset.evaluate(el => {
            const legend = el.querySelector('legend')
            if (legend) return legend.textContent?.trim() || ''
            return el.querySelector('p, [data-automation]')?.textContent?.trim() || ''
          }).catch(() => '')
          if (!questionText || questionText.length < 3) continue
          if (/cover.?letter/i.test(questionText)) continue

          const options = []
          for (const radio of radios) {
            const label = await radio.evaluate(el => {
              const id = el.id
              if (id) {
                const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`)
                if (lbl) return lbl.textContent?.trim() || ''
              }
              return el.closest('label')?.textContent?.trim() || el.value || ''
            }).catch(() => '')
            if (label) options.push({ radio, label })
          }
          if (options.length === 0) continue

          const optionHint = options.map(o => o.label).join(' / ')
          const answer = await getAnswer(questionText, optionHint)
          if (!answer) continue

          const answerLow = answer.trim().toLowerCase()
          const matched = options.find(o =>
            o.label.toLowerCase().includes(answerLow) || answerLow.includes(o.label.toLowerCase())
          )
          if (matched) {
            await matched.radio.click().catch(() => {})
            await randomDelay(200, 400)
          }
        }

        // ── Text / select / number inputs ───────────────────────────────────
        const labels = await workFrame.$$('label').catch(() => [])
        for (const labelEl of labels) {
          const questionText = await labelEl.evaluate(el => el.textContent?.trim()).catch(() => '')
          if (!questionText || questionText.length < 3) continue
          if (/cover.?letter/i.test(questionText)) continue

          const forId = await labelEl.evaluate(el => el.getAttribute('for')).catch(() => null)
          let input = null
          if (forId) input = await workFrame.$(`#${cssEscape(forId)}`).catch(() => null)
          if (!input) {
            input = await labelEl.$('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select').catch(() => null)
          }
          if (!input) continue

          const tag = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
          const inputType = await input.evaluate(el => el.type || 'text').catch(() => 'text')
          if (!tag || inputType === 'radio' || inputType === 'checkbox') continue

          const currentVal = await input.inputValue().catch(() => '')
          if (currentVal.trim()) continue

          let optionHint = ''
          if (tag === 'select') {
            const opts = await input.evaluate(el =>
              Array.from(el.options).map(o => o.text.trim()).filter(t => t)
            ).catch(() => [])
            if (opts.length) optionHint = opts.join(' / ')
          }

          const answer = await getAnswer(questionText, optionHint)
          if (!answer) continue

          if (tag === 'select') {
            const options = await input.evaluate(el =>
              Array.from(el.options).map(o => ({ text: o.text.trim(), value: o.value }))
            ).catch(() => [])
            const ansLow = answer.toLowerCase()
            const ansNum = parseFloat(answer.replace(/[^0-9.]/g, '')) || 0

            let match = options.find(o => o.text.toLowerCase() === ansLow)
            if (!match) match = options.find(o => o.text.toLowerCase().includes(ansLow) || ansLow.includes(o.text.toLowerCase()))
            if (!match && !isNaN(ansNum)) {
              match = options.find(o => {
                const nums = o.text.match(/(\d+)/g)
                if (!nums) return false
                if (nums.length === 1) return ansNum === parseFloat(nums[0])
                if (nums.length >= 2) return ansNum >= parseFloat(nums[0]) && ansNum <= parseFloat(nums[1])
                return false
              })
            }
            if (!match && /^(no|0|none|n\/a)/i.test(answer)) {
              match = options.find(o => /^(no|0|none|never|n\/a)/i.test(o.text)) || options[1]
            }
            if (!match && /^yes/i.test(answer)) {
              match = options.find(o => /^yes/i.test(o.text))
            }

            if (match) {
              await input.selectOption({ label: match.text }).catch(async () => {
                await input.selectOption({ value: match.value }).catch(() => {})
              })
            } else {
              await input.selectOption({ label: answer }).catch(async () => {
                await input.selectOption({ value: answer }).catch(() => {})
              })
            }
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

        // Last checkpoint. The answers exist only now, so this is the earliest
        // honest preview of what the employer is about to receive.
        const approved = await confirmSubmission(cfg, {
          platform: 'Indeed', jobUrl, screeningQa,
        })
        if (!approved) {
          return { success: false, cancelledByUser: true, reason: 'Cancelled at the submission check — nothing was sent.', screeningQa }
        }

        await submitBtn.evaluate(el => el.click())
        await randomDelay(3000, 5000)
        const check = await verifySubmission(workFrame)
        if (!check.ok) return { success: false, reason: check.reason, screeningQa }
        return { success: true, screeningQa }
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

module.exports = { scrape, getJobDescription, apply, getSelectorReport }
