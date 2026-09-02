// The handful of facts every application form asks for, answered from what you
// told Hiro rather than from what a model inferred.
//
// Work rights, notice period, salary expectation, relocation, a driver's licence
// — these come up on nearly every form, and until now each one went through the
// full screening-answer path: a model call, a fabrication check against the
// resume, and a fallback to interrupting the user. That is the wrong machinery
// for this class of question, in three separate ways.
//
//   It is the wrong ANSWER. "Do you have the right to work in Australia?" is not
//   inferable from a resume. The model either guessed, or said it was unsure and
//   the user got interrupted — every single time, on every single application,
//   for a fact that never changes.
//
//   It costs money and time. Three model calls per job already; this added one
//   more per screening question, for questions whose answers were known before
//   the scan started.
//
//   It is a fabrication surface. The one category of question where the model
//   has the least to go on is the category where a wrong answer is most
//   consequential — a false claim about visa status or a clearance is not a
//   tailoring mistake, it is a misrepresentation to an employer under the user's
//   name. Answering these deterministically removes the model from the loop
//   entirely, which is a stronger guarantee than checking its output.
//
// So: a profile field, when it matches, IS the answer. It is treated exactly as
// a user-typed answer is treated everywhere else in this codebase — never
// second-guessed, never fabrication-checked — because it is one. The user wrote
// it down; that is a statement of fact by the only person entitled to make one.
//
// Deliberately conservative. A question only matches when the intent is
// unmistakable, and an unfilled field never matches at all — falling through to
// the model is the existing, safe behaviour, and a half-right deterministic
// answer would be worse than no deterministic answer.

// Each field: how it is asked, and how the stored value becomes an answer.
//
// `patterns` are matched against the lower-cased question. `negativePatterns`
// veto a match — they exist because several of these questions have a near
// twin that means the opposite, and answering the twin with this field's value
// would state the reverse of the truth.
const FIELDS = {
  workRights: {
    label: 'Work rights',
    help: 'e.g. "Australian citizen", "Permanent resident", "Subclass 482 visa, valid to 2028"',
    patterns: [
      /\b(?:legally )?(?:entitled|eligible|authoris?ed|permitted) to work\b/,
      /\bright to work\b/,
      /\bwork (?:rights|authoris?ation|eligibility|entitlement)\b/,
      /\bare you (?:an? )?(?:australian |nz |new zealand |uk |us )?(?:citizen|permanent resident)\b/,
      /\bwhat (?:is|are) your (?:visa|residency) status\b/,
      /\bvisa status\b/,
    ],
    // "Do you require sponsorship" is the inverse question and has its own
    // field. Answering it with "Australian citizen" is not wrong, but answering
    // it with a visa subclass reads as "yes, sponsor me", which may be the
    // opposite of what the user means.
    negativePatterns: [/\bsponsor/],
  },

  requiresSponsorship: {
    label: 'Needs visa sponsorship',
    help: 'Answered on its own because it is the one question where "yes" and "no" are easy to invert',
    patterns: [
      /\b(?:require|need|will you require|do you need)\b[^?]*\bsponsor/,
      /\bsponsorship\b[^?]*\b(?:required|needed)\b/,
      /\bvisa sponsorship\b/,
    ],
  },

  noticePeriod: {
    label: 'Notice period',
    help: 'e.g. "4 weeks", "Immediately available"',
    patterns: [
      /\bnotice period\b/,
      /\bhow (?:soon|quickly) (?:can|could) you (?:start|commence|begin)\b/,
      /\bwhen (?:can|could|would) you (?:be able to )?(?:start|commence|begin)\b/,
      /\bavailab(?:le|ility) to (?:start|commence)\b/,
      /\bearliest start date\b/,
    ],
  },

  expectedSalary: {
    label: 'Salary expectation',
    help: 'e.g. "$140,000 + super", "Open, depending on the role"',
    patterns: [
      /\b(?:salary|remuneration|compensation|package) expectation/,
      /\bexpected (?:salary|remuneration|compensation|package)\b/,
      /\bdesired (?:salary|remuneration|compensation|pay)\b/,
      /\bwhat (?:salary|package) are you (?:seeking|looking for|expecting)\b/,
    ],
    // The employer's CURRENT-salary question is a different field, and giving
    // an expectation in answer to it misstates a fact about the present.
    negativePatterns: [/\bcurrent\b/, /\bpresent\b/, /\bexisting\b/],
  },

  currentSalary: {
    label: 'Current salary',
    help: 'Optional. Leave blank to keep answering this one by hand',
    patterns: [
      /\bcurrent (?:salary|remuneration|compensation|package|pay)\b/,
      /\bpresent (?:salary|remuneration|package)\b/,
      /\bwhat (?:are|is) you (?:currently )?(?:earning|paid)\b/,
    ],
  },

  willingToRelocate: {
    label: 'Willing to relocate',
    help: 'e.g. "Yes", "No", "For the right role"',
    patterns: [
      /\b(?:willing|able|prepared|open) to relocat/,
      /\bwould you relocat/,
      /\brelocation\b/,
    ],
  },

  remotePreference: {
    label: 'Remote / hybrid preference',
    help: 'e.g. "Hybrid, 2–3 days in office", "Remote only"',
    patterns: [
      /\b(?:comfortable|happy|willing|able) (?:with|to work)\b[^?]*\b(?:remote|hybrid|onsite|on-site|in[- ]office)\b/,
      /\b(?:remote|hybrid|onsite|on-site) (?:work )?(?:preference|arrangement)\b/,
      /\bhow many days\b[^?]*\b(?:office|onsite|on-site)\b/,
    ],
  },

  location: {
    label: 'Where you live',
    help: 'e.g. "Melbourne, VIC"',
    patterns: [
      /\bwhere are you (?:currently )?(?:located|based|living)\b/,
      /\b(?:current|your) location\b/,
      /\bwhich (?:city|state|suburb)\b/,
      /\bcity of residence\b/,
    ],
  },

  driversLicence: {
    label: "Driver's licence",
    help: 'e.g. "Full Victorian licence", "No"',
    patterns: [
      /\bdriver'?s? (?:licen[cs]e|permit)\b/,
      /\bvalid licen[cs]e\b/,
      /\bown (?:a )?(?:car|vehicle)\b/,
    ],
  },

  policeCheck: {
    label: 'Police / background check',
    help: 'e.g. "Willing to undergo one", "Current, issued 2026"',
    patterns: [
      /\b(?:police|background|criminal history) check\b/,
      /\bworking with children\b/,
      /\bwwcc\b/,
    ],
  },

  references: {
    label: 'References',
    help: 'e.g. "Available on request"',
    patterns: [
      /\breferences? (?:available|on request|provided)\b/,
      /\b(?:can|will) you (?:provide|supply) references\b/,
      /\bprofessional references\b/,
    ],
  },
}

