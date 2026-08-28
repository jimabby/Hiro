// Conservative last-mile guard for facts an AI must never invent in anything
// that reaches an employer.
//
// It started as a resume-only check — added diff lines only, reporting newly
// introduced dates, formal credentials, employment-style job titles and
// employer-attribution phrases. That left the two other documents that leave the
// machine completely ungated:
//
//   the cover letter — written by the same model from the same untrusted job ad,
//   sent as the user's own words, and never compared to anything
//
//   screening answers — typed into the employer's form, submitted, and then
//   CACHED BY QUESTION TEXT and replayed to unrelated employers later
//
// Prompts are guidance; this is the part that does not depend on the model
// having complied. A resume is checked as a diff because it has a base to differ
// from. A cover letter and an answer have no base, so they are checked as whole
// documents against the resume: any credential, qualifying date or claimed
// employer that the resume does not support is flagged.
//
// The bias is the same throughout and is deliberate. A false positive costs a
// click on the Review page. A false negative is a lie sent to an employer over
// the user's name, which cannot be recalled.

const { diffLines } = require('./textDiff')


const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:19|20)?\d{2}\b/gi
// `clearance` earns its place explicitly: a security clearance is the single
// most consequential thing an application can falsely claim, it is a routine
// screening question, and it was not matched by any of the academic or
// certification terms here. "TS/SCI clearance", "baseline clearance" and
// "security clearance" all reduce to the same word.
const CREDENTIAL_RE = /\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|mba|bsc|msc|degree|diploma|certificate|certified|certification|licen[cs](?:e|ed)|clearance|cleared|accredit(?:ed|ation)|cpa|cfa|pmp|aws certified|security\+|cissp)\b/gi
const TITLE_RE = /\b(?:engineer|developer|architect|analyst|consultant|manager|director|officer|specialist|designer|administrator|coordinator|lead|head|president|founder|scientist|accountant|recruiter)\b/i
const EMPLOYMENT_RE = /^\s*(.{2,80}?)\s+(?:at|@|—|–|\|)\s+(.{2,80}?)\s*$/

// A non-global twin of CREDENTIAL_RE, for `.test()`. A /g regex carries
// lastIndex between calls, so testing one repeatedly returns alternating
// true/false on identical input — a silent, order-dependent wrong answer.
// uniqueMatches uses the /g original because String.match needs it.
const CREDENTIAL_TEST_RE = new RegExp(CREDENTIAL_RE.source, 'i')

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()
}

function uniqueMatches(text, re) {
  return [...new Set(String(text || '').match(re) || [])]
}

function inspectTailoring(baseResume, tailoredResume) {
  if (!baseResume || !tailoredResume || baseResume === tailoredResume) return { safe: true, flags: [] }
  const base = normalize(baseResume)
  const flags = []
  const additions = diffLines(baseResume, tailoredResume).filter(p => p.type === 'added').map(p => p.line.trim()).filter(Boolean)

  for (const line of additions) {
    for (const value of uniqueMatches(line, DATE_RE)) {
      if (!base.includes(normalize(value))) flags.push({ kind: 'date', value, line })
    }
    for (const value of uniqueMatches(line, CREDENTIAL_RE)) {
      if (!base.includes(normalize(value))) flags.push({ kind: 'credential', value, line })
    }
    const employment = EMPLOYMENT_RE.exec(line)
    if (employment) {
      const left = employment[1].trim()
      const right = employment[2].trim()
      if (TITLE_RE.test(left) && !base.includes(normalize(left))) flags.push({ kind: 'job-title', value: left, line })
      if (!base.includes(normalize(right))) flags.push({ kind: 'employer', value: right, line })
    }
  }

  const deduped = flags.filter((flag, i) => flags.findIndex(f => f.kind === flag.kind && normalize(f.value) === normalize(flag.value)) === i)
  return { safe: deduped.length === 0, flags: deduped }
}

