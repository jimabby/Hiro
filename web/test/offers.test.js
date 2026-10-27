// Offer comparison.
//
// The numbers here are the ones a real decision turns on, so the arithmetic has
// to be right and the difference between a firm offer and an advertised range
// has to survive to the UI — presenting an advert as if it were an offer is the
// one failure that would actively mislead.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-offers-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const offsetDate = (days) => {
  const d = new Date(Date.now() + days * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function add(jobUrl, { company = 'Example', salary = '' } = {}) {
  db.insertApplication({
    job_title: 'Engineer', company, platform: 'Seek', job_url: jobUrl, salary,
    job_description: '', match_score: 80, match_explanation: '',
    tailored_resume: '', screening_qa: [], status: 'applied',
  })
  return db.getApplications().find(a => a.job_url === jobUrl).id
}

async function main() {
  await db.init()

  const empty = db.getOffers()
  check('no offers is a complete, empty shape', empty.offers.length, 0)
  check('no offers has no best', empty.best, null)
  check('no offers has no deadline', empty.nextDeadline, null)

  const a = add('https://o/1', { company: 'Alpha' })
  const b = add('https://o/2', { company: 'Beta', salary: '$120,000 - $140,000' })

  check('an offer against a missing application is refused',
    db.saveOffer(999999, { baseSalary: 100 }).success, false)
  check('an offer with no application id is refused',
    db.saveOffer(null, {}).success, false)

  db.saveOffer(a, { currency: 'AUD', baseSalary: 150000, bonus: 20000, respondBy: offsetDate(5), excitement: 4, pros: 'Team', cons: 'Commute' })

  // Recording an offer promotes the application, so the dashboard and the
  // offers board cannot disagree about what this row is.
  check('recording an offer marks the application as an offer',
    db.getApplication(a).status, 'offer')

  const one = db.getOffers()
  check('total compensation is base plus bonus', one.offers[0].totalComp, 170000)
  check('a firm offer is not flagged as advertised', one.offers[0].compIsAdvertised, false)
  check('the live count sees it', one.live, 1)
  check('the best figure is the total', one.best, 170000)
  check('a single offer has no spread', one.spread, null)
  check('the deadline is surfaced', one.nextDeadline.applicationId, a)
  check('days to respond is counted forward', one.offers[0].daysToRespond, 5)
  check('a future deadline is not expired', one.offers[0].expired, false)

  // An offer with no figures entered yet falls back to the advertised range,
  // and says that it did.
  db.saveOffer(b, { currency: 'AUD', respondBy: offsetDate(2) })
  const two = db.getOffers()
  const beta = two.offers.find(o => o.applicationId === b)
  check('a figureless offer has no total', beta.totalComp, null)
  check('a figureless offer falls back to the advertised midpoint', beta.comparableComp, 130000)
  check('the fallback is flagged as advertised', beta.compIsAdvertised, true)
  check('the spread compares both', two.spread, 40000)
  check('the soonest deadline wins', two.nextDeadline.applicationId, b)

  // Saving twice must update, never duplicate — the table is keyed by
  // application, and two rows for one job would double-count the comparison.
  db.saveOffer(a, { currency: 'AUD', baseSalary: 160000, bonus: 20000, respondBy: offsetDate(5) })
  const updated = db.getOffers()
  check('saving again updates in place', updated.offers.length, 2)
  check('the updated figure is used', updated.offers.find(o => o.applicationId === a).totalComp, 180000)

  // Input handling. A hostile or fat-fingered value must be clamped or
  // rejected, never stored raw.
  db.saveOffer(a, { currency: 'AUD', baseSalary: -5, bonus: 'abc', excitement: 99, decision: 'nonsense', respondBy: 'not-a-date' })
  const cleaned = db.getOffers().offers.find(o => o.applicationId === a)
  check('a negative salary is clamped to zero', cleaned.base_salary, 0)
  check('a non-numeric bonus becomes null', cleaned.bonus, null)
  check('excitement is clamped to the 0–5 scale', cleaned.excitement, 5)
  check('an unknown decision falls back to considering', cleaned.decision, 'considering')
  check('a malformed date is not stored', cleaned.respond_by, null)
  check('an offer with no deadline has no countdown', cleaned.daysToRespond, null)

  // A past deadline on an undecided offer is the thing worth shouting about.
  db.saveOffer(b, { currency: 'AUD', respondBy: offsetDate(-3) })
  check('a passed deadline is flagged',
    db.getOffers().offers.find(o => o.applicationId === b).expired, true)
  check('an expired deadline counts backwards',
    db.getOffers().offers.find(o => o.applicationId === b).daysToRespond, -3)

  // Decided offers leave the live set but stay on the board — a declined offer
  // is still part of the record of what was on the table.
  //
  // A is restored to a real figure first: the clamping checks above deliberately
  // left it at zero, and `best` is only meaningful against a live offer worth
  // something.
  db.saveOffer(a, { currency: 'AUD', baseSalary: 180000, respondBy: offsetDate(5) })
  db.saveOffer(b, { currency: 'AUD', baseSalary: 250000, decision: 'declined' })
  const decided = db.getOffers()
  check('a declined offer leaves the live count', decided.live, 1)
  check('a declined offer stays on the board', decided.offers.length, 2)
  // The larger figure belongs to the declined offer. `best` reports what is
  // still on the table, so it must ignore it.
  check('a declined offer does not set the best figure', decided.best, 180000)

  // Reaching the offer stage is a fact about the application; the decision made
  // about the offer is a separate field. Recording an already-decided offer used
  // to leave the row at its previous status, so the Pipeline board filed an
  // accepted offer under Interview and every by-status offer analytic missed it.
  for (const decision of ['accepted', 'declined', 'expired']) {
    const row = add(`https://example.com/decided-${decision}`)
    db.updateApplicationStatus(row, 'interview')
    db.saveOffer(row, { baseSalary: 200000, decision })
    check(`recording an ${decision} offer still marks the application as an offer`,
      db.getApplication(row).status, 'offer')
    // Removed again so the board counts asserted below stay about the two
    // offers this test set up deliberately.
    db.deleteApplication(row)
  }

  // Deleting the application takes its offer with it.
  db.deleteApplication(b)
  check('deleting an application removes its offer', db.getOffers().offers.length, 1)

  db.deleteOffer(a)
  check('an offer can be removed on its own', db.getOffers().offers.length, 0)
  check('removing the offer leaves the application', !!db.getApplication(a), true)

  // ─── Mixed currencies, compared at the user's own rates ─────────
  const usd = add('https://o/usd', { company: 'Gamma' })
  const eur = add('https://o/eur', { company: 'Delta' })
  db.saveOffer(a, { currency: 'AUD', baseSalary: 180000, respondBy: offsetDate(5) })
  db.saveOffer(usd, { currency: 'USD', baseSalary: 120000 })
  db.saveOffer(eur, { currency: 'EUR', baseSalary: 100000 })
  const mixed = db.getOffers()
  check('mixed currencies without rates are not compared', [mixed.best, mixed.converted], [null, null])
  check('and the page is told rates can be added', /add your own rates/.test(mixed.comparisonNote), true)

  check('a malformed base is refused', db.setExchangeRates({ base: 'dollars', rates: {} }).success, false)
  check('a negative rate is refused', db.setExchangeRates({ base: 'AUD', rates: { USD: -1 } }).success, false)
  check('a non-numeric rate is refused', db.setExchangeRates({ base: 'AUD', rates: { USD: 'lots' } }).success, false)
  check('a bad currency code is refused', db.setExchangeRates({ base: 'AUD', rates: { US: 1.5 } }).success, false)

  db.setExchangeRates({ base: 'aud', rates: { usd: 1.5 } })
  const partial = db.getOffers()
  check('rates are stored upper-cased', partial.exchangeRates, { ...partial.exchangeRates, base: 'AUD', rates: { USD: 1.5 } })
  check('one missing rate means no converted comparison', partial.converted, null)
  check('and says which rate is missing', partial.missingRates, ['EUR'])
  check('the convertible offers still carry their converted figure', partial.offers.find(o => o.applicationId === usd).convertedComp, 180000)
  check('one with no rate is not guessed', partial.offers.find(o => o.applicationId === eur).convertedComp, null)

  db.setExchangeRates({ base: 'AUD', rates: { USD: 1.5, EUR: 1.65 } })
  const fx = db.getOffers()
  check('with every rate, the offers are compared in the base currency', fx.converted.base, 'AUD')
  check('the best converted figure', fx.converted.best, 180000)
  check('the converted spread', fx.converted.spread, 15000)
  check('the rates used are reported', fx.converted.rates, { USD: 1.5, EUR: 1.65 })
  check('the original figure is kept beside the converted one', [fx.offers.find(o => o.applicationId === eur).comparableComp, fx.offers.find(o => o.applicationId === eur).convertedComp], [100000, 165000])
  check('the base currency converts at 1', fx.offers.find(o => o.applicationId === a).convertedRate, 1)
  check('the unconverted best stays null — no single currency', fx.best, null)
  check('no note once it is comparable', fx.comparisonNote, '')
  db.setExchangeRates({ base: '', rates: {} })
  check('clearing the rates removes the conversion', db.getOffers().converted, null)
  db.deleteApplication(usd)
  db.deleteApplication(eur)

  check('today is a valid comparison anchor', typeof today(), 'string')
  done()
}

main()
