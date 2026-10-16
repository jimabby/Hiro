// Filling the screening questions on one step of an Easy Apply / Quick Apply
// form — shared by seek.js, indeed.js and linkedin.js.
//
// Three copies of this lived inline, and two bugs lived in all of them:
//
//   The answer was RECORDED before it was typed. LinkedIn asked for an answer
//   without the dropdown's options, recorded it on the application, then called
//   selectOption({label: answer}) — which failed silently whenever the model's
//   wording was not exactly an option. The saved application showed an answer
//   the employer never received, and the form went in with the field blank.
//
//   An answer that matched no option was dropped without a word (Seek and
//   Indeed fell back to selecting the raw answer, which also fails silently).
//
// Now every choice field hands its option labels to resolveAnswer(), which only
// ever returns one of them (or asks the user, with the options, when nothing
// matches); and an answer is recorded only after the page shows it selected or
// filled.

const { resolveAnswer } = require('../screeningAnswers')
const { randomDelay } = require('./utils')

const collapse = s => String(s || '').replace(/\s+/g, ' ').trim()

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

// Select `label` in a <select> and report whether the page now shows it.
async function selectChoice(select, label) {
  const opts = await select.evaluate(el => Array.from(el.options).map(o => ({ text: o.text, value: o.value }))).catch(() => [])
  const opt = opts.find(o => collapse(o.text) === collapse(label))
  if (!opt) return false
  await select.selectOption({ value: opt.value }).catch(async () => {
    await select.selectOption({ label: opt.text }).catch(() => {})
  })
  const now = await select.evaluate(el => el.options[el.selectedIndex]?.text || '').catch(() => '')
  return collapse(now) === collapse(label)
}

// Check a radio and report whether it is checked. Styled radios often hide the
// real input behind a label that swallows a plain click.
async function checkRadio(radio) {
  await radio.click().catch(() => {})
  if (await radio.isChecked().catch(() => false)) return true
  await radio.check({ force: true }).catch(() => {})
  return radio.isChecked().catch(() => false)
}

function ask(question, options, cfg) {
  return resolveAnswer({ question, options, cfg, log: cfg.log })
}

// Radio groups, one per <fieldset>. `record(question, answer, source)` is called
// only once the chosen radio is actually checked.
async function answerRadioGroups(root, { cfg, record }) {
  const fieldsets = await root.$$('fieldset').catch(() => [])
  for (const fieldset of fieldsets) {
    const radios = await fieldset.$$('input[type="radio"]').catch(() => [])
    if (radios.length === 0) continue
    const anyChecked = await fieldset.$('input[type="radio"]:checked').catch(() => null)
    if (anyChecked) continue

    const questionText = collapse(await fieldset.evaluate(el => {
      const legend = el.querySelector('legend')
      if (legend) return legend.textContent || ''
      return el.querySelector('p, [data-automation], [data-test-form-builder-radio-button-form-component__title]')?.textContent || ''
    }).catch(() => ''))
    if (!questionText || questionText.length < 3) continue
    if (/cover.?letter/i.test(questionText)) continue

    const options = []
    for (const radio of radios) {
      const label = collapse(await radio.evaluate(el => {
        const id = el.id
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`)
          if (lbl) return lbl.textContent || ''
        }
        return el.closest('label')?.textContent || el.value || ''
      }).catch(() => ''))
      if (label) options.push({ radio, label })
    }
    if (options.length === 0) continue

    const { answer, source } = await ask(questionText, options.map(o => o.label), cfg)
    if (!answer) continue
    const target = options.find(o => o.label === collapse(answer))
    if (!target) continue
    if (await checkRadio(target.radio)) {
      record(questionText, target.label, source)
    } else {
      cfg.log?.(`  Could not select "${target.label}" for "${questionText.slice(0, 60)}" — left for you.`)
    }
    await randomDelay(200, 400)
  }
}

// Text, number and select fields, found through their <label>s.
async function answerLabelledFields(root, { cfg, record, labelSelector = 'label' }) {
  const labels = await root.$$(labelSelector).catch(() => [])
  for (const labelEl of labels) {
    const questionText = collapse(await labelEl.evaluate(el => el.textContent).catch(() => ''))
    if (!questionText || questionText.length < 3) continue
    if (/cover.?letter/i.test(questionText)) continue

    const forId = await labelEl.evaluate(el => el.getAttribute('for')).catch(() => null)
    let input = null
    if (forId) input = await root.$(`#${cssEscape(forId)}`).catch(() => null)
    if (!input) {
      input = await labelEl.$('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select').catch(() => null)
    }
    if (!input) continue

    const tag = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => '')
    const inputType = await input.evaluate(el => el.type || 'text').catch(() => 'text')
    if (!tag || inputType === 'radio' || inputType === 'checkbox' || inputType === 'file' || inputType === 'hidden') continue

    if (tag === 'select') {
      // A select's "current value" is its placeholder until something is picked,
      // so "already answered" means an option other than the first is selected.
      const picked = await input.evaluate(el => el.selectedIndex > 0 && !!el.value).catch(() => false)
      if (picked) continue
      const options = await input.evaluate(el => Array.from(el.options).map(o => o.text)).catch(() => [])
      const { answer, source } = await ask(questionText, options, cfg)
      if (!answer) continue
      if (await selectChoice(input, answer)) {
        record(questionText, answer, source)
      } else {
        cfg.log?.(`  Could not select "${answer}" for "${questionText.slice(0, 60)}" — left for you.`)
      }
      await randomDelay(200, 400)
      continue
    }

    const currentVal = await input.inputValue().catch(() => '')
    if (currentVal.trim()) continue

    const { answer, source } = await ask(questionText, null, cfg)
    if (!answer) continue

    let value = answer
    if (inputType === 'number') {
      const num = answer.replace(/[$,]/g, '').replace(/(\d)k\b/i, '$1000').match(/\d+(?:\.\d+)?/)
      if (!num) continue
      value = num[0]
    }
    await input.fill(value).catch(() => {})
    await input.dispatchEvent('input').catch(() => {})
    await input.dispatchEvent('change').catch(() => {})
    const now = await input.inputValue().catch(() => '')
    if (now.trim()) record(questionText, value, source)
    await randomDelay(200, 400)
  }
}

// One step's screening questions: radio groups first (they are fieldsets with
// their own legend), then labelled fields.
async function answerScreeningQuestions(root, opts) {
  await answerRadioGroups(root, opts)
  await answerLabelledFields(root, opts)
}

module.exports = { answerScreeningQuestions, answerRadioGroups, answerLabelledFields, selectChoice, checkRadio, cssEscape }
