// The selector probe.
//
// This decides whether a scraper reports "the market is quiet" or "the jobTitle
// selector moved". The threshold matters in both directions: too eager and a
// listing without a salary looks like a broken scraper; too shy and a genuine
// break goes on reporting zero results forever.

const { createSelectorProbe } = require('../electron/services/scraper/utils')
const { createChecker } = require('./helpers')
const { check, done } = createChecker()

// A selector nobody tried is not a selector that failed.
{
  const probe = createSelectorProbe('Seek')
  check('an unused probe reports nothing stale', probe.report().stale, [])
  check('an unused probe still names its platform', probe.report().platform, 'Seek')
}

// One or two misses is ordinary: plenty of real listings are missing a field.
{
  const probe = createSelectorProbe('Seek')
  probe.record('jobTitle', false)
  probe.record('jobTitle', false)
  check('two misses is not yet evidence', probe.report().stale, [])
}

// Three attempts with no match at all is the signal.
{
  const probe = createSelectorProbe('Seek')
  for (let i = 0; i < 3; i++) probe.record('jobTitle', false)
  check('three misses with no hit is stale', probe.report().stale, ['jobTitle'])
}

// A single hit clears it. A selector that matched even once has not moved —
// that is a listing that genuinely lacked the field.
{
  const probe = createSelectorProbe('Seek')
  for (let i = 0; i < 20; i++) probe.record('jobSalary', false)
  probe.record('jobSalary', true)
  check('one hit in twenty is not a broken selector', probe.report().stale, [])
}

// Independent per selector: one field breaking must not implicate the others.
{
  const probe = createSelectorProbe('Indeed')
  for (let i = 0; i < 5; i++) {
    probe.record('jobTitle', true)
    probe.record('companyName', false)
  }
  const report = probe.report()
  check('only the broken selector is flagged', report.stale, ['companyName'])
  check('the working selector records its hits',
    report.selectors.find(s => s.name === 'jobTitle').hit, 5)
  check('the broken selector records its attempts',
    report.selectors.find(s => s.name === 'companyName').tried, 5)
}

// `seen` is the wrapper the scrapers actually use: it passes the value straight
// through so it can wrap a lookup inline, and judges emptiness on the way.
{
  const probe = createSelectorProbe('Seek')
  check('seen returns the value unchanged', probe.seen('jobTitle', 'Engineer'), 'Engineer')
  check('seen passes an empty string through', probe.seen('jobTitle', ''), '')
  check('seen passes null through', probe.seen('jobTitle', null), null)
  const report = probe.report()
  check('an empty string counts as a miss',
    report.selectors.find(s => s.name === 'jobTitle').hit, 1)
  check('every attempt is counted',
    report.selectors.find(s => s.name === 'jobTitle').tried, 3)
}

// An empty array is a miss — `page.$$` returning nothing is exactly the case
// this exists to catch, and truthiness alone would call it a hit.
{
  const probe = createSelectorProbe('Seek')
  for (let i = 0; i < 3; i++) probe.seen('cards', [])
  check('an empty array is a miss', probe.report().stale, ['cards'])
}
{
  const probe = createSelectorProbe('Seek')
  probe.seen('cards', ['a', 'b'])
  check('a populated array is a hit', probe.report().stale, [])
}

// Zero is a real value, not an absence — flagging it would misreport any
// numeric field that legitimately reads zero.
{
  const probe = createSelectorProbe('Seek')
  for (let i = 0; i < 3; i++) probe.seen('count', 0)
  check('zero is a real value, not a miss', probe.report().stale, [])
}

done()
