// Automated "thanks for applying" receipts are not replies.
//
// They used to be classified 'pending', which counts as a response — inflating
// the response rate — and moved the application out of 'applied', which is the
// only status follow-ups are drafted for. So every receipt silently retired its
// application from the follow-up sequence the moment it was submitted.
//
// The other half matters as much: a rejection that OPENS like a receipt must
// still be read as a rejection, or the application stays open forever.

const fs = require('fs')
const path = require('path')
const { service, createChecker } = require('./helpers')
const { isAcknowledgement, mightBeAcknowledgement } = service('replyFilter')
const { check, done } = createChecker()

// ─── Receipts ────────────────────────────────────────────────────
const RECEIPTS = [
  ['Thank you for applying to Acme', ''],
  ['Thanks for your application — Software Engineer', ''],
  ['Application received: Software Engineer at Acme', ''],
  ['Acme — Application Confirmation', ''],
  ['Your application', 'We have received your application for Software Engineer and our team will review it.'],
  ['Software Engineer', 'This email confirms receipt of your application.'],
]
for (const [subject, body] of RECEIPTS) {
  check(`a receipt: "${subject.slice(0, 40)}"`, isAcknowledgement(subject, body), true)
}

// ─── Not receipts ────────────────────────────────────────────────
check('a rejection that opens with thanks is not a receipt',
  isAcknowledgement('Thank you for your interest in Acme', 'Unfortunately we will not be moving forward with your application.'), false)
check('"other candidates" is a decision',
  isAcknowledgement('Thank you for applying', 'We have decided to proceed with other candidates.'), false)
check('an interview invitation that thanks you is not a receipt',
  isAcknowledgement('Thank you for applying', 'We would like to schedule a call with you next week.'), false)
check('an offer is not a receipt',
  isAcknowledgement('Thanks for your application', 'We are pleased to offer you the position.'), false)
check('a plain human reply is not a receipt',
  isAcknowledgement('Re: Software Engineer', 'Could you send through your availability?'), false)
check('nothing at all is not a receipt', isAcknowledgement('', ''), false)

// ─── The subject pre-check that decides whether to fetch the body ─
check('a receipt subject asks for the body', mightBeAcknowledgement('Thank you for applying to Acme'), true)
check('an ordinary subject does not', mightBeAcknowledgement('Re: Software Engineer'), false)

// ─── The model's label ───────────────────────────────────────────
// Each adapter's prompt must offer the label inbox.js listens for, or the AI
// path files every receipt under 'pending' exactly as before.
for (const file of ['claude.js', 'openai.js', 'gemini.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'ai', file), 'utf8')
  check(`${file} offers the acknowledgement label`, /^- acknowledgement:/m.test(src), true)
}
const inbox = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'inbox.js'), 'utf8')
check('inbox.js acts on that label', inbox.includes("aiStatus.includes('acknowledg')"), true)

done()
