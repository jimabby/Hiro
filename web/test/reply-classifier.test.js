// The keyword reply classifier, and the ordering bug inside it.
//
// `interview` used to be tested before `rejected`. A rejection very often names
// the thing it is rejecting you from — "Interview outcome — unfortunately
// unsuccessful", "Following your interview we've decided not to proceed" — so
// both patterns matched and whichever ran first won.
//
// Reading a rejection as an interview invitation is much the worse of the two
// mistakes. It puts a phantom interview on the dashboard, and because
// `newStatus === 'interview'` is what makes inbox.js fetch the body and run
// parseInterviewTime over it, a date quoted in the rejected thread ends up in
// the user's actual calendar.
//
// The AI classifier corrects this when a provider is configured. This is the
// fallback that has to stand on its own when one is not.

const { createChecker } = require('./helpers')

// classifySubject is module-private; exercise it through the same regexes the
// module uses, kept in step by this file failing if they diverge.
const fs = require('fs')
const path = require('path')
const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'inbox.js'), 'utf8')

const { check, done } = createChecker()

// Rebuild the function from the source, so the test cannot silently pass
// against a copy that has drifted from what ships.
const body = /function classifySubject\(subject\) \{[\s\S]*?\n\}/.exec(source)?.[0]
check('the classifier was found in the source', !!body, true)
const classifySubject = new Function(`${body}; return classifySubject`)()

// ─── The regression ──────────────────────────────────────────────
const REJECTIONS_MENTIONING_INTERVIEWS = [
  'Interview outcome — unfortunately unsuccessful',
  'Following your interview, we have decided not to proceed',
  'Your interview feedback — regret to inform you',
  'Update after your phone screen: we will not be moving forward',
]
for (const subject of REJECTIONS_MENTIONING_INTERVIEWS) {
  check(`rejection wins over the word "interview": "${subject.slice(0, 44)}"`,
    classifySubject(subject), 'rejected')
}

// ─── Genuine invitations still classify ──────────────────────────
const INVITATIONS = [
  'Interview invitation — Senior Engineer',
  'Let us schedule a call this week',
  'Invitation: phone screen with the team',
  'Are you available to chat on Thursday?',
]
for (const subject of INVITATIONS) {
  check(`invitation still detected: "${subject.slice(0, 44)}"`, classifySubject(subject), 'interview')
}

// ─── Plain rejections ────────────────────────────────────────────
check('a plain rejection', classifySubject('Unfortunately we are moving forward with other candidates'), 'rejected')
check('a filled position', classifySubject('That position has been filled'), 'rejected')

// ─── Anything else is pending, for the user to look at ───────────
check('an acknowledgement is pending', classifySubject('We received your application'), 'pending')
check('an empty subject is pending', classifySubject(''), 'pending')
check('a missing subject is pending', classifySubject(undefined), 'pending')

done()
