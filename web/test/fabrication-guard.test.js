const { service, createChecker } = require('./helpers')

const guard = service('fabricationGuard.js')
const { check, done } = createChecker()

const base = `Jane Example
Software Engineer at Acme Pty Ltd
January 2020 - March 2023
Bachelor of Computer Science
Built payment services.`

check('ordinary rewriting is allowed', guard.inspectTailoring(base, `${base}\nImproved service reliability.`).safe, true)

const date = guard.inspectTailoring(base, `${base}\nApril 2024 - Present`)
check('a newly invented date is blocked', date.safe, false)
check('date is identified', date.flags.some(f => f.kind === 'date'), true)

const credential = guard.inspectTailoring(base, `${base}\nAWS Certified Solutions Architect`)
check('a newly invented credential is blocked', credential.flags.some(f => f.kind === 'credential'), true)

const employment = guard.inspectTailoring(base, `${base}\nEngineering Manager at Globex Corporation`)
check('a newly invented title is blocked', employment.flags.some(f => f.kind === 'job-title'), true)
check('a newly invented employer is blocked', employment.flags.some(f => f.kind === 'employer'), true)

check('facts already present in the base are not flagged', guard.inspectTailoring(base, `${base}\nSoftware Engineer at Acme Pty Ltd`).safe, true)
check('empty inputs are safe', guard.inspectTailoring('', '').safe, true)

// A sentence ending on the employer carries its full stop into the capture.
const letterBase = ['Software Engineer', 'Acme Pty Ltd 2019'].join(String.fromCharCode(10))
check('a sentence-final full stop does not make a known employer unknown',
  guard.inspectCoverLetter(letterBase, 'I built the billing service at Acme Pty Ltd.').safe, true)
check('an unknown employer is still flagged with its full stop',
  guard.inspectCoverLetter(letterBase, 'I built the billing service at Globex.').flags.map(f => f.value), ['Globex'])

done()
