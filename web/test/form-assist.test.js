// Career-site form filling: deciding what each field is, and what Hiro must
// never answer for the user.

const { createChecker, stub } = require('./helpers')
stub({ '../config': { load: () => ({}) } })

const { detectAts, formUrlFor, classifyField, pickOption, looksSubmitted } = require('../electron/services/formAssist/classify')
const { contactFor, nameFromResume } = require('../electron/services/contactDetails')
const { statusHtml } = require('../electron/services/formAssist')

const { check, done } = createChecker()

// ─── Which platform, and where its form is ───────────────────────
check('greenhouse', detectAts('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse')
check('greenhouse job-boards host', detectAts('https://job-boards.greenhouse.io/acme/jobs/123'), 'greenhouse')
check('lever', detectAts('https://jobs.lever.co/acme/abc-123'), 'lever')
check('ashby', detectAts('https://jobs.ashbyhq.com/acme/abc'), 'ashby')
check('workday', detectAts('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Sydney/Engineer_R1'), 'workday')
check('anything else is generic', detectAts('https://careers.acme.com/jobs/1'), 'generic')
check('a lookalike host is not lever', detectAts('https://jobs.lever.co.evil.com/x'), 'generic')
check('garbage is generic', detectAts('not a url'), 'generic')
check('lever opens on its form', formUrlFor('https://jobs.lever.co/acme/abc-123'), 'https://jobs.lever.co/acme/abc-123/apply')
check('lever form url is not doubled', formUrlFor('https://jobs.lever.co/acme/abc-123/apply'), 'https://jobs.lever.co/acme/abc-123/apply')
check('ashby opens on its form', formUrlFor('https://jobs.ashbyhq.com/acme/abc/'), 'https://jobs.ashbyhq.com/acme/abc/application')
check('greenhouse is left as is', formUrlFor('https://boards.greenhouse.io/acme/jobs/1'), 'https://boards.greenhouse.io/acme/jobs/1')

// ─── Contact fields ──────────────────────────────────────────────
const kind = (label, type = 'text', name = '') => {
  const c = classifyField({ label, type, name })
  return c.key ? `${c.kind}:${c.key}` : c.kind
}
check('first name', kind('First Name *'), 'contact:firstName')
check('last name', kind('Last name'), 'contact:lastName')
check('surname', kind('Surname'), 'contact:lastName')
check('full name', kind('Full name'), 'contact:fullName')
check('bare "Name"', kind('Name *'), 'contact:fullName')
check('"Company name" is not the candidate', kind('Current company name'), 'question')
check('email by label', kind('Email address'), 'contact:email')
check('email by type', kind('Where can we reach you?', 'email'), 'contact:email')
check('phone by type', kind('Best number', 'tel'), 'contact:phone')
check('linkedin', kind('LinkedIn Profile'), 'contact:linkedin')
check('github', kind('GitHub URL'), 'contact:github')
check('website', kind('Website'), 'contact:portfolio')
check('location', kind('Location (City)'), 'contact:location')

// ─── Documents ───────────────────────────────────────────────────
check('resume upload', kind('Resume/CV', 'file'), 'resumeFile')
check('an unlabelled upload is the résumé', kind('', 'file'), 'resumeFile')
check('cover letter upload', kind('Cover Letter', 'file'), 'coverLetterFile')
check('cover letter text box', kind('Cover letter', 'textarea'), 'coverLetterText')
check('an unknown attachment is skipped', kind('Transcript', 'file'), 'skip')

// ─── What Hiro never answers ─────────────────────────────────────
check('gender is the user\'s', kind('Gender', 'select'), 'eeo')
check('ethnicity is the user\'s', kind('Are you Hispanic/Latino?', 'radio'), 'eeo')
check('veteran status is the user\'s', kind('Veteran Status', 'select'), 'eeo')
check('disability is the user\'s', kind('Disability status', 'select'), 'eeo')
check('pronouns are the user\'s', kind('Pronouns'), 'eeo')
check('Indigenous status is the user\'s', kind('Do you identify as Aboriginal or Torres Strait Islander?', 'radio'), 'eeo')
check('consent is the user\'s', kind('I certify that the information is accurate', 'checkbox'), 'consent')
check('privacy policy is the user\'s', kind('I agree to the privacy policy', 'checkbox'), 'consent')
check('captcha is skipped', kind('Captcha'), 'skip')

// ─── Screening questions ─────────────────────────────────────────
check('a real question goes to the answer pipeline', kind('Do you have the right to work in Australia?', 'radio'), 'question')
check('years of experience', kind('How many years of React experience do you have?'), 'question')

// ─── Choosing an option ──────────────────────────────────────────
check('exact', pickOption('Yes', ['Yes', 'No']), 'Yes')
check('a sentence that starts with yes', pickOption('Yes, I am an Australian citizen.', ['Yes', 'No']), 'Yes')
check('a sentence that starts with no', pickOption('No — I would need sponsorship', ['Yes', 'No']), 'No')
check('contained', pickOption('4 weeks', ['Immediately', '2 weeks', '4 weeks', 'More than 4 weeks']), '4 weeks')
check('placeholder options are ignored', pickOption('Select', ['Select…', 'A', 'B']), null)
check('no confident match is null, not a guess', pickOption('Maybe', ['Yes', 'No']), null)
check('empty answer is null', pickOption('', ['Yes']), null)

// ─── Submission ──────────────────────────────────────────────────
check('greenhouse confirmation', looksSubmitted('Thank you for applying to Acme!'), true)
check('lever confirmation', looksSubmitted('Application submitted! We will be in touch.'), true)
check('received', looksSubmitted("We've received your application"), true)
check('a form is not a confirmation', looksSubmitted('Apply for this job. First name. Submit application'), false)

// ─── Contact details ─────────────────────────────────────────────
const resume = 'Jane Doe\njane_doe@mail.com | +61 412 345 678 | linkedin.com/in/janedoe | github.com/jdoe\n\nEXPERIENCE\n…'
const c = contactFor({ masterResume: resume, jobLocation: 'Sydney' })
check('name from the résumé', c.fullName, 'Jane Doe')
check('first name split', c.firstName, 'Jane')
check('last name split', c.lastName, 'Doe')
check('email from the résumé, underscores intact', c.email, 'jane_doe@mail.com')
check('phone from the résumé', c.phone, '+61 412 345 678')
check('linkedin from the résumé', c.linkedin, 'https://linkedin.com/in/janedoe')
check('github from the résumé', c.github, 'https://github.com/jdoe')
check('location from the search', c.location, 'Sydney')
check('settings win over the résumé', contactFor({ masterResume: resume, contactDetails: { email: 'work@me.dev' } }).email, 'work@me.dev')
check('a heading is not a name', nameFromResume('CURRICULUM VITAE\nJane'), '')
check('"Resume" is not a name', nameFromResume('Resume of Jane Doe'), '')
check('nothing found is blank, not invented', contactFor({ masterResume: 'Experience\nStuff' }).phone, '')

// ─── The panel escapes what it shows ─────────────────────────────
check('labels are escaped in the panel', statusHtml({ filled: [], left: ['<img src=x onerror=alert(1)>'], warnings: [] }).includes('<img'), false)

done()