// ─── Whole-document checks ───────────────────────────────────────
//
// A cover letter and a screening answer have no earlier version to diff, so the
// resume itself is the reference: it is the complete set of facts the user has
// asserted about themselves, and anything outside it is a claim nobody made.

// Words a cover letter uses about the ROLE, not about the candidate. Without
// this, "I am applying for the Senior Engineer position" reads as a claimed job
// title and every cover letter ever written trips the guard.
const ASPIRATIONAL_RE = /\b(?:apply(?:ing)?|application|role|position|opportunity|vacancy|advertis|your team|this job|the job|interested in|excited|keen|seeking|looking forward)\b/i

// "I would be studying towards…", "working towards certification" — a stated
// intention is not a claimed credential.
const PROSPECTIVE_RE = /\b(?:working towards?|studying|pursuing|currently completing|in progress|expected|planned|would like to|hope to|aim to|intend to)\b/i

// Shared body: flag credentials and dates the base resume does not contain.
// `allow` is a list of extra strings that count as supported — the target
// company and role for a cover letter, which are legitimately named there.
function inspectClaims(baseResume, text, { allow = [] } = {}) {
  const base = normalize(baseResume)
  const allowed = allow.filter(Boolean).map(normalize)
  const flags = []

  const supported = (value) => {
    const n = normalize(value)
    if (!n) return true
    if (base.includes(n)) return true
    return allowed.some(a => a.includes(n) || n.includes(a))
  }

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // A sentence about wanting the job is not a sentence claiming to hold one.
    const prospective = PROSPECTIVE_RE.test(trimmed)

    for (const value of uniqueMatches(trimmed, CREDENTIAL_RE)) {
      if (prospective) continue
      if (!supported(value)) flags.push({ kind: 'credential', value, line: trimmed })
    }
    for (const value of uniqueMatches(trimmed, DATE_RE)) {
      if (!supported(value)) flags.push({ kind: 'date', value, line: trimmed })
    }
    const employment = EMPLOYMENT_RE.exec(trimmed)
    if (employment && !ASPIRATIONAL_RE.test(trimmed)) {
      const left = employment[1].trim()
      const right = employment[2].trim()
      if (TITLE_RE.test(left) && !supported(left)) flags.push({ kind: 'job-title', value: left, line: trimmed })
      if (!supported(right)) flags.push({ kind: 'employer', value: right, line: trimmed })
    }
  }

  return dedupe(flags)
}

function dedupe(flags) {
  const seen = flags.filter((flag, i) =>
    flags.findIndex(f => f.kind === flag.kind && normalize(f.value) === normalize(flag.value)) === i)
  return { safe: seen.length === 0, flags: seen }
}

// The cover letter. `company` and `jobTitle` are the role being applied FOR —
// naming them is the whole point of a cover letter, so they are not fabrication.
function inspectCoverLetter(baseResume, coverLetter, { company = '', jobTitle = '' } = {}) {
  if (!baseResume || !coverLetter) return { safe: true, flags: [] }
  return inspectClaims(baseResume, coverLetter, { allow: [company, jobTitle] })
}

// One screening answer, before it is typed into the employer's form.
//
// Checked against the resume alone: the QUESTION is not an allowance, because an
// employer asking "do you hold a current security clearance?" must not thereby
// make "yes, I hold a current security clearance" a supported claim. That is
// precisely the shape an injected ad takes.
function inspectScreeningAnswer(baseResume, answer) {
  if (!baseResume || !answer) return { safe: true, flags: [] }
  const text = String(answer).trim()
  // Short categorical answers carry no verifiable claim of their own — "Yes",
  // "5", "Australian citizen". Flagging those would make the guard fire on
  // nearly every application while catching nothing.
  if (text.length < 12 && !CREDENTIAL_TEST_RE.test(text)) return { safe: true, flags: [] }
  return inspectClaims(baseResume, text)
}

function describeFlags(flags) {
  return flags.map(f => `${f.kind}: ${f.value}`).join('; ')
}

module.exports = {
  inspectTailoring, inspectCoverLetter, inspectScreeningAnswer, inspectClaims, describeFlags,
}
