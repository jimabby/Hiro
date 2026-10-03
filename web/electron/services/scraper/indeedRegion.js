// Which Indeed to search.
//
// The scraper and the login window were both hardcoded to au.indeed.com, so
// Indeed was an Australian job board as far as Hiro was concerned — anyone
// searching anywhere else got Australian results for their keywords, or none.
//
// Each country is its own host with its own listings and its own login cookie
// scope, so this is a closed list rather than a free-text domain: the value
// ends up in a URL the scraper navigates to with the user's session attached,
// and that must never be a host the user did not mean.

const REGIONS = {
  au: { host: 'au.indeed.com', label: 'Australia' },
  nz: { host: 'nz.indeed.com', label: 'New Zealand' },
  us: { host: 'www.indeed.com', label: 'United States' },
  ca: { host: 'ca.indeed.com', label: 'Canada' },
  uk: { host: 'uk.indeed.com', label: 'United Kingdom' },
  ie: { host: 'ie.indeed.com', label: 'Ireland' },
  sg: { host: 'sg.indeed.com', label: 'Singapore' },
  in: { host: 'in.indeed.com', label: 'India' },
  de: { host: 'de.indeed.com', label: 'Germany' },
  nl: { host: 'nl.indeed.com', label: 'Netherlands' },
}

const DEFAULT_REGION = 'au'

function resolveIndeedRegion(code) {
  const key = String(code || '').trim().toLowerCase()
  const id = Object.prototype.hasOwnProperty.call(REGIONS, key) ? key : DEFAULT_REGION
  return { id, ...REGIONS[id] }
}

// The first results page for a search. A blank location used to become
// "Australia" whatever the region — now it is that region's own name.
function indeedSearchUrl({ indeedRegion, jobKeywords, jobLocation, salaryMin } = {}) {
  const region = resolveIndeedRegion(indeedRegion)
  const query = encodeURIComponent(jobKeywords || '')
  const location = encodeURIComponent(jobLocation || region.label)
  const salary = salaryMin ? `&salary=${encodeURIComponent(salaryMin)}` : ''
  return `https://${region.host}/jobs?q=${query}&l=${location}${salary}`
}

function listIndeedRegions() {
  return Object.entries(REGIONS).map(([id, r]) => ({ id, ...r }))
}

module.exports = { resolveIndeedRegion, indeedSearchUrl, listIndeedRegions, DEFAULT_REGION }
