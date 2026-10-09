// Fill a company career-site application, and leave the submitting to you.
//
// Career boards (Greenhouse, Lever, Ashby, Workday…) are where the steadiest
// listings come from, and until now every one of them ended in Needs Attention
// with "open the posting and paste": the résumé and cover letter were written,
// and then a person retyped their name, email, phone, links and a dozen
// screening answers into a form Hiro already had every answer for.
//
// This opens the form in a visible browser and fills what it can:
//   - contact fields, from Settings or the résumé (contactDetails.js);
//   - the tailored résumé and cover letter, as files or pasted text;
//   - screening questions, through the same path the auto-apply scrapers use —
//     the application profile, then the answer cache, then the model with the
//     fabrication check on its answer (screeningAnswers.js).
//
// What it will not do, by design:
//   - press Submit. The person at the keyboard reviews the form and sends it.
//     That is the whole difference between this and auto-apply, and it is why
//     a form Hiro has never seen before is safe to try: a wrong guess is visible
//     on screen before anyone receives it;
//   - answer equal-opportunity questions or tick consent and attestation boxes.
//     Those are the user's own statements, every time;
//   - overwrite anything already in a field.
//
// Multi-page forms (Workday, Ashby) are handled by a "Fill this page" button
// Hiro adds to the page, so each step can be filled when it appears. When the
// platform's confirmation page shows, the application is recorded as Applied.

const fs = require('fs')
const database = require('../database')
const configService = require('../config')
const aiAdapter = require('../ai/index')
const { resolveAnswer } = require('../screeningAnswers')
const { contactFor } = require('../contactDetails')
const { inspectTailoring, inspectCoverLetter, describeFlags } = require('../fabricationGuard')
const { detectInjection, describeInjection } = require('../ai/untrusted')
const { writingModel } = require('../ai/models')
const { isAiConfigured } = require('../ai/configured')
const { classifyField, pickOption, looksSubmitted, detectAts, formUrlFor } = require('./classify')

let active = null
// The documents from the session that last closed, so "I sent it" records what
// was actually attached — kept here rather than round-tripped via the renderer.
let lastSession = null

function isActive() { return !!active }

// ─── The job and its documents ───────────────────────────────────
function loadJob(source, id) {
  if (source === 'held') {
    const row = database.getApplication(id)
    if (!row) throw new Error('Application not found.')
    if (row.status !== 'held') throw new Error(`This application is already "${row.status}".`)
    return row
  }
  const job = database.getAttentionJob(id)
  if (!job) throw new Error('Job not found.')
  return job
}

// Reuse the drafted documents when there are any; draft them when not. The
// person reviews every field before sending, so the guard's objections are
// shown on the page as warnings rather than enforced as a block — but they are
// shown, prominently, because a reviewer who has not been told what to look for
// often does not look.
async function prepareDocuments(job, cfg, log) {
  let tailoredResume = String(job.tailored_resume || '').trim()
  let coverLetter = String(job.cover_letter || '').trim()
  const jd = job.job_description || job.job_title
  if (!tailoredResume && isAiConfigured(cfg)) {
    log('Tailoring the résumé…')
    try { tailoredResume = await aiAdapter.tailorResume(cfg.aiProvider, cfg.aiApiKey, jd, cfg.masterResume, cfg.geminiModel) } catch (err) { log(`Résumé tailoring failed: ${err.message}`) }
  }
  if (!coverLetter && isAiConfigured(cfg)) {
    log('Writing the cover letter…')
    try { coverLetter = await aiAdapter.generateCoverLetter(cfg.aiProvider, cfg.aiApiKey, jd, cfg.masterResume, cfg.geminiModel, cfg.coverLetterTone, cfg.coverLetterTemplate) } catch (err) { log(`Cover letter failed: ${err.message}`) }
  }
  tailoredResume = tailoredResume || cfg.masterResume || ''

  const warnings = []
  const fabrication = inspectTailoring(cfg.masterResume || '', tailoredResume)
  if (!fabrication.safe) warnings.push(`Résumé: ${describeFlags(fabrication.flags)}`)
  const letter = inspectCoverLetter(cfg.masterResume || '', coverLetter, { company: job.company, jobTitle: job.job_title })
  if (coverLetter && !letter.safe) warnings.push(`Cover letter: ${describeFlags(letter.flags)}`)
  const injection = detectInjection(job.job_description || '')
  if (!injection.clean) warnings.push(`The listing contains instructions aimed at AI (${describeInjection(injection.hits)}) — check every answer.`)
  return { tailoredResume, coverLetter, warnings }
}

