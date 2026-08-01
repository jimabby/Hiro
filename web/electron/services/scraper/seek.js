const { chromium } = require('playwright')
const { randomDelay, randomUserAgent, buildResumeFile, stripMarkdown, verifySubmission, confirmSubmission, gotoResultsPage } = require('./utils')

// Search results to walk per scan. One page is ~20 listings, and because
// already-seen job URLs are skipped, a single page stops yielding anything new
// within a few days of running. Bounded so a scan can't crawl indefinitely.
const MAX_PAGES = 10

// Node.js substitute for the browser-only CSS.escape().
// A leading digit needs the numeric escape form (`\31 foo`), not a backslash —
// `#1foo` is not a valid selector at all, and querySelector rejects it. The
// failure was silent (swallowed by the caller's .catch), so any screening field
// whose id started with a digit was skipped without explanation.
function cssEscape(str) {
  const s = String(str)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const code = s.charCodeAt(i)
    // A digit is only a problem in first position; elsewhere it's fine bare.
    if (i === 0 && code >= 0x30 && code <= 0x39) {
      out += '\\3' + ch + ' '
    } else if (/[\w-]/.test(ch)) {
      out += ch
    } else {
      out += '\\' + ch
    }
  }
  return out
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
  const seen = new Set()
  const pages = Math.min(MAX_PAGES, Math.max(1, Number(cfg.scrapePages) || 1))

  try {
    const query = encodeURIComponent(jobKeywords)
    const location = encodeURIComponent(jobLocation || 'Australia')
    const base = `https://www.seek.com.au/${query}-jobs/in-${location}?salaryrange=${salaryMin || 0}-999999&salarytype=annual`

    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const url = pageNum === 1 ? base : `${base}&page=${pageNum}`
      // Throws BlockedError if Seek serves a challenge instead of results, so a
      // block is reported as a block rather than as "found 0 jobs".
      await gotoResultsPage(page, url, 'Seek')

      const jobCards = await page.$$('[data-testid="job-card"]')
      // Past the last page Seek returns an empty result set — stop rather than
      // requesting the remaining pages for nothing.
      if (jobCards.length === 0) break

      let added = 0
      for (const card of jobCards) {
        try {
          const title = await card.$eval('[data-automation="jobTitle"]', el => el.textContent.trim()).catch(() => '')
          const company = await card.$eval('[data-automation="jobCompany"]', el => el.textContent.trim()).catch(() => '')
          const salary = await card.$eval('[data-automation="jobSalary"]', el => el.textContent.trim()).catch(() => '')
          const href = await card.$eval('a[data-automation="jobTitle"]', el => el.href).catch(() => '')

          if (title && company && href && !seen.has(href)) {
            seen.add(href)
            jobs.push({ job_title: title, company, salary, job_url: href, platform: 'Seek' })
            added++
          }
        } catch { /* skip malformed card */ }
      }

      // Nothing new on this page means we've looped back onto the same results
      // (Seek clamps an out-of-range page number to the last one).
      if (added === 0) break
      // Space out page requests — a burst of sequential result pages is the
      // pattern that gets a scraper rate-limited.
      if (pageNum < pages) await randomDelay(2500, 6000)
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

  // Pre-build resume file for upload (uses original DOCX/PDF if available, else generates PDF)
  let resumePath = null
  if (tailoredResume) {
    resumePath = await buildResumeFile(tailoredResume, cfg).catch(() => null)
  }

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
        // Try to delete old resumes if Seek hit the upload limit — click any
        // "Remove" / "Delete" buttons next to previously uploaded resumes
        const deleteSelectors = [
          '[data-automation="resume-delete"]',
          '[data-automation="resume-remove"]',
          'button[aria-label*="Remove" i]',
          'button[aria-label*="Delete" i]',
        ]
        for (const sel of deleteSelectors) {
          const delBtns = await page.$$(sel).catch(() => [])
          for (const btn of delBtns) {
            await btn.click().catch(() => {})
            await randomDelay(500, 1000)
            // Confirm deletion if a dialog appears
            const confirmBtn = await page.$('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Delete")').catch(() => null)
            if (confirmBtn) { await confirmBtn.click().catch(() => {}); await randomDelay(500, 1000) }
          }
        }

        // Upload the tailored resume
        const allFrames = [page, ...page.frames().filter(f => f !== page.mainFrame())]
        for (const frame of allFrames) {
          const fileInput = await frame.$('input[type="file"]').catch(() => null)
          if (fileInput) {
            await fileInput.setInputFiles(resumePath).catch(() => {})
            await fileInput.evaluate(el => {
              el.dispatchEvent(new Event('change', { bubbles: true }))
              el.dispatchEvent(new Event('input', { bubbles: true }))
            }).catch(() => {})
            await randomDelay(1000, 2000)
            break
          }
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
      const coverText = stripMarkdown(coverLetter || tailoredResume).slice(0, 3000)
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

      // Fill salary expectation from config before general screening loop
      if (cfg.salaryMin) {
        const salarySelectors = [
          'input[id*="salary" i]', 'input[name*="salary" i]',
          'input[placeholder*="salary" i]', 'input[aria-label*="salary" i]',
          'input[data-automation*="salary" i]',
        ]
        for (const sel of salarySelectors) {
          const salaryInput = await page.$(sel).catch(() => null)
          if (!salaryInput) continue
          const currentVal = await salaryInput.inputValue().catch(() => '')
          if (!currentVal.trim()) {
            await salaryInput.fill(String(cfg.salaryMin)).catch(() => {})
            await salaryInput.dispatchEvent('input').catch(() => {})
            await salaryInput.dispatchEvent('change').catch(() => {})
            await randomDelay(200, 400)
          }
          break
        }
      }

      // Auto-check tech stack checkboxes whose labels match skills in the resume
      const fieldsets = await page.$$('fieldset').catch(() => [])
      for (const fieldset of fieldsets) {
        const checkboxes = await fieldset.$$('input[type="checkbox"]').catch(() => [])
        if (checkboxes.length === 0) continue
        // Skip if any are already checked (user or pre-fill)
        const anyChecked = await fieldset.$('input[type="checkbox"]:checked').catch(() => null)
        if (anyChecked) continue
        const resumeText = (cfg?.masterResume || '').toLowerCase()
        for (const checkbox of checkboxes) {
          const id = await checkbox.evaluate(el => el.id).catch(() => '')
          let labelText = ''
          if (id) {
            const lbl = await page.$(`label[for="${id}"]`).catch(() => null)
            if (lbl) labelText = await lbl.evaluate(el => el.textContent?.trim() || '').catch(() => '')
          }
          if (!labelText) {
            // Try sibling label or parent label text
            labelText = await checkbox.evaluate(el => el.closest('label')?.textContent?.trim() || '').catch(() => '')
          }
          if (!labelText || labelText.length < 2) continue
          if (resumeText.includes(labelText.toLowerCase())) {
            await checkbox.evaluate(el => {
              el.checked = true
              el.dispatchEvent(new Event('change', { bubbles: true }))
            }).catch(() => {})
            await randomDelay(80, 150)
          }
        }
      }

      // Dynamically detect and answer screening questions on this step
      if (cfg.aiProvider && cfg.aiApiKey) {
        // Helper: get/cache an AI answer for a question. Every answer it hands
        // back is also recorded on `screeningQa` so the finished application
        // shows what was actually submitted on the user's behalf — the detail
        // panel has always had a section for this and it was always empty.
        async function getAnswer(questionText, optionHint) {
          const cached = database.getCachedAnswer(questionText)
          if (cached) { recordAnswer(questionText, cached, 'cache'); return cached }
          let aiAnswer = ''
          try {
            aiAnswer = await aiAdapter.answerScreeningQuestion(
              cfg.aiProvider, cfg.aiApiKey,
              questionText + (optionHint ? ` (options: ${optionHint})` : ''),
              cfg.jobDescription || '',
              cfg.masterResume || '',
              cfg.geminiModel
            )
          } catch {}
          const isUncertain = !aiAnswer || aiAnswer.trim().length < 3 ||
            /not sure|i don't know|unclear|unsure|cannot determine|not enough information/i.test(aiAnswer)
          if (isUncertain && cfg.askQuestion) {
            const prompt = optionHint ? `${questionText} (${optionHint})` : questionText
            const userAnswer = await cfg.askQuestion(prompt).catch(() => '')
            if (userAnswer) {
              database.saveCachedAnswer(questionText, userAnswer)
              recordAnswer(questionText, userAnswer, 'user')
              return userAnswer
            }
            return ''
          }
          if (aiAnswer) {
            database.saveCachedAnswer(questionText, aiAnswer)
            recordAnswer(questionText, aiAnswer, 'ai')
          }
          return aiAnswer || ''
        }

        // ── Radio button groups (YES/NO eligibility questions) ──────────────
        const fieldsetEls = await page.$$('fieldset').catch(() => [])
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
        const labels = await page.$$('label').catch(() => [])
        for (const labelEl of labels) {
          const questionText = await labelEl.evaluate(el => el.textContent?.trim()).catch(() => '')
          if (!questionText || questionText.length < 3) continue
          if (/cover.?letter/i.test(questionText)) continue

          const forId = await labelEl.evaluate(el => el.getAttribute('for')).catch(() => null)
          let input = null
          if (forId) input = await page.$(`#${cssEscape(forId)}`).catch(() => null)
          if (!input) {
            input = await labelEl.$('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select').catch(() => null)
          }
          if (!input) continue

          const tag = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
          const inputType = await input.evaluate(el => el.type || 'text').catch(() => 'text')
          if (!tag || inputType === 'radio' || inputType === 'checkbox') continue

          const currentVal = await input.inputValue().catch(() => '')
          if (currentVal.trim()) continue

          // For select dropdowns, pass available options to AI so it picks a valid one
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

            // 1. Exact label match
            let match = options.find(o => o.text.toLowerCase() === ansLow)
            // 2. Partial text match
            if (!match) match = options.find(o => o.text.toLowerCase().includes(ansLow) || ansLow.includes(o.text.toLowerCase()))
            // 3. Numeric range match (e.g. answer "3" → option "3-5 years")
            if (!match && !isNaN(ansNum)) {
              match = options.find(o => {
                const nums = o.text.match(/(\d+)/g)
                if (!nums) return false
                if (nums.length === 1) return ansNum === parseFloat(nums[0])
                if (nums.length >= 2) return ansNum >= parseFloat(nums[0]) && ansNum <= parseFloat(nums[1])
                return false
              })
            }
            // 4. "No" / "0" / "none" → first non-placeholder option
            if (!match && /^(no|0|none|n\/a)/i.test(answer)) {
              match = options.find(o => /^(no|0|none|never|n\/a)/i.test(o.text)) || options[1] // skip placeholder at [0]
            }
            // 5. "Yes" → find a "Yes" option
            if (!match && /^yes/i.test(answer)) {
              match = options.find(o => /^yes/i.test(o.text))
            }

            if (match) {
              await input.selectOption({ label: match.text }).catch(async () => {
                await input.selectOption({ value: match.value }).catch(() => {})
              })
            } else {
              // Last resort: try raw answer
              await input.selectOption({ label: answer }).catch(async () => {
                await input.selectOption({ value: answer }).catch(() => {})
              })
            }
          } else if (inputType === 'number') {
            const num = answer.replace(/[$,]/g, '').replace(/k$/i, '000').match(/\d+/)
            if (num) {
              await input.fill(num[0]).catch(() => {})
              await input.dispatchEvent('input').catch(() => {})
              await input.dispatchEvent('change').catch(() => {})
            }
          } else {
            await input.fill(answer).catch(() => {})
            await input.dispatchEvent('input').catch(() => {})
            await input.dispatchEvent('change').catch(() => {})
          }
          await randomDelay(200, 400)
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

        // Last checkpoint. The answers exist only now, so this is the earliest
        // honest preview of what the employer is about to receive.
        const approved = await confirmSubmission(cfg, {
          platform: 'Seek', jobUrl, screeningQa,
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
