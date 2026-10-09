// Reading an application form: what each field is asking for.
//
// Pure functions, kept apart from the browser driver so the decisions — which
// field gets the email address, which question is never answered on the
// user's behalf — can be tested without launching Chromium.

// Greenhouse, Lever, Ashby and Workday each render one form layout for every
// employer that uses them. That is what makes filling them worth doing: the
// labels are the same words in the same places, so the heuristics below hit far
// more often than they would on a bespoke careers page. Anything else is
// treated as 'generic' and gets the same label matching with lower expectations.
function detectAts(url) {
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return 'generic' }
  if (/(^|\.)greenhouse\.io$/.test(host)) return 'greenhouse'
  if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) return 'lever'
  if (host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com')) return 'ashby'
  if (/\.myworkdayjobs\.com$/.test(host) || /\.myworkdaysite\.com$/.test(host)) return 'workday'
  if (/\.smartrecruiters\.com$/.test(host)) return 'smartrecruiters'
  if (/\.workable\.com$/.test(host)) return 'workable'
  return 'generic'
}

// Where the form itself lives. Lever and Ashby put the posting and the form on
// separate URLs; opening the posting would leave the user one click short and
// the filler with nothing to fill.
function formUrlFor(url) {
  const ats = detectAts(url)
  try {
    const u = new URL(url)
    const trimmed = u.pathname.replace(/\/+$/, '')
    if (ats === 'lever' && !/\/apply$/.test(trimmed)) u.pathname = `${trimmed}/apply`
    if (ats === 'ashby' && !/\/application$/.test(trimmed)) u.pathname = `${trimmed}/application`
    return u.toString()
  } catch {
    return url
  }
}

// Equal-opportunity monitoring questions. Never answered for the user, not
// even with "decline to self-identify": what someone discloses about their
// gender, ethnicity, disability or veteran status is theirs to choose each time,
// and a default chosen by software is still a choice made for them.
const EEO_RE = /\b(gender|sex\b|pronouns?|race|racial|ethnic|ethnicity|hispanic|latino|veteran|disabilit|sexual orientation|transgender|lgbt|aboriginal|torres strait|indigenous|religio|date of birth|\bage\b|marital)/i

// Things that are not questions about the candidate at all.
const SKIP_RE = /\b(captcha|password|confirm password|security code|verification code|i am not a robot|search)\b/i

// Consent and attestation checkboxes ("I certify that…", "I agree to the
// privacy policy"). Legal statements the user must make themselves.
const CONSENT_RE = /\b(i (?:agree|certify|confirm|acknowledge|consent|understand|attest)|terms|privacy (?:policy|notice)|consent)\b/i

const CONTACT_RULES = [
  ['firstName', /\b(first|given|forename|preferred first) ?name\b/i],
  ['lastName', /\b(last|family|sur) ?name\b|\bsurname\b/i],
  ['fullName', /^\s*(full )?name\s*\*?\s*$|\byour name\b|\bfull name\b|\blegal name\b/i],
  ['email', /\be-?mail\b/i],
  ['phone', /\b(phone|mobile|telephone|cell)\b/i],
  ['linkedin', /\blinked ?in\b/i],
  ['github', /\bgit ?hub\b/i],
  ['portfolio', /\b(portfolio|personal (web)?site|website|blog)\b/i],
  ['location', /^\s*(current )?(location|city|suburb)\b|\bwhere are you (located|based)\b/i],
]

// What a field wants. `label` is the visible question; `type` the input type
// ('text', 'email', 'tel', 'file', 'textarea', 'select', 'radio', 'checkbox').
function classifyField({ label = '', type = 'text', name = '' } = {}) {
  const text = `${label} ${name}`.replace(/\s+/g, ' ').trim()
  if (!text && type !== 'file') return { kind: 'skip', reason: 'no label' }
  if (SKIP_RE.test(text)) return { kind: 'skip', reason: 'not about the candidate' }
  if (EEO_RE.test(label)) return { kind: 'eeo' }

  if (type === 'file') {
    if (/cover/i.test(text)) return { kind: 'coverLetterFile' }
    if (/resume|résumé|\bcv\b|curriculum/i.test(text) || !text) return { kind: 'resumeFile' }
    return { kind: 'skip', reason: 'an attachment Hiro does not have' }
  }

  if (type === 'checkbox' && CONSENT_RE.test(label)) return { kind: 'consent' }

  if (/cover letter/i.test(text) && (type === 'textarea' || type === 'text')) return { kind: 'coverLetterText' }

  // Contact fields are matched on the label, and the input type is a strong
  // second signal: a type="email" box is the email whatever it is called.
  if (type === 'email') return { kind: 'contact', key: 'email' }
  if (type === 'tel') return { kind: 'contact', key: 'phone' }
  for (const [key, re] of CONTACT_RULES) {
    if (re.test(label) || (label.length < 3 && re.test(name))) return { kind: 'contact', key }
  }

  return { kind: 'question' }
}

// Choose the option that best matches an answer, for a select or radio group.
// Exact match first, then containment either way, then the most shared words.
// Returns null rather than a weak guess — an unfilled dropdown is highlighted
// for the user; a wrong one may be submitted unnoticed.
function pickOption(answer, options = []) {
  const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
  const a = norm(answer)
  if (!a) return null
  const opts = options.map(o => ({ raw: o, n: norm(o) })).filter(o => o.n && !/^(select|choose|please select)/.test(o.n))
  const exact = opts.find(o => o.n === a)
  if (exact) return exact.raw
  // Yes / No answers lead with the word.
  const lead = a.split(' ')[0]
  if (lead === 'yes' || lead === 'no') {
    const yn = opts.find(o => o.n === lead || o.n.startsWith(`${lead} `))
    if (yn) return yn.raw
  }
  const contained = opts.filter(o => a.includes(o.n) || o.n.includes(a))
  if (contained.length === 1) return contained[0].raw
  const words = new Set(a.split(' ').filter(w => w.length > 2))
  let best = null
  let bestScore = 0
  for (const o of opts) {
    const score = o.n.split(' ').filter(w => words.has(w)).length
    if (score > bestScore) { best = o; bestScore = score }
    else if (score === bestScore) best = null
  }
  return bestScore >= 1 && best ? best.raw : null
}

// The page an ATS shows after a real submission. Matched on the confirmation
// wording these platforms use, never on the URL alone, because an employer can
// route the form anywhere.
const SUBMITTED_RE = /\b(thank(?:s| you) for (?:applying|your application|your interest)|application (?:has been |was )?(?:submitted|received|sent)|we(?:'ve| have) received your application|your application is (?:in|complete))\b/i

function looksSubmitted(pageText) {
  return SUBMITTED_RE.test(String(pageText || '').slice(0, 20000))
}

module.exports = { detectAts, formUrlFor, classifyField, pickOption, looksSubmitted, EEO_RE }
