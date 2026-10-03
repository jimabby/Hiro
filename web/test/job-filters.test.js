// The cheap, local reasons not to score a job: the user's excluded keywords
// and their remote / hybrid preference. Both run before any model call, so a
// false positive here silently discards a real job — the cases below are
// mostly about NOT excluding things.

const { service, createChecker } = require('./helpers')
const { parseKeywordList, excludedKeyword, workArrangement, matchesWorkPreference } = service('jobFilters')
const { check, done } = createChecker()

// ─── Parsing the list ────────────────────────────────────────────
check('commas split the list', parseKeywordList('senior, clearance'), ['senior', 'clearance'])
check('new lines split it too', parseKeywordList('senior\nclearance'), ['senior', 'clearance'])
check('blanks and duplicates are dropped', parseKeywordList(' Senior , ,senior,'), ['senior'])
check('an array is accepted', parseKeywordList(['Lead', 'lead']), ['lead'])
check('nothing configured is an empty list', parseKeywordList(undefined), [])

// ─── Excluded keywords ───────────────────────────────────────────
const job = (title, company = 'Acme') => ({ job_title: title, company })
check('a title word excludes', excludedKeyword(job('Senior Software Engineer'), 'senior'), 'senior')
check('case does not matter', excludedKeyword(job('SENIOR engineer'), 'Senior'), 'senior')
check('the company is checked', excludedKeyword(job('Engineer', 'Hays Recruitment'), 'recruitment'), 'recruitment')
check('a phrase works', excludedKeyword(job('Security Clearance Required — Analyst'), 'security clearance'), 'security clearance')
check('punctuation is a boundary', excludedKeyword(job('Engineer (Senior)'), 'senior'), 'senior')
check('"lead" does not exclude "Leadership"', excludedKeyword(job('Leadership Development Manager'), 'lead'), null)
check('"intern" does not exclude "International"', excludedKeyword(job('International Sales Engineer'), 'intern'), null)
check('"sr" does not exclude "Srinivasan Ltd"', excludedKeyword(job('Engineer', 'Srinivasan Ltd'), 'sr'), null)
check('no list excludes nothing', excludedKeyword(job('Senior Engineer'), ''), null)
check('regex characters are literal', excludedKeyword(job('C++ Developer'), 'c++'), 'c++')
check('a dot is literal too', excludedKeyword(job('Senior Engineer'), 's.nior'), null)
check('a missing title is not a crash', excludedKeyword({}, 'senior'), null)

// ─── Reading the work arrangement ────────────────────────────────
check('remote', workArrangement('This is a fully remote role.'), 'remote')
check('work from home is remote', workArrangement('Work from home anywhere in Australia'), 'remote')
check('WFH is remote', workArrangement('Flexible WFH'), 'remote')
check('hybrid', workArrangement('Hybrid — 3 days in the office'), 'hybrid')
check('hybrid wins when remote days are mentioned', workArrangement('Hybrid role with 2 remote days a week'), 'hybrid')
check('office days imply hybrid', workArrangement('Expect 2 days a week in the office'), 'hybrid')
check('on-site', workArrangement('This role is on-site in Parramatta.'), 'onsite')
check('office-based', workArrangement('An office-based position'), 'onsite')
check('"not a remote role" is on-site', workArrangement('Please note this is not a remote role.'), 'onsite')
check('"non-remote" is on-site', workArrangement('Non-remote position'), 'onsite')
check('silence is unknown', workArrangement('Build reliable software.'), 'unknown')
check('empty is unknown', workArrangement(''), 'unknown')

// ─── Applying the preference ─────────────────────────────────────
const listing = { job_title: 'Engineer' }
check('"any" keeps an on-site job', matchesWorkPreference('any', listing, 'on-site').ok, true)
check('no preference keeps everything', matchesWorkPreference(undefined, listing, 'on-site').ok, true)
check('remote-only keeps a remote job', matchesWorkPreference('remote', listing, 'Fully remote').ok, true)
check('remote-only drops an on-site job', matchesWorkPreference('remote', listing, 'Office-based').ok, false)
check('remote-only drops a hybrid job', matchesWorkPreference('remote', listing, 'Hybrid').ok, false)
check('flexible keeps a hybrid job', matchesWorkPreference('flexible', listing, 'Hybrid').ok, true)
check('flexible drops an on-site job', matchesWorkPreference('flexible', listing, 'On-site only').ok, false)
check('a job that never says is kept', matchesWorkPreference('remote', listing, 'Build software.').ok, true)
check('and is reported as unknown', matchesWorkPreference('remote', listing, 'Build software.').arrangement, 'unknown')
check('the listing is read before the description',
  matchesWorkPreference('remote', { job_title: 'Engineer (Remote)' }, 'Our office is in Sydney, on-site parking').ok, true)
check('a location badge counts',
  matchesWorkPreference('remote', { job_title: 'Engineer', location: 'Hybrid · Melbourne' }, '').arrangement, 'hybrid')

done()
