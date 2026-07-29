// Recruiter contact extraction. Auto follow-up skipped effectively every
// application because nothing ever populated recruiter_email.
//
// The bar here is deliberately high: a wrong address means mailing a stranger,
// so an ambiguous ad must yield nothing rather than a guess.

const { createChecker } = require('./helpers')
const path = require('path')
const { extractRecruiterEmail, recruiterEmailFromReply, isPlatformDomain, companyTokens } =
  require(path.join(__dirname, '..', 'electron', 'services', 'contactExtractor.js'))

const { check, done } = createChecker()

// ── Confident matches ────────────────────────────────────────────
check('an address on the company domain wins',
  extractRecruiterEmail('Questions? Email careers@acmehealth.com to apply.', { company: 'Acme Health Pty Ltd' }),
  'careers@acmehealth.com')

check('a recruiting-shaped local part is enough without a domain match',
  extractRecruiterEmail('To apply, send your resume to recruitment@thirdpartyagency.io', { company: 'Unrelated Co' }),
  'recruitment@thirdpartyagency.io')

check('apply context near the address counts',
  extractRecruiterEmail('Send your CV and cover letter to jane.doe@bigcorp.com for consideration.', { company: 'BigCorp' }),
  'jane.doe@bigcorp.com')

// ── Rejections ───────────────────────────────────────────────────
check('no-reply addresses are rejected',
  extractRecruiterEmail('Do not reply: no-reply@acme.com', { company: 'Acme' }), '')

check('platform notification addresses are rejected',
  extractRecruiterEmail('Apply via jobs@seek.com.au', { company: 'Acme' }), '')

check('an ATS domain is not the employer',
  extractRecruiterEmail('Apply at careers@greenhouse.io', { company: 'Acme' }), '')

check('template placeholders are rejected',
  extractRecruiterEmail('Contact your.name@example.com', { company: 'Acme' }), '')

check('a bare freemail address with no context is not worth mailing',
  extractRecruiterEmail('...random text someone@gmail.com more text...', { company: 'Acme' }), '')

check('an empty description yields nothing', extractRecruiterEmail('', { company: 'Acme' }), '')
check('a description with no address yields nothing',
  extractRecruiterEmail('Great role, apply on our website.', { company: 'Acme' }), '')

// Trailing punctuation is extremely common and must not corrupt the address.
check('trailing punctuation is trimmed',
  extractRecruiterEmail('Email careers@acme.com.', { company: 'Acme' }), 'careers@acme.com')

// ── Reply senders ────────────────────────────────────────────────
// A human who has already read the application is the best contact there is.
check('a reply sender is accepted',
  recruiterEmailFromReply('Sarah.Jones@Acme.com', { company: 'Acme' }), 'sarah.jones@acme.com')
check('a no-reply sender is still rejected',
  recruiterEmailFromReply('noreply@acme.com', { company: 'Acme' }), '')
check('a platform sender is rejected',
  recruiterEmailFromReply('jobs-noreply@linkedin.com', { company: 'Acme' }), '')
check('a missing sender yields nothing', recruiterEmailFromReply('', { company: 'Acme' }), '')

// ── Helpers ──────────────────────────────────────────────────────
check('subdomains of a platform are platform domains', isPlatformDomain('mail.seek.com.au'), true)
check('an ordinary domain is not', isPlatformDomain('acme.com'), false)
check('legal suffixes are stripped from company tokens',
  companyTokens('Acme Health Pty Ltd'), ['acme', 'health'])

done()
