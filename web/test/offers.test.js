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

  db.saveOffer(a, { baseSalary: 150000, bonus: 20000, respondBy: offsetDate(5), excitement: 4, pros: 'Team', cons: 'Commute' })

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
  db.saveOffer(b, { respondBy: offsetDate(2) })
  const two = db.getOffers()
  const beta = two.offers.find(o => o.applicationId === b)
  check('a figureless offer has no total', beta.totalComp, null)
  check('a figureless offer falls back to the advertised midpoint', beta.comparableComp, 130000)
  check('the fallback is flagged as advertised', beta.compIsAdvertised, true)
  check('the spread compares both', two.spread, 40000)
  check('the soonest deadline wins', two.nextDeadline.applicationId, b)

  // Saving twice must update, never duplicate — the table is keyed by
  // application, and two rows for one job would double-count the comparison.
  db.saveOffer(a, { baseSalary: 160000, bonus: 20000, respondBy: offsetDate(5) })
  const updated = db.getOffers()
  check('saving again updates in place', updated.offers.length, 2)
  check('the updated figure is used', updated.offers.find(o => o.applicationId === a).totalComp, 180000)

  // Input handling. A hostile or fat-fingered value must be clamped or
  // rejected, never stored raw.
  db.saveOffer(a, { baseSalary: -5, bonus: 'abc', excitement: 99, decision: 'nonsense', respondBy: 'not-a-date' })
  const cleaned = db.getOffers().offers.find(o => o.applicationId === a)
  check('a negative salary is clamped to zero', cleaned.base_salary, 0)
  check('a non-numeric bonus becomes null', cleaned.bonus, null)
  check('excitement is clamped to the 0–5 scale', cleaned.excitement, 5)
  check('an unknown decision falls back to considering', cleaned.decision, 'considering')
  check('a malformed date is not stored', cleaned.respond_by, null)
  check('an offer with no deadline has no countdown', cleaned.daysToRespond, null)

  // A past deadline on an undecided offer is the thing worth shouting about.
  db.saveOffer(b, { respondBy: offsetDate(-3) })
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
  db.saveOffer(a, { baseSalary: 180000, respondBy: offsetDate(5) })
  db.saveOffer(b, { baseSalary: 250000, decision: 'declined' })
  const decided = db.getOffers()
  check('a declined offer leaves the live count', decided.live, 1)
  check('a declined offer stays on the board', decided.offers.length, 2)
  // The larger figure belongs to the declined offer. `best` reports what is
  // still on the table, so it must ignore it.
  check('a declined offer does not set the best figure', decided.best, 180000)

  // Deleting the application takes its offer with it.
  db.deleteApplication(b)
  check('deleting an application removes its offer', db.getOffers().offers.length, 1)

  db.deleteOffer(a)
  check('an offer can be removed on its own', db.getOffers().offers.length, 0)
  check('removing the offer leaves the application', !!db.getApplication(a), true)

  check('today is a valid comparison anchor', typeof today(), 'string')
  done()
}

main()
