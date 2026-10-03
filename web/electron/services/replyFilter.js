// Is this email a reply at all, or the ATS confirming it received the form?
//
// Almost every career board — Greenhouse, Workday, Lever, SmartRecruiters —
// sends "Thank you for applying to Acme" seconds after a submission. It names
// the company and the role, so the inbox matcher pairs it with the application,
// and it used to be classified 'pending': "a reply was received, outcome
// unclear". That was wrong twice over. 'pending' counts as a response, so every
// automated receipt inflated the response rate; and follow-ups are only drafted
// for applications still in 'applied', so the receipt silently retired the
// application from the follow-up sequence the moment it was submitted.
//
// A receipt is not news. It is recorded as seen (so it is not re-read) and
// otherwise ignored, leaving the application exactly where it was.

const ACK_PATTERNS = [
  /thank(?:s| you) for (?:applying|your application|submitting|your interest)/i,
  /(?:we(?:'ve| have)|has been) received your application/i,
  /application (?:received|submitted|confirmation|acknowledg)/i,
  /your application (?:has been|was) (?:received|submitted)/i,
  /we (?:have )?(?:successfully )?received your (?:application|cv|resume|résumé)/i,
  /confirm(?:s|ing|ation of)? (?:the )?(?:receipt|that we (?:have )?received)/i,
]

// A receipt that turns into a verdict partway down is not a receipt. "Thank you
// for your interest in Acme — unfortunately…" is the commonest rejection
// opening there is, and skipping it would leave the application open forever.
const DECISION_PATTERN = /unfortunately|regret|not .*mov(?:e|ing) forward|not .*proceed|not .*progress|unsuccessful|other candidates?|position (?:has been|was) filled|invite you to (?:an )?interview|schedule (?:a|an|your) (?:call|interview|chat)|pleased to offer|offer of employment/i

function isAcknowledgement(subject, body = '') {
  const head = `${subject || ''}\n${String(body || '').slice(0, 600)}`
  if (!ACK_PATTERNS.some(p => p.test(head))) return false
  return !DECISION_PATTERN.test(`${subject || ''}\n${body || ''}`)
}

// The subject alone is enough to decide whether the body is worth fetching to
// make the call properly.
function mightBeAcknowledgement(subject) {
  return ACK_PATTERNS.some(p => p.test(subject || ''))
}

module.exports = { isAcknowledgement, mightBeAcknowledgement }
