// The facts every application form asks for, answered from what the user said
// rather than from what a model inferred.
//
// Why this exists at all: "Do you have the right to work in Australia?" is not
// inferable from a resume. It used to go through the full screening-answer path
// — a model call, a fabrication check against the resume, and a fallback to
// interrupting the user — so the model either guessed or said it was unsure, and
// the user was interrupted for a fact that never changes, on every application.
//
// The two properties that matter here, and which the tests are shaped around:
//
//   A filled field answers deterministically, taking the model out of the loop
//   for exactly the class of question where it has least to go on and where a
//   wrong answer is a misrepresentation to an employer under the user's name.
//
//   An unfilled field matches NOTHING, so the existing path is untouched. A
//   half-right deterministic answer would be worse than no deterministic answer.

const { stub, service, createChecker } = require('./helpers')

stub({ './config': { load: () => ({}) } })

const profile = service('applicationProfile.js')
const { check, done } = createChecker()

const CFG = {
  applicationProfile: {
    workRights: 'Australian citizen',
    requiresSponsorship: 'No',
    noticePeriod: '4 weeks',
    expectedSalary: '$160,000 + super',
    currentSalary: '$140,000 + super',
    willingToRelocate: 'For the right role',
    location: 'Melbourne, VIC',
    driversLicence: 'Full Victorian licence',
  },
}

const answer = (q, cfg = CFG) => profile.answerFor(q, cfg)?.answer ?? null
const field = (q) => profile.matchField(q)

// ── Work rights ──────────────────────────────────────────────────
check('legally entitled to work', answer('Are you legally entitled to work in Australia?'), 'Australian citizen')
check('right to work', answer('Do you have the right to work in this country?'), 'Australian citizen')
check('work rights', answer('What are your work rights?'), 'Australian citizen')
check('citizenship', answer('Are you an Australian citizen or permanent resident?'), 'Australian citizen')
check('visa status', answer('Please state your visa status.'), 'Australian citizen')

// Sponsorship is the inverse question and has its own field. Answering it with a
// visa subclass reads as "yes, sponsor me", which may be the opposite of what
// the user means — so the work-rights field must not claim it.
check('sponsorship is its own field', field('Will you require visa sponsorship?'), 'requiresSponsorship')
check('and answers from its own value', answer('Do you require sponsorship to work here?'), 'No')
check('work rights does not claim a sponsorship question',
  field('Do you require sponsorship?') === 'workRights', false)

// ── Notice period ────────────────────────────────────────────────
check('notice period', answer('What is your notice period?'), '4 weeks')
check('how soon can you start', answer('How soon can you start?'), '4 weeks')
check('when can you commence', answer('When could you commence in the role?'), '4 weeks')
check('earliest start date', answer('What is your earliest start date?'), '4 weeks')

// ── Salary: expected and current are different facts ─────────────
// Giving an expectation in answer to the current-salary question misstates a
// fact about the present, which is the one thing this must never do.
check('salary expectation', answer('What are your salary expectations?'), '$160,000 + super')
check('expected salary', answer('Expected salary?'), '$160,000 + super')
check('desired salary', answer('What is your desired salary?'), '$160,000 + super')
check('current salary is not the expectation', answer('What is your current salary?'), '$140,000 + super')
check('present remuneration', answer('What is your present remuneration package?'), '$140,000 + super')
check('current is matched as current, not expected',
  field('What is your current salary expectation for this role?'), 'currentSalary')

// ── The rest ─────────────────────────────────────────────────────
check('relocation', answer('Are you willing to relocate?'), 'For the right role')
check('location', answer('Where are you currently based?'), 'Melbourne, VIC')
check('which city', answer('Which city do you live in?'), 'Melbourne, VIC')
check('licence', answer("Do you hold a current driver's licence?"), 'Full Victorian licence')

// ── What must NOT match ──────────────────────────────────────────
// The profile is for facts, not for judgement. A behavioural question answered
// from a one-line profile field would be worse than no answer.
check('a behavioural question is not a profile question',
  answer('Tell me about a time you handled a difficult stakeholder.'), null)
check('a technical question is not either',
  answer('How would you design a data pipeline for 10TB a day?'), null)
check('a motivation question is not either',
  answer('Why do you want to work here?'), null)
check('an empty question matches nothing', answer(''), null)
check('a null question matches nothing', answer(null), null)

// ── An unfilled field falls through ──────────────────────────────
// This is the property that keeps the feature safe to ship: leaving a field
// blank restores the previous behaviour exactly.
check('an unfilled field yields nothing',
  profile.answerFor('Do you have a police check?', CFG), null)
check('even though the question is recognised',
  field('Do you have a current police check?'), 'policeCheck')
check('a blank string counts as unfilled',
  profile.answerFor('What is your notice period?', { applicationProfile: { noticePeriod: '   ' } }), null)
check('an empty profile answers nothing',
  profile.answerFor('Are you legally entitled to work here?', {}), null)
check('a malformed profile answers nothing',
  profile.answerFor('What is your notice period?', { applicationProfile: 'not an object' }), null)

// ── The answer is trimmed but otherwise untouched ────────────────
// It is typed into an employer's form exactly as the user wrote it. Nothing
// here reformats, capitalises or "improves" it.
check('the stored value is used verbatim',
  profile.answerFor('Notice period?', { applicationProfile: { noticePeriod: '  two weeks (negotiable)  ' } }).answer,
  'two weeks (negotiable)')

// ── The shape Settings renders ───────────────────────────────────
const fields = profile.fields()
check('every field is offered to the form', fields.length, profile.FIELD_IDS.length)
check('each has a label', fields.every(f => typeof f.label === 'string' && f.label), true)
check('each has an example', fields.every(f => typeof f.help === 'string'), true)
check('the field a question matches is one Settings renders',
  fields.some(f => f.id === field('What is your notice period?')), true)

// ── Completeness, so Settings can say whether this is doing anything ──
check('completeness counts what is filled', profile.completeness(CFG).filled, 8)
check('out of every field', profile.completeness(CFG).total, profile.FIELD_IDS.length)
check('an empty profile is zero', profile.completeness({}).filled, 0)

done()