// ─── In the page ─────────────────────────────────────────────────
// Runs inside each frame. Tags every fillable control with data-hiro-field and
// describes it: what the label says, what kind of control it is, whether it
// already holds a value. Radio buttons are reported as one group per name.
function collectFieldsInPage() {
  const visible = el => {
    if (el.type === 'file') return true // often visually hidden behind a styled button
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const text = n => (n?.innerText || n?.textContent || '').replace(/\s+/g, ' ').trim()
  const labelOf = el => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map(id => text(document.getElementById(id))).join(' ').trim()
      if (t) return t
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l && text(l)) return text(l)
    }
    const wrap = el.closest('label')
    if (wrap && text(wrap)) return text(wrap)
    let c = el.parentElement
    for (let d = 0; c && d < 4; d++, c = c.parentElement) {
      const l = c.querySelector('label, legend, [class*="label" i], [class*="question" i]')
      if (l && !l.contains(el) && text(l)) return text(l)
    }
    return el.placeholder || ''
  }
  const groupLabel = el => {
    const fs = el.closest('fieldset')
    const legend = fs && fs.querySelector('legend')
    if (legend && text(legend)) return text(legend)
    let c = el.parentElement
    for (let d = 0; c && d < 5; d++, c = c.parentElement) {
      const radios = c.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)
      if (radios.length > 1) {
        const l = c.querySelector('label:not(:has(input)), legend, [class*="label" i], [class*="question" i]')
        if (l && text(l)) return text(l)
      }
    }
    return el.name || ''
  }

  // A native <select> always has a value — its first option, usually a
  // "Select…" placeholder — so "has a value" means a real choice was made.
  const selectChosen = el => {
    const o = el.options[el.selectedIndex]
    return !!o && !!String(o.value).trim() && el.selectedIndex > 0 && !/^\s*(select|choose|please|--|—)/i.test(o.text)
  }
  const out = []
  const seenGroups = new Set()
  let n = Number(document.documentElement.dataset.hiroNext || 0)
  const tag = el => {
    if (!el.dataset.hiroField) el.dataset.hiroField = String(n++)
    return el.dataset.hiroField
  }
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const type = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : (el.type || 'text').toLowerCase()
    if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search'].includes(type)) continue
    if (el.disabled || el.readOnly || !visible(el)) continue
    if (el.closest('#hiro-assist-panel')) continue
    if (type === 'radio') {
      if (!el.name || seenGroups.has(el.name)) continue
      seenGroups.add(el.name)
      const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)]
      out.push({
        type: 'radio', label: groupLabel(el), name: el.name,
        required: radios.some(r => r.required), hasValue: radios.some(r => r.checked),
        options: radios.map(r => ({ id: tag(r), text: labelOf(r) || r.value })),
      })
      continue
    }
    out.push({
      id: tag(el), type, label: labelOf(el), name: el.name || '',
      required: el.required || el.getAttribute('aria-required') === 'true',
      hasValue: type === 'checkbox' ? el.checked : type === 'file' ? el.files?.length > 0
        : type === 'select' ? selectChosen(el) : !!String(el.value || '').trim(),
      options: type === 'select' ? [...el.options].map(o => o.text) : undefined,
    })
  }
  document.documentElement.dataset.hiroNext = String(n)
  return out
}