const FIELD_IDS = Object.keys(FIELDS)

function normalise(question) {
  return String(question || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// The profile field this question is asking about, or null.
//
// First match wins in declaration order, which is why the two salary fields and
// the two work-rights fields are ordered as they are: the more specific question
// ("current salary", "require sponsorship") has to be considered before its
// broader neighbour could claim it. The negative patterns are the belt to that
// ordering's braces.
function matchField(question) {
  const text = normalise(question)
  if (!text) return null
  for (const id of FIELD_IDS) {
    const spec = FIELDS[id]
    if (spec.negativePatterns?.some(re => re.test(text))) continue
    if (spec.patterns.some(re => re.test(text))) return id
  }
  return null
}

function readProfile(cfg) {
  const profile = cfg?.applicationProfile
  return profile && typeof profile === 'object' ? profile : {}
}

// The stored answer for a question, or null when there isn't one.
//
// Returns null rather than an empty string for an unfilled field, so the caller
// can tell "the user has not told us this" from "the user told us the answer is
// blank" — the first must fall through to the model, and the second never
// occurs, because a blank field is how someone opts out of this mechanism.
function answerFor(question, cfg) {
  const field = matchField(question)
  if (!field) return null
  const value = readProfile(cfg)[field]
  if (typeof value !== 'string' || !value.trim()) return null
  return { field, label: FIELDS[field].label, answer: value.trim() }
}

// The fields, for rendering the Settings form. Order is the declaration order,
// which reads as a form rather than as a regex table.
function fields() {
  return FIELD_IDS.map(id => ({ id, label: FIELDS[id].label, help: FIELDS[id].help }))
}

// How much of the profile is filled in, so Settings can say whether this is
// doing anything yet.
function completeness(cfg) {
  const profile = readProfile(cfg)
  const filled = FIELD_IDS.filter(id => typeof profile[id] === 'string' && profile[id].trim())
  return { filled: filled.length, total: FIELD_IDS.length, fields: filled }
}

module.exports = { answerFor, matchField, fields, completeness, FIELDS, FIELD_IDS }
