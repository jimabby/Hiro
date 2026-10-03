// Which country's Indeed is searched.
//
// The host was hardcoded to au.indeed.com in both the scraper and the login
// window. The value now comes from Settings, and it ends up in a URL the
// scraper visits with the user's session attached — so it is a closed list,
// and anything not on it falls back rather than being used as a host.

const { service, createChecker } = require('./helpers')
const { resolveIndeedRegion, indeedSearchUrl, listIndeedRegions } = service('scraper/indeedRegion')
const { check, done } = createChecker()

check('the default is Australia, as before', resolveIndeedRegion(undefined).host, 'au.indeed.com')
check('the US uses www', resolveIndeedRegion('us').host, 'www.indeed.com')
check('case is ignored', resolveIndeedRegion('UK').host, 'uk.indeed.com')
check('an unknown code falls back', resolveIndeedRegion('evil.example').host, 'au.indeed.com')
check('a prototype key is not a region', resolveIndeedRegion('__proto__').host, 'au.indeed.com')

check('the search goes to the chosen host',
  indeedSearchUrl({ indeedRegion: 'ca', jobKeywords: 'react', jobLocation: 'Toronto' }),
  'https://ca.indeed.com/jobs?q=react&l=Toronto')
check('a blank location is the region, not Australia',
  indeedSearchUrl({ indeedRegion: 'uk', jobKeywords: 'react' }),
  'https://uk.indeed.com/jobs?q=react&l=United%20Kingdom')
check('the Australian URL is unchanged from before',
  indeedSearchUrl({ jobKeywords: 'node dev', jobLocation: '', salaryMin: 90000 }),
  'https://au.indeed.com/jobs?q=node%20dev&l=Australia&salary=90000')
check('keywords are encoded', indeedSearchUrl({ jobKeywords: 'c++ & go' }).includes('q=c%2B%2B%20%26%20go'), true)

const regions = listIndeedRegions()
check('every region is on indeed.com', regions.every(r => /^[a-z]+\.indeed\.com$/.test(r.host)), true)
check('the Settings list has the same regions', regions.map(r => r.id).sort(),
  ['au', 'ca', 'de', 'ie', 'in', 'nl', 'nz', 'sg', 'uk', 'us'])

done()