// Floating panel: what Hiro did, what it left for the user, and a button to fill
// the next page of a multi-step form. Lives in the top frame only.
function installPanelInPage() {
  if (window.top !== window || document.getElementById('hiro-assist-panel')) return
  const mount = () => {
    if (document.getElementById('hiro-assist-panel') || !document.body) return
    const p = document.createElement('div')
    p.id = 'hiro-assist-panel'
    p.setAttribute('role', 'status')
    p.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;max-height:50vh;overflow:auto;'
      + 'background:#111827;color:#F9FAFB;font:13px/1.45 system-ui,sans-serif;border-radius:10px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.35)'
    p.innerHTML = '<div style="font-weight:600;margin-bottom:6px">Hiro is filling this form</div>'
      + '<div id="hiro-assist-body">Reading the form…</div>'
      + '<button id="hiro-assist-fill" style="margin-top:10px;background:#2563EB;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit">Fill this page</button>'
      + '<div style="margin-top:8px;color:#9CA3AF;font-size:12px">Hiro never presses Submit. Check every field, then send it yourself.</div>'
    document.body.appendChild(p)
    p.querySelector('#hiro-assist-fill').addEventListener('click', () => window.hiroFillPage && window.hiroFillPage())
    if (window.__hiroLastStatus) window.hiroShowStatus(window.__hiroLastStatus)
  }
  window.hiroShowStatus = (html) => {
    window.__hiroLastStatus = html
    const b = document.getElementById('hiro-assist-body')
    if (b) b.innerHTML = html
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ─── Filling ─────────────────────────────────────────────────────
async function fillFrame(frame, ctx) {
  let fields
  try { fields = await frame.evaluate(collectFieldsInPage) } catch { return { filled: [], left: [] } }
  const filled = []
  const left = []
  const contact = ctx.contact

  for (const f of fields) {
    if (f.hasValue) continue
    const what = classifyField(f)
    const label = (f.label || f.name || 'Untitled field').slice(0, 120)
    try {
      if (what.kind === 'contact') {
        const value = contact[what.key]
        if (!value) { if (f.required) left.push(label); continue }
        await frame.locator(`[data-hiro-field="${f.id}"]`).fill(value)
        filled.push(label)
      } else if (what.kind === 'resumeFile') {
        await frame.locator(`[data-hiro-field="${f.id}"]`).setInputFiles(await ctx.resumeFile())
        filled.push(`${label} (tailored résumé)`)
      } else if (what.kind === 'coverLetterFile') {
        if (!ctx.coverLetter) { if (f.required) left.push(label); continue }
        await frame.locator(`[data-hiro-field="${f.id}"]`).setInputFiles(await ctx.coverLetterFile())
        filled.push(`${label} (cover letter)`)
      } else if (what.kind === 'coverLetterText') {
        if (!ctx.coverLetter) { if (f.required) left.push(label); continue }
        await frame.locator(`[data-hiro-field="${f.id}"]`).fill(ctx.coverLetter)
        filled.push(label)
      } else if (what.kind === 'question') {
        if (f.type === 'checkbox' || f.type === 'file') { if (f.required) left.push(label); continue }
        const optionTexts = f.type === 'radio' ? f.options.map(o => o.text) : f.options
        const { answer, source } = await ctx.answer(f.label, optionTexts)
        if (!answer) { left.push(label); continue }
        if (f.type === 'select') {
          const choice = pickOption(answer, f.options)
          if (!choice) { left.push(label); continue }
          await frame.locator(`[data-hiro-field="${f.id}"]`).selectOption({ label: choice })
        } else if (f.type === 'radio') {
          const choice = pickOption(answer, optionTexts)
          const opt = choice && f.options.find(o => o.text === choice)
          if (!opt) { left.push(label); continue }
          await frame.locator(`[data-hiro-field="${opt.id}"]`).check()
        } else {
          await frame.locator(`[data-hiro-field="${f.id}"]`).fill(answer)
        }
        filled.push(label)
        ctx.qa.push({ question: f.label, answer, source })
      } else if (what.kind === 'eeo' || what.kind === 'consent') {
        if (f.required) left.push(`${label} — yours to answer`)
      }
    } catch {
      // A custom widget that does not behave like the element it wraps. Leave
      // it to the person rather than half-filling it.
      left.push(label)
    }
  }

  // Outline what is left, so it is found without hunting.
  try {
    await frame.evaluate(() => {
      for (const el of document.querySelectorAll('[data-hiro-field]')) {
        const empty = el.type === 'checkbox' || el.type === 'radio' ? false
          : el.type === 'file' ? !el.files?.length
          : el.tagName === 'SELECT' ? el.selectedIndex <= 0
          : !String(el.value || '').trim()
        const required = el.required || el.getAttribute('aria-required') === 'true'
        el.style.outline = empty && required ? '2px solid #F59E0B' : ''
      }
    })
  } catch { /* frame navigated away */ }
  return { filled, left }
}

function statusHtml({ filled, left, warnings, submitted }) {
  if (submitted) return '<div style="color:#34D399;font-weight:600">Submitted — recorded as Applied in Hiro.</div><div>You can close this window.</div>'
  const parts = [`<div>Filled ${filled.length} field${filled.length === 1 ? '' : 's'}.</div>`]
  if (left.length) {
    parts.push(`<div style="margin-top:6px;color:#FCD34D">Left for you (outlined in amber):</div><ul style="margin:4px 0 0 16px;padding:0">${
      left.slice(0, 12).map(l => `<li>${escapeHtml(l)}</li>`).join('')}${left.length > 12 ? `<li>…and ${left.length - 12} more</li>` : ''}</ul>`)
  }
  if (warnings.length) {
    parts.push(`<div style="margin-top:6px;color:#FCA5A5">Check before sending:</div><ul style="margin:4px 0 0 16px;padding:0">${
      warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`)
  }
  return parts.join('')
}

// ─── Recording the outcome ───────────────────────────────────────
function recordApplied(source, job, cfg, docs, qa) {
  if (source === 'held') {
    database.markHeldApplied(job.id, qa)
    return
  }
  database.insertApplication({
    job_title: job.job_title, company: job.company, platform: job.platform,
    salary: job.salary || '', job_url: job.job_url, job_description: job.job_description,
    match_score: job.match_score, match_explanation: job.match_explanation || '',
    tailored_resume: docs.tailoredResume, cover_letter: docs.coverLetter,
    screening_qa: qa, status: 'applied', closing_date: job.closing_date || null,
    base_resume: cfg.masterResume || '', resume_id: cfg.activeResumeId, resume_name: cfg.activeResumeName,
    provider: cfg.aiProvider || '', model: writingModel(cfg),
    campaign_id: job.campaign_id, campaign_name: job.campaign_name,
  })
  database.dismissAttentionJob(job.id)
}

// ─── Session ─────────────────────────────────────────────────────
// Resolves when the browser window is closed. `submitted` is true when the
// platform's confirmation page was seen; otherwise the caller asks the person
// whether they sent it.
async function open({ source = 'attention', id }, { log = () => {}, resolveCfg = c => c } = {}) {
  if (active) return { success: false, reason: 'A form is already open in Hiro\'s browser — finish or close that one first.' }
  active = { source, id }
  const tempFiles = []
  let browser = null
  try {
    const job = loadJob(source, id)
    if (!job.job_url) return { success: false, reason: 'This job has no posting URL to open.' }
    const cfg = resolveCfg(configService.load(), job)
    const docs = await prepareDocuments(job, cfg, log)
    const { buildResumeFile, buildCoverLetterPDF, launchOptions } = require('../scraper/utils')

    const ctx = {
      contact: contactFor(cfg),
      coverLetter: docs.coverLetter,
      qa: [],
      resumeFile: once(async () => { const p = await buildResumeFile(docs.tailoredResume, cfg); tempFiles.push(p); return p }),
      coverLetterFile: once(async () => { const p = await buildCoverLetterPDF(docs.coverLetter); tempFiles.push(p); return p }),
      answer: async (question, options) => {
        try {
          return await resolveAnswer({
            question, optionHint: (options || []).filter(Boolean).slice(0, 12).join(' / '),
            cfg: { ...cfg, jobDescription: job.job_description || '' }, log,
          })
        } catch (err) {
          log(`  Left blank: ${err.message}`)
          return { answer: '', source: '' }
        }
      },
    }

    const { chromium } = require('playwright')
    browser = await chromium.launch(launchOptions({ headless: false }, cfg))
    const context = await browser.newContext({ viewport: null })
    const page = await context.newPage()
    const state = { filled: [], left: [], warnings: docs.warnings, submitted: false }

    const fillAll = async () => {
      const filled = []
      const left = []
      for (const frame of page.frames()) {
        const r = await fillFrame(frame, ctx)
        filled.push(...r.filled)
        left.push(...r.left)
      }
      state.filled = [...new Set([...state.filled, ...filled])]
      state.left = left
      await showStatus()
      log(`Filled ${filled.length} field(s); ${left.length} left for you.`)
    }
    const showStatus = async () => {
      try { await page.evaluate(html => window.hiroShowStatus && window.hiroShowStatus(html), statusHtml(state)) } catch { /* navigating */ }
    }

    await context.exposeFunction('hiroFillPage', () => fillAll().catch(err => log(`Fill error: ${err.message}`)))
    await context.addInitScript(installPanelInPage)

    // A confirmation page means the person pressed Submit. Checked on every
    // load of the top frame.
    page.on('load', async () => {
      if (state.submitted) return
      try {
        const text = await page.evaluate(() => document.body?.innerText || '')
        if (looksSubmitted(text)) {
          state.submitted = true
          recordApplied(source, job, cfg, docs, ctx.qa)
          log(`Submitted — ${job.job_title} at ${job.company} recorded as Applied.`)
          await showStatus()
        }
      } catch { /* closed */ }
    })

    const url = formUrlFor(job.job_url)
    log(`Opening the ${detectAts(url)} form for ${job.job_title} at ${job.company}…`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await fillAll()

    // Hand over to the person. The session lasts as long as the window does.
    await new Promise(resolve => {
      browser.on('disconnected', resolve)
      context.on('close', resolve)
      page.on('close', resolve)
    })
    lastSession = state.submitted ? null : { key: `${source}:${id}`, documents: docs, qa: ctx.qa }
    return {
      success: true, submitted: state.submitted, filled: state.filled.length,
      left: state.left, warnings: state.warnings,
    }
  } catch (err) {
    return { success: false, reason: err.message }
  } finally {
    active = null
    try { await browser?.close() } catch { /* already closed */ }
    for (const p of tempFiles) try { fs.unlinkSync(p) } catch { /* best-effort */ }
  }
}

// After a session ends without a confirmation page being seen, the person can
// say they sent it. Uses the documents from the session that just closed.
function markSubmitted({ source = 'attention', id }, { resolveCfg = c => c } = {}) {
  const job = loadJob(source, id)
  const cfg = resolveCfg(configService.load(), job)
  const session = lastSession?.key === `${source}:${id}` ? lastSession : null
  recordApplied(source, job, cfg, {
    tailoredResume: session?.documents.tailoredResume || job.tailored_resume || cfg.masterResume || '',
    coverLetter: session?.documents.coverLetter || job.cover_letter || '',
  }, session?.qa || [])
  lastSession = null
  return { success: true }
}

function once(fn) {
  let p = null
  return () => (p = p || fn())
}

module.exports = { open, markSubmitted, isActive, prepareDocuments, statusHtml, collectFieldsInPage, fillFrame }
