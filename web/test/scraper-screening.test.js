// Filling screening questions on an Easy Apply form, and recording only what
// the form actually received.
//
// LinkedIn asked the model for an answer WITHOUT the dropdown's options,
// recorded that answer on the application, and then called
// selectOption({ label: answer }), which failed silently whenever the wording
// was not exactly an option. The application's Q&A showed an answer the
// employer never got. Seek and Indeed shared the same record-first order.
//
// Also here: a browser launched before a scraper's try/finally leaked whenever
// newContext() threw (a corrupt saved session does exactly that).

const { stub, createChecker } = require('./helpers')

const seenOptions = []
let nextAnswer = ''
stub({
  '../screeningAnswers': {
    resolveAnswer: async ({ options }) => { seenOptions.push(options); return { answer: nextAnswer, source: 'ai' } },
  },
  './utils': { randomDelay: async () => {} },
})

const { answerLabelledFields, answerRadioGroups } = require('../electron/services/scraper/screening')
const { openPage } = require('../electron/services/scraper/utils')
const { check, done } = createChecker()

function fakeSelect(texts, { broken = false } = {}) {
  const dom = {
    tagName: 'SELECT', type: 'select-one',
    options: texts.map((text, i) => ({ text, value: `v${i}` })),
    selectedIndex: 0,
    get value() { return this.selectedIndex > 0 ? this.options[this.selectedIndex].value : '' },
  }
  return {
    dom,
    evaluate: async (fn) => fn(dom),
    selectOption: async ({ value, label }) => {
      if (broken) throw new Error('element is not attached') // the silent failure
      const i = dom.options.findIndex(o => o.value === value || o.text === label)
      if (i < 0) throw new Error('no such option')
      dom.selectedIndex = i
    },
    inputValue: async () => dom.value,
  }
}

function pageWith(question, input) {
  const label = {
    evaluate: async (fn) => fn({ textContent: question, getAttribute: () => 'f1' }),
    $: async () => null,
  }
  return { $$: async () => [label], $: async (sel) => (sel === '#f1' ? input : null) }
}

;(async () => {
  // ── A select gets its options, and is recorded once selected ───
  let recorded = []
  const record = (q, a, s) => recorded.push({ q, a, s })
  const select = fakeSelect(['Select an option', '0-1 years', '2-3 years', '4-6 years'])
  nextAnswer = '4-6 years'
  await answerLabelledFields(pageWith('Years of React experience?', select), { cfg: {}, record })
  check('the resolver is given the dropdown\'s options', seenOptions.at(-1), ['Select an option', '0-1 years', '2-3 years', '4-6 years'])
  check('the option is selected on the page', select.dom.selectedIndex, 3)
  check('and only then recorded', recorded, [{ q: 'Years of React experience?', a: '4-6 years', s: 'ai' }])

  // ── A selection that does not take is not recorded ─────────────
  recorded = []
  const broken = fakeSelect(['Select an option', 'Yes', 'No'], { broken: true })
  nextAnswer = 'Yes'
  const logs = []
  await answerLabelledFields(pageWith('Do you have working rights?', broken), { cfg: { log: m => logs.push(m) }, record })
  check('a failed selection is not recorded as submitted', recorded.length, 0)
  check('and it is reported, not silent', logs.some(m => /Could not select/.test(m)), true)

  // ── An already-answered select is left alone ───────────────────
  recorded = []
  const done1 = fakeSelect(['Select', 'Yes', 'No'])
  done1.dom.selectedIndex = 2
  await answerLabelledFields(pageWith('Already answered?', done1), { cfg: {}, record })
  check('a select with a real choice already made is skipped', done1.dom.selectedIndex, 2)

  // ── Radio groups: recorded only once checked ───────────────────
  recorded = []
  const radio = (label, { stubborn = false } = {}) => {
    let checked = false
    return {
      evaluate: async (fn) => fn({ id: '', value: label, closest: () => ({ textContent: label }) }),
      click: async () => { if (!stubborn) checked = true },
      check: async () => { checked = true },
      isChecked: async () => checked,
    }
  }
  const yes = radio('Yes', { stubborn: true }) // a styled radio that swallows the click
  const no = radio('No')
  const fieldset = {
    $$: async () => [yes, no],
    $: async () => null,
    evaluate: async (fn) => fn({ querySelector: (s) => (s === 'legend' ? { textContent: 'Can you start within a month?' } : null) }),
  }
  nextAnswer = 'Yes'
  await answerRadioGroups({ $$: async () => [fieldset] }, { cfg: {}, record })
  check('the radio group passes its labels', seenOptions.at(-1), ['Yes', 'No'])
  check('a click that did not take is retried with check()', await yes.isChecked(), true)
  check('and recorded once checked', recorded, [{ q: 'Can you start within a month?', a: 'Yes', s: 'ai' }])

  // ── The browser is closed when the context cannot be created ───
  let closed = false
  const browser = {
    newContext: async () => { throw new Error('Invalid storageState: Unexpected token') },
    close: async () => { closed = true },
  }
  const err = await openPage(browser, { storageState: 'corrupt.json' }).catch(e => e)
  check('a failed newContext is still an error', err instanceof Error, true)
  check('and the browser is closed, not leaked', closed, true)

  closed = false
  const ok = await openPage({ newContext: async () => ({ newPage: async () => 'page' }), close: async () => { closed = true } })
  check('a good session returns the page', ok, 'page')
  check('and leaves the browser open', closed, false)

  // Every scraper opens its page through openPage, so no newContext() sits
  // between a launch and its try/finally any more; and each submission keeps
  // its proof-of-submission screenshot.
  const fs = require('fs')
  const path = require('path')
  for (const name of ['seek', 'indeed', 'linkedin']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'scraper', `${name}.js`), 'utf8')
    check(`${name}: no bare newContext after a launch`, /browser\.newContext\(/.test(src), false)
    check(`${name}: screening is filled by the shared module`, src.includes('answerScreeningQuestions('), true)
    check(`${name}: a verified submission returns a screenshot`, src.includes('screenshot: await captureProof(page)'), true)
  }

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
