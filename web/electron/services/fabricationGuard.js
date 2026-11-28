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
const { tickedMatchers, tickedIn } = require('./skillCatalog')


const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:19|20)?\d{2}\b/gi
// `clearance` earns its place explicitly: a security clearance is the single
// most consequential thing an application can falsely claim, it is a routine
// screening question, and it was not matched by any of the academic or
// certification terms here. "TS/SCI clearance", "baseline clearance" and
// "security clearance" all reduce to the same word.
const CREDENTIAL_RE = /\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|mba|bsc|msc|degree|diploma|certificate|certified|certification|licen[cs](?:e|ed)|clearance|cleared|accredit(?:ed|ation)|cpa|cfa|pmp|aws certified|security\+|cissp)\b/gi
const TITLE_RE = /\b(?:engineer|developer|architect|analyst|consultant|manager|director|officer|specialist|designer|administrator|coordinator|lead|head|president|founder|scientist|accountant|recruiter)\b/i
const EMPLOYMENT_RE = /^\s*(.{2,80}?)\s+(?:at|@|—|–|\|)\s+(.{2,80}?)\s*$/
// The employer is captured to the end of the line, so "…pipelines at Acme."
// carried the sentence's full stop, and "acme." is not in a résumé that says
// "Acme" — every cover letter ending a sentence on an employer was flagged.
const employerOf = (captured) => captured.trim().replace(/[.,;:!?)\]]+$/, '')

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

// A credential a line takes from a skill the user ticked in Settings as true
// (config.extraSkills): "licence" is supported in "a current driver's licence"
// when Driver's licence is ticked, and still not in "an electrician's licence".
function tickedCovers(line, value, ticked) {
  const n = normalize(value)
  return !!n && tickedIn(line, ticked).some(text => normalize(text).includes(n))
}

// `extraSkills` is config.extraSkills: names the user has ticked as true though
// no résumé lists them. They may appear on a skills line or in the summary.
function inspectTailoring(baseResume, tailoredResume, { extraSkills = [] } = {}) {
  if (!baseResume || !tailoredResume || baseResume === tailoredResume) return { safe: true, flags: [] }
  const base = normalize(baseResume)
  const ticked = tickedMatchers(extraSkills)
  const flags = []
  const additions = diffLines(baseResume, tailoredResume).filter(p => p.type === 'added').map(p => p.line.trim()).filter(Boolean)

  for (const line of additions) {
    for (const value of uniqueMatches(line, DATE_RE)) {
      if (!base.includes(normalize(value))) flags.push({ kind: 'date', value, line })
    }
    for (const value of uniqueMatches(line, CREDENTIAL_RE)) {
      if (!base.includes(normalize(value)) && !tickedCovers(line, value, ticked)) flags.push({ kind: 'credential', value, line })
    }
    const employment = EMPLOYMENT_RE.exec(line)
    if (employment) {
      const left = employment[1].trim()
      const right = employerOf(employment[2])
      if (TITLE_RE.test(left) && !base.includes(normalize(left))) flags.push({ kind: 'job-title', value: left, line })
      if (!base.includes(normalize(right))) flags.push({ kind: 'employer', value: right, line })
    }
  }

  flags.push(...inspectEditedLines(baseResume, tailoredResume, ticked))

  const deduped = flags.filter((flag, i) => flags.findIndex(f => f.kind === flag.kind && normalize(f.value) === normalize(flag.value)) === i)
  return { safe: deduped.length === 0, flags: deduped }
}

// ─── Edited lines ────────────────────────────────────────────────
//
// The checks above look for facts new to the whole résumé, which misses the
// fabrication small local models actually commit: moving a true fact onto a
// line it does not belong to. Measured on qwen2.5:7b with a real résumé, it
// retitled "Workflow Automation Developer" as "Full Stack Developer" (the
// candidate's title at a DIFFERENT employer, so already "in the base") and
// appended "using React and Node.js" to every bullet of a job that used
// neither. Each claim existed somewhere; none was true where it was put.
//
// So each edited line is compared with the line it replaced. The tailoring
// prompt asks for one output line per input line, edited in place, which is
// what makes the pairing meaningful.

