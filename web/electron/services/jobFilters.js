// Cheap, local reasons not to look at a job at all.
//
// Every listing that reaches the scorer costs a model call, and the scorer is a
// poor way to say "never senior roles" or "remote only" — it is asked how good
// a match a job is, not whether the user would ever take it, so a strong
// candidate for a senior on-site role still scores well and still gets drafted.
// These run before any of that spend.

// ─── Excluded keywords ───────────────────────────────────────────

function parseKeywordList(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[,\n]/)
  const seen = new Set()
  const out = []
  for (const raw of parts) {
    const k = String(raw || '').trim().toLowerCase()
    if (k && !seen.has(k)) { seen.add(k); out.push(k) }
  }
  return out
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whole words, not substrings. "lead" must not exclude "Leadership
// Development Manager" any more than "intern" should exclude "International
// Sales"; a substring test would silently throw away real jobs, and a silently
// discarded job is the expensive mistake here.
function keywordPattern(keyword) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}($|[^\\p{L}\\p{N}])`, 'iu')
}

// The first excluded keyword found in the job's title or company, or null.
// The description is deliberately not searched: "you'll work alongside senior
// engineers" appears in junior ads, and excluding on it would empty the feed.
function excludedKeyword(job, keywords) {
  const list = parseKeywordList(keywords)
  if (list.length === 0) return null
  const haystack = `${job?.job_title || ''}\n${job?.company || ''}`
  return list.find(k => keywordPattern(k).test(haystack)) || null
}

// ─── Work arrangement ────────────────────────────────────────────

const NOT_REMOTE = /\b(?:not|no|non)[- ]remote\b|\bisn'?t (?:a )?remote\b|\bis not (?:a )?remote\b|\bremote work is not (?:available|offered|possible)\b/i
const HYBRID = /\bhybrid\b|\b\d\s*days? (?:a|per) week (?:in|at) (?:the )?office\b|\bsplit between (?:home|remote) and (?:the )?office\b/i
const REMOTE = /\b(?:fully |100% |full[- ]time )?remote\b|\bwork(?:ing)? from (?:home|anywhere)\b|\bwfh\b|\btelecommut/i
const ONSITE = /\bon[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b|\bin[- ]person\b/i

// What a listing says about where the work happens: 'remote', 'hybrid',
// 'onsite', or 'unknown' when it does not say. Hybrid wins over remote because
// hybrid ads almost always mention remote days too.
function workArrangement(text) {
  const t = String(text || '')
  if (!t.trim()) return 'unknown'
  if (NOT_REMOTE.test(t)) return HYBRID.test(t) ? 'hybrid' : 'onsite'
  if (HYBRID.test(t)) return 'hybrid'
  if (REMOTE.test(t)) return 'remote'
  if (ONSITE.test(t)) return 'onsite'
  return 'unknown'
}

// 'any'      — no filtering (the default)
// 'remote'   — remote only
// 'flexible' — remote or hybrid
const PREFERENCES = ['any', 'remote', 'flexible']
const ACCEPTS = {
  remote: new Set(['remote']),
  flexible: new Set(['remote', 'hybrid']),
}

// Should this job be scored, given the user's preference?
//
// The listing's own fields are read first (title, location, any work-type
// badge the scraper captured), then the description. A job that never says is
// KEPT: plenty of genuine remote roles only mention it in a line the regexes
// do not catch, and the scorer still reads the whole description.
function matchesWorkPreference(preference, job, description = '') {
  const accepts = ACCEPTS[preference]
  if (!accepts) return { ok: true, arrangement: 'unknown' }
  const listing = [job?.job_title, job?.location, job?.work_type].filter(Boolean).join('\n')
  let arrangement = workArrangement(listing)
  if (arrangement === 'unknown') arrangement = workArrangement(description)
  if (arrangement === 'unknown') return { ok: true, arrangement }
  return { ok: accepts.has(arrangement), arrangement }
}

// ─── Blocked companies ───────────────────────────────────────────
// The block list used to match the company name exactly, so blocking "Acme"
// did nothing about "Acme Pty Ltd" or "ACME Group" — the same employer, under
// the legal or regional suffix one board happens to print. Names are compared
// with those suffixes, punctuation and case taken off.
//
// Still equality, not a substring or prefix test: blocking "Bank" must not
// quietly remove "Bank of Queensland" and every other bank with it, and a job
// thrown away without being shown is the expensive mistake here.
const COMPANY_SUFFIXES = new Set([
  'pty', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'group', 'holdings',
  'australia', 'aust', 'au', 'nz', 'anz',
])

function companyKey(name) {
  const plain = String(name ?? '').trim().toLowerCase()
  const words = plain
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(' ').filter(Boolean)
  if (words[0] === 'the' && words.length > 1) words.shift()
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop()
  // A name made only of suffix words ("The Company") keeps what it had.
  return words.join(' ') || plain
}

// The block-list entry this company matches, or null.
function blockedCompany(company, list) {
  const key = companyKey(company)
  if (!key) return null
  for (const entry of Array.isArray(list) ? list : []) {
    if (String(entry ?? '').trim() && companyKey(entry) === key) return String(entry)
  }
  return null
}

// ─── Eligibility ─────────────────────────────────────────────────
// Some ads rule the candidate out before anything else is read: citizens only,
// no visa sponsorship, a security clearance already held. A model asked "how
// good a match is this?" still scores those well, and the scan then pays to
// tailor a résumé and write a letter for an application that will be binned on
// the first line of the form.
//
// The user states the facts once (Settings → Job criteria → Eligibility), and
// an ad is skipped only when it states a requirement those facts plainly fail.
// Deliberately narrow, like the profile matcher: an ad that merely MENTIONS
// citizenship or sponsorship ("we welcome applications from all", "sponsorship
// may be available") is kept, because a real job silently skipped is worse than
// one more scoring call.

const WORK_STATUSES = ['citizen', 'permanent', 'visa']

// Sentence-ish windows, so "no" in one sentence never pairs with "sponsorship"
// in the next.
const sentences = text => String(text || '').split(/(?<=[.!?;\n•])\s+/)

const CITIZEN_ONLY = [
  /\b(?:must|need to|required to|will need to) (?:be|hold)\b[^.]{0,30}\bcitizen(?:s|ship)?\b(?![^.]{0,40}\b(?:or|and\/or)\b[^.]{0,30}\b(?:permanent|pr|resident|visa|work rights|working rights)\b)/i,
  /\bcitizens? only\b/i,
  /\bonly (?:open|available) to\b[^.]{0,30}\bcitizens?\b(?![^.]{0,40}\b(?:or|and\/or)\b[^.]{0,30}\b(?:permanent|pr|resident)\b)/i,
  /\bcitizenship (?:is )?(?:required|mandatory|essential)\b/i,
]

const CITIZEN_OR_PR = [
  /\b(?:must|need to|required to) (?:be|hold)\b[^.]{0,30}\bcitizen(?:s|ship)?\b[^.]{0,30}\b(?:or|and\/or)\b[^.]{0,30}\bpermanent resid/i,
  /\b(?:citizens?|citizenship) or permanent resid(?:ents?|ency)\b[^.]{0,40}\b(?:only|required|must|essential|mandatory)\b/i,
  /\b(?:only (?:open|available) to)\b[^.]{0,30}\b(?:citizens?|citizenship) (?:or|and) permanent resid/i,
  /\bpermanent residency (?:is )?(?:required|mandatory|essential)\b/i,
]

const NO_SPONSORSHIP = [
  // "…who do not require sponsorship" describes the applicant, not the
  // employer's policy, so a "not" followed by require/need does not count.
  /\b(?:no|not|unable to|cannot|can't|can ?not|will not|won't|do not|don't|does not|doesn't|are not able to)\b(?!\s+(?:require|need)s?\b)[^.]{0,40}\bsponsor(?:s|ship|ed|ing)?\b/i,
  /\bsponsorship\b[^.]{0,30}\b(?:is )?(?:not (?:available|offered|provided|possible)|unavailable)\b/i,
  /\bwithout (?:the need for |requiring )?(?:visa |employer )?sponsorship\b/i,
]

const CLEARANCE_HELD = [
  /\b(?:must|need to|required to)\b[^.]{0,20}\b(?:hold|have|possess)\b[^.]{0,30}\b(?:current|active|existing|valid)?\s*(?:baseline|nv1|nv2|pv|negative vetting|positive vetting|ts\/sci|top secret|secret|security)\s*(?:security )?clearance\b/i,
  /\b(?:current|active|existing)\s+(?:baseline|nv1|nv2|pv|negative vetting|ts\/sci|top secret|secret|security)?\s*(?:security )?clearance\b[^.]{0,30}\b(?:required|essential|mandatory|is a must)\b/i,
  /\bclearance\b[^.]{0,20}\b(?:required|essential|mandatory)\b(?![^.]{0,40}\b(?:obtain|able to|willing|eligible)\b)/i,
]

const someSentence = (text, patterns) => sentences(text).find(s => patterns.some(re => re.test(s))) || null

// A normalised copy of the eligibility settings, or null when the filter is off
// or nothing has been stated.
function eligibilityFacts(cfg) {
  const e = cfg?.eligibility
  if (!e || typeof e !== 'object' || !e.enabled) return null
  const facts = {
    workStatus: WORK_STATUSES.includes(e.workStatus) ? e.workStatus : '',
    needsSponsorship: e.needsSponsorship === true,
    holdsClearance: e.holdsClearance === true,
  }
  return facts.workStatus || facts.needsSponsorship || e.holdsClearance === false ? facts : null
}

// Why this job is out of reach, or null when it is not (or the filter is off).
// Returns { reason, quote } — the quote is the ad's own sentence, for the log.
function eligibilityBlock(cfg, job, description = '') {
  const facts = eligibilityFacts(cfg)
  if (!facts) return null
  const text = `${job?.job_title || ''}\n${description || ''}`
  const quote = s => s.trim().replace(/\s+/g, ' ').slice(0, 160)

  if (facts.workStatus && facts.workStatus !== 'citizen') {
    const hit = someSentence(text, CITIZEN_ONLY)
    if (hit) return { reason: 'citizens only', quote: quote(hit) }
  }
  if (facts.workStatus === 'visa') {
    const hit = someSentence(text, CITIZEN_OR_PR)
    if (hit) return { reason: 'citizens or permanent residents only', quote: quote(hit) }
  }
  if (facts.needsSponsorship) {
    const hit = someSentence(text, NO_SPONSORSHIP)
    if (hit) return { reason: 'no visa sponsorship', quote: quote(hit) }
  }
  if (!facts.holdsClearance && cfg?.eligibility?.holdsClearance === false) {
    const hit = someSentence(text, CLEARANCE_HELD)
    if (hit) return { reason: 'an existing security clearance is required', quote: quote(hit) }
  }
  return null
}

module.exports = {
  parseKeywordList, excludedKeyword,
  workArrangement, matchesWorkPreference, PREFERENCES,
  companyKey, blockedCompany,
  eligibilityBlock, eligibilityFacts, WORK_STATUSES,
}
