// The last checkpoint before an application reaches an employer.
//
// Screening answers don't exist until the form filler has walked the wizard, so
// this is the first moment there is anything true to show — and the last moment
// anything can be stopped. Everything here is about which way the gate falls
// when the answer is anything other than an explicit yes.

const os = require('os')
const path = require('path')
const { stub, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-confirm-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const { confirmSubmission } = require('../electron/services/scraper/utils')
const { check, done } = createChecker()

const details = { platform: 'Seek', jobUrl: 'https://example.com/1', screeningQa: [] }

;(async () => {
  // ── No callback: proceed ─────────────────────────────────────
  // A scheduled scan has nobody at the keyboard. main.js supplies the callback
  // only for submissions the user started, so its absence means "unattended",
  // and blocking would hang the scan on a modal no one will ever answer.
  check('no callback proceeds', await confirmSubmission({}, details), true)
  check('undefined cfg proceeds', await confirmSubmission(undefined, details), true)
  check('non-function callback proceeds',
    await confirmSubmission({ confirmSubmit: 'yes' }, details), true)

  // ── Callback present: only an explicit true sends ────────────
  check('true sends', await confirmSubmission({ confirmSubmit: async () => true }, details), true)
  check('false stops', await confirmSubmission({ confirmSubmit: async () => false }, details), false)

  // Anything truthy-but-not-true is a bug somewhere upstream, not consent.
  check('truthy string does not send',
    await confirmSubmission({ confirmSubmit: async () => 'yes' }, details), false)
  check('1 does not send',
    await confirmSubmission({ confirmSubmit: async () => 1 }, details), false)
  check('undefined does not send',
    await confirmSubmission({ confirmSubmit: async () => undefined }, details), false)
  check('null does not send',
    await confirmSubmission({ confirmSubmit: async () => null }, details), false)

  // ── Failure: stop ────────────────────────────────────────────
  // We asked and never learned the answer. Unlike the absent case, someone was
  // meant to be watching — proceeding here would be the exact unattended send
  // this gate exists to prevent.
  check('a throwing callback stops',
    await confirmSubmission({ confirmSubmit: async () => { throw new Error('window gone') } }, details), false)
  check('a synchronously throwing callback stops',
    await confirmSubmission({ confirmSubmit: () => { throw new Error('boom') } }, details), false)
  check('a rejected promise stops',
    await confirmSubmission({ confirmSubmit: () => Promise.reject(new Error('ipc closed')) }, details), false)

  // A synchronous `true` is still a yes — awaiting a non-promise is fine.
  check('synchronous true sends',
    await confirmSubmission({ confirmSubmit: () => true }, details), true)

  // ── The callback receives what it needs to render ────────────
  let seen = null
  await confirmSubmission({ confirmSubmit: async (d) => { seen = d; return true } }, {
    platform: 'Seek',
    jobUrl: 'https://example.com/9',
    screeningQa: [{ question: 'Working rights?', answer: 'Yes', source: 'ai' }],
  })
  check('details reach the callback', seen.platform, 'Seek')
  check('answers reach the callback', seen.screeningQa[0].answer, 'Yes')
  check('answer provenance reaches the callback', seen.screeningQa[0].source, 'ai')

  done()
})()
