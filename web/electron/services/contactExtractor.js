// Pull a recruiter's contact address out of a job ad or a reply email.
//
// Auto follow-up needs somewhere to send. Nothing ever populated
// recruiter_email automatically, so the follow-up pass skipped effectively
// every application and the feature looked broken rather than unconfigured.
//
// Deliberately conservative: a wrong address means mailing a stranger, so an
// ambiguous ad yields nothing rather than a guess. The user can always set the
// address by hand in the job detail panel.

// Addresses that are never a person to follow up with.
const NOREPLY_RE = /^(no[-._]?reply|do[-._]?not[-._]?reply|donotreply|bounce|mailer[-._]?daemon|postmaster|notifications?|alerts?|automated|system|support|help ?desk|billing|abuse|unsubscribe)@/i

// Domains belonging to the job platforms themselves, or to generic senders.
// A Seek notification address is not the employer's recruiter.
const PLATFORM_DOMAINS = [
  'seek.com.au', 'seek.co.nz', 'seek.com', 'indeed.com', 'indeedemail.com',
  'linkedin.com', 'noreply.linkedin.com', 'glassdoor.com', 'ziprecruiter.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkday.com',
  'jobvite.com', 'smartrecruiters.com', 'bamboohr.com', 'taleo.net',
]

// Free mail providers. An ad quoting a gmail address is usually a scam or a
// personal address scraped from body text, not an employer's ATS contact —
// but it's still the best (and often only) address available, so it's accepted
// at lower confidence rather than discarded.
const FREEMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
]

// RFC-ish, deliberately narrower than the spec — we want confident matches.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g

// Text near an address that marks it as the right one to write to.
const APPLY_CONTEXT_RE = /(apply|application|enquir|inquir|question|contact|email|send|resume|cv|recruit|hiring|talent|careers?|hr)/i

function domainOf(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || ''
}

function isPlatformDomain(domain) {
  return PLATFORM_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))
}

function isFreemail(domain) {
  return FREEMAIL_DOMAINS.includes(domain)
}

// Normalise a company name to the tokens that could plausibly appear in its
// mail domain ("Acme Health Pty Ltd" → ["acme", "health"]).
const COMPANY_NOISE = new Set([
  'pty', 'ltd', 'limited', 'inc', 'llc', 'corp', 'corporation', 'co', 'company',
  'group', 'holdings', 'the', 'and', 'of', 'international', 'global', 'australia',
])

function companyTokens(company) {
  return String(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !COMPANY_NOISE.has(w))
}

// Score a candidate address. Higher is better; anything at or below 0 is
// rejected outright.
function scoreCandidate(email, text, company) {
  const domain = domainOf(email)
  if (!domain) return -1
  if (NOREPLY_RE.test(email)) return -1
  if (isPlatformDomain(domain)) return -1
  // Obvious placeholders in template ads.
  if (/^(example|test|your|name|firstname|lastname|email)@/i.test(email)) return -1
  if (/(example|test|domain|yourcompany|company)\.(com|org|net)$/i.test(domain)) return -1

  let score = 1

  // The address's domain matching the employer's name is the strongest signal
  // available that this is really their recruiter.
  const tokens = companyTokens(company)
  const bare = domain.replace(/\./g, '')
  if (tokens.some(t => t.length >= 4 && bare.includes(t))) score += 4
  else if (isFreemail(domain)) score -= 1

  // A recruiting-shaped local part.
  if (/^(careers?|jobs?|recruit\w*|hiring|talent|hr|people|apply|applications?)@/i.test(email)) score += 2

  // Words around the address that say "write here to apply".
  const at = text.indexOf(email)
  if (at >= 0) {
    const window = text.slice(Math.max(0, at - 140), at + email.length + 60)
    if (APPLY_CONTEXT_RE.test(window)) score += 2
  }

  return score
}

// Best contact address in a job description, or '' when nothing is confident
// enough. `company` sharpens the result but is optional.
function extractRecruiterEmail(text, { company = '' } = {}) {
  const body = String(text || '')
  if (!body) return ''

  const seen = new Set()
  let best = ''
  let bestScore = 0

  for (const raw of body.match(EMAIL_RE) || []) {
    // Trailing punctuation frequently rides along ("email jane@acme.com.")
    const email = raw.replace(/[.,;:]+$/, '').toLowerCase()
    if (seen.has(email)) continue
    seen.add(email)

    const score = scoreCandidate(email, body, company)
    if (score > bestScore) { bestScore = score; best = email }
  }

  // A bare freemail address with no supporting context isn't worth mailing.
  return bestScore >= 2 ? best : ''
}

// The sender of a recruiter's reply is a far better contact than anything
// parsed out of an ad — it's a human who already wrote to us. Used by the
// inbox check when it matches a reply to an application.
function recruiterEmailFromReply(fromAddress, { company = '' } = {}) {
  const email = String(fromAddress || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return ''
  const domain = domainOf(email)
  if (NOREPLY_RE.test(email)) return ''
  if (isPlatformDomain(domain)) return ''
  // No context window to score against here, so accept any real human sender.
  // The reply already proved the address routes to someone who read our
  // application, which is the whole point.
  void company
  return email
}

module.exports = {
  extractRecruiterEmail,
  recruiterEmailFromReply,
  // exported for tests
  isPlatformDomain,
  companyTokens,
}