// Names and technologies in a line: anything with # + or an inner dot (C#,
// C++, Node.js), two or more capitals (SQL, TypeScript, AWS), or a capital
// after the first word (Azure, Kubernetes, Acme). The first word is skipped:
// every bullet starts with a capitalised verb.
const WORD_RE = /[A-Za-z0-9.][A-Za-z0-9+#./-]*[A-Za-z0-9+#]|[A-Za-z]/g
const wordKey = (word) => word.toLowerCase().replace(/\.$/, '')
function namesIn(line) {
  const words = String(line).replace(/^[\s\-•*–·]+/, '').match(WORD_RE) || []
  return new Set(words.slice(1)
    .filter(w => /[#+]|[a-z]\.[a-z]/i.test(w) || /[A-Z].*[A-Z]/.test(w) || /^[A-Z]/.test(w))
    .map(wordKey))
}

// Every word in a line, the first included, keyed the way namesIn keys a name,
// and each part of a hyphenated one ("Full-stack" holds "stack").
const wordsIn = (line) => new Set((String(line).match(WORD_RE) || [])
  .flatMap(word => [word, ...word.split(/[-/]/)]).filter(Boolean).map(wordKey))

// Figures in a line: 30%, 40k, 2021-2025, $1.2m.
function figuresIn(line) {
  return new Set((String(line).match(/[$£€]?\d[\d,.]*(?:%|[kmb]\b|\+)?/gi) || [])
    .map(f => f.toLowerCase().replace(/[.,]$/, '')))
}

// A heading the prompt says to copy character for character: a title or an
// employer with its dates or location ("Developer | Jan 2026 - Aug 2026",
// "Acme | Sydney | Contract"), or the contact line.
const isHeading = (line) => / \| /.test(line) || new RegExp(DATE_RE.source, 'i').test(line)
const isBullet = (line) => /^[-•*–·]/.test(line)
const squash = (line) => line.replace(/\s+/g, ' ').trim()

// Each run of removed and added lines is one edit; within it the n-th removed
// line pairs with the n-th added line. Lines added beyond that have nothing to
// be compared with, so they are returned with the heading they sit under.
//
// A line that comes back word for word somewhere else was moved, not edited,
// and pairing it would compare it with whatever happened to sit in its old
// place: a local Qwen3-30B moved a bullet up its own job and was flagged for
// every name in it. A moved line is returned with the added ones instead, so
// a bullet is held to the job it now sits under. Headings are not treated this
// way, because swapping two job titles moves no bullet and changes every one.
function editedLines(baseResume, tailoredResume) {
  const parts = diffLines(baseResume, tailoredResume)
  const textOf = (type) => new Set(parts.filter(p => p.type === type).map(p => squash(p.line)).filter(Boolean))
  const addedText = textOf('added')
  const moved = new Set([...textOf('removed')].filter(text => addedText.has(text) && !isHeading(text)))
  const pairs = []
  const extra = []
  let removed = []
  let added = []
  let heading = ''
  const flush = () => {
    const n = Math.min(removed.length, added.length)
    for (let i = 0; i < n; i++) pairs.push([removed[i], added[i].line, added[i].heading])
    extra.push(...added.slice(n))
    removed = []
    added = []
  }
  for (const part of parts) {
    const line = part.line.trim()
    if (part.type === 'same') flush()
    else if (!line) continue
    else if (moved.has(squash(line))) { if (part.type === 'added') extra.push({ line, heading }); continue }
    else if (part.type === 'removed') { removed.push(line); continue }
    else added.push({ line, heading })
    if (isHeading(line)) heading = squash(line)
  }
  flush()
  return { pairs, extra }
}

// Every name and figure the base states, per block (a heading and the lines
// under it, so a bullet belongs to the job above it) and for the whole résumé,
// and the text of each bullet. Unlike a line being checked, a reference line's
// first word counts too.
const bulletText = (line) => squash(line.replace(/^[-•*–·]\s*/, '')).toLowerCase()
function claimsByBlock(baseResume) {
  const empty = () => ({ names: new Set(), figures: new Set(), bullets: new Set() })
  const blocks = new Map()
  const whole = empty()
  let heading = ''
  for (const raw of String(baseResume).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (isHeading(line)) heading = squash(line)
    if (!blocks.has(heading)) blocks.set(heading, empty())
    for (const target of [blocks.get(heading), whole]) {
      for (const name of namesIn(`x ${line}`)) target.names.add(name)
      for (const figure of figuresIn(line)) target.figures.add(figure)
      if (isBullet(line)) target.bullets.add(bulletText(line))
    }
  }
  return { blocks, whole }
}

function inspectEditedLines(baseResume, tailoredResume, ticked = []) {
  const flags = []
  const { pairs, extra } = editedLines(baseResume, tailoredResume)
  const { blocks, whole } = claimsByBlock(baseResume)
  // The words a ticked skill brings to a skills line or the summary ("SQL
  // Server" in "Databases: SQL Server, PostgreSQL"). Never to a bullet: a
  // bullet says a job used something, and ticking a skill does not say which.
  const fromTicked = (line) => (isBullet(line) ? new Set()
    : new Set(tickedIn(line, ticked).flatMap(text => [...wordsIn(text)])))
  // Word for word, another job's bullet: that job's work claimed for this one.
  // A bullet naming nothing ("Worked with cross-functional teams to investigate
  // and resolve technical issues") gives the name and figure checks nothing to
  // compare, and qwen2.5:7b copied two such bullets into another job, one in
  // place of a real bullet and one beside it.
  const fromAnotherJob = (line, heading) => {
    const block = isBullet(line) ? blocks.get(heading) : undefined
    return !!block && !block.bullets.has(bulletText(line)) && whole.bullets.has(bulletText(line))
  }
  for (const [before, after, heading] of pairs) {
    if (isHeading(before) && squash(before) !== squash(after)) {
      flags.push({ kind: 'heading', value: after, line: after })
      continue // a rewritten heading would otherwise also report every word in it
    }
    if (fromAnotherJob(after, heading)) {
      flags.push({ kind: 'moved-bullet', value: after, line: after })
      continue
    }
    // Any word of the old line, whatever its case: qwen2.5:7b recapitalised
    // "Full-stack software engineer" and was flagged for three new names.
    const had = wordsIn(before)
    const ticks = fromTicked(after)
    for (const name of namesIn(after)) {
      if (!had.has(name) && !ticks.has(name)) flags.push({ kind: 'moved-claim', value: name, line: after })
    }
    const figures = figuresIn(before)
    for (const figure of figuresIn(after)) {
      if (!figures.has(figure)) flags.push({ kind: 'figure', value: figure, line: after })
    }
  }
  // An added line replaced nothing, so there is no line to compare it with: a
  // bullet may only repeat what the base says under the same heading (a bullet
  // split in two passes; one invented, or moved from another job, does not),
  // and any other line only what the base says somewhere. New headings are left
  // to the date, title and employer checks.
  for (const { line, heading } of extra) {
    if (isHeading(line)) continue
    if (fromAnotherJob(line, heading)) {
      flags.push({ kind: 'moved-bullet', value: line, line })
      continue
    }
    const known = (isBullet(line) && blocks.get(heading)) || whole
    const ticks = fromTicked(line)
    for (const name of namesIn(line)) {
      if (!known.names.has(name) && !ticks.has(name)) flags.push({ kind: 'moved-claim', value: name, line })
    }
    for (const figure of figuresIn(line)) {
      if (!known.figures.has(figure)) flags.push({ kind: 'figure', value: figure, line })
    }
  }
  return flags
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
function inspectClaims(baseResume, text, { allow = [], extraSkills = [] } = {}) {
  const base = normalize(baseResume)
  const ticked = tickedMatchers(extraSkills)
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
      if (!supported(value) && !tickedCovers(trimmed, value, ticked)) flags.push({ kind: 'credential', value, line: trimmed })
    }
    for (const value of uniqueMatches(trimmed, DATE_RE)) {
      if (!supported(value)) flags.push({ kind: 'date', value, line: trimmed })
    }
    const employment = EMPLOYMENT_RE.exec(trimmed)
    if (employment && !ASPIRATIONAL_RE.test(trimmed)) {
      const left = employment[1].trim()
      const right = employerOf(employment[2])
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
function inspectCoverLetter(baseResume, coverLetter, { company = '', jobTitle = '', extraSkills = [] } = {}) {
  if (!baseResume || !coverLetter) return { safe: true, flags: [] }
  return inspectClaims(baseResume, coverLetter, { allow: [company, jobTitle], extraSkills })
}

// One screening answer, before it is typed into the employer's form.
//
// Checked against the resume alone: the QUESTION is not an allowance, because an
// employer asking "do you hold a current security clearance?" must not thereby
// make "yes, I hold a current security clearance" a supported claim. That is
// precisely the shape an injected ad takes.
function inspectScreeningAnswer(baseResume, answer, { extraSkills = [] } = {}) {
  if (!baseResume || !answer) return { safe: true, flags: [] }
  const text = String(answer).trim()
  // Short categorical answers carry no verifiable claim of their own — "Yes",
  // "5", "Australian citizen". Flagging those would make the guard fire on
  // nearly every application while catching nothing.
  if (text.length < 12 && !CREDENTIAL_TEST_RE.test(text)) return { safe: true, flags: [] }
  return inspectClaims(baseResume, text, { extraSkills })
}

function describeFlags(flags) {
  return flags.map(f => `${f.kind}: ${f.value}`).join('; ')
}

module.exports = {
  inspectTailoring, inspectCoverLetter, inspectScreeningAnswer, inspectClaims, describeFlags,
  namesIn, figuresIn,
}
