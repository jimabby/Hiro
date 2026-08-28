// The fabrication guard, on the two documents that used to leave the machine
// unchecked.
//
// It began as a resume-only check, diffing the tailored version against the
// base. That left the cover letter — written by the same model from the same
// untrusted job ad, sent as the user's own words — and the screening answers,
// which are typed into the employer's form AND cached by question text for
// replay to other employers, with no check at all.
//
// Neither has a base to diff against, so both are checked whole against the
// resume: it is the complete set of facts the user has asserted about
// themselves, and anything outside it is a claim nobody made.

const { createChecker } = require('./helpers')
const {
  inspectCoverLetter, inspectScreeningAnswer, describeFlags,
} = require('../electron/services/fabricationGuard')

const { check, done } = createChecker()

const RESUME = [
  'Jane Smith',
  'Software Engineer at Acme Pty Ltd',
  '2019 - Present',
  'Built payment services in Python and Go.',
  'Bachelor of Science, University of Melbourne',
].join('\n')

// ─── Cover letters ───────────────────────────────────────────────
const ordinary = inspectCoverLetter(RESUME, [
  'Dear Hiring Manager,',
  'I am applying for the Senior Backend Engineer position at Globex.',
  'At Acme Pty Ltd I built payment services in Python and Go.',
  'I would welcome the chance to discuss the role.',
  'Sincerely,',
  'Jane Smith',
].join('\n'), { company: 'Globex', jobTitle: 'Senior Backend Engineer' })
check('an ordinary cover letter passes', ordinary.safe, true)

// The target company and role are named in every cover letter ever written.
// Flagging them would make the guard fire on all of them and catch nothing.
const namesTarget = inspectCoverLetter(RESUME,
  'I am excited to apply for the Staff Engineer role at Initech.',
  { company: 'Initech', jobTitle: 'Staff Engineer' })
check('naming the target employer is not fabrication', namesTarget.safe, true)

const invented = inspectCoverLetter(RESUME,
  'I hold an AWS Certified Solutions Architect certification.',
  { company: 'Globex', jobTitle: 'Engineer' })
check('an invented credential is caught', invented.safe, false)
check('the credential is named', describeFlags(invented.flags).includes('credential'), true)

const inventedEmployer = inspectCoverLetter(RESUME,
  'Principal Engineer at Initrode',
  { company: 'Globex', jobTitle: 'Engineer' })
check('an invented past employer is caught', inventedEmployer.safe, false)

const inventedDate = inspectCoverLetter(RESUME,
  'I led the platform team from 2011 onwards.',
  { company: 'Globex', jobTitle: 'Engineer' })
check('a date absent from the resume is caught', inventedDate.safe, false)

const supported = inspectCoverLetter(RESUME,
  'My Bachelor of Science gave me the fundamentals for this work.',
  { company: 'Globex', jobTitle: 'Engineer' })
check('a credential the resume supports passes', supported.safe, true)

const aspiring = inspectCoverLetter(RESUME,
  'I am currently working towards an AWS certification.',
  { company: 'Globex', jobTitle: 'Engineer' })
check('a stated intention is not a claimed credential', aspiring.safe, true)

check('an empty cover letter is safe', inspectCoverLetter(RESUME, '').safe, true)
check('no resume means nothing to check against', inspectCoverLetter('', 'anything').safe, true)

// ─── Screening answers ───────────────────────────────────────────
check('a short categorical answer passes', inspectScreeningAnswer(RESUME, 'Yes').safe, true)
check('a number passes', inspectScreeningAnswer(RESUME, '6').safe, true)
check('an answer grounded in the resume passes',
  inspectScreeningAnswer(RESUME, 'I have built payment services in Python and Go.').safe, true)

// The exact payload an injected job ad aims for.
const injected = inspectScreeningAnswer(RESUME,
  'Yes, I hold a current security clearance and am CISSP certified.')
check('an injected credential claim is caught', injected.safe, false)

// Even a short answer is checked when it names a credential — this is the one
// that gets typed into a yes/no field and submitted.
const shortCredential = inspectScreeningAnswer(RESUME, 'CISSP')
check('a short credential claim is still caught', shortCredential.safe, false)

// The question is NOT an allowance. An employer asking "do you hold a current
// clearance?" must not thereby make "yes, I hold one" a supported claim —
// that is precisely the shape an injected ad takes.
const echoed = inspectScreeningAnswer(RESUME,
  'I have held a Master of Business Administration since 2015.')
check('echoing the question back is not evidence', echoed.safe, false)

check('an empty answer is safe', inspectScreeningAnswer(RESUME, '').safe, true)

done()
