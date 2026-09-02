// Your own answers to interview questions, kept once and reused.
//
// Interview Questions produced questions and had nowhere to put the answers, so
// a STAR story worked out for one panel was worked out again from scratch for
// the next.
//
// The design decision the tests are mostly about: entries are keyed on a
// normalised form of the question, because employers ask the identical thing
// with different punctuation and different openers, and a bank that stores each
// variant separately is a list rather than a bank. The matching is exact on that
// normalised key and deliberately not fuzzy — being shown nothing is a much
// cheaper mistake than being shown someone else's answer confidently, in front
// of a real interview question.

const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-answers-'))
process.env.HIRO_CONFIG_DIR = DIR

const { createChecker } = require('./helpers')
const database = require('../electron/services/database')
const { check, done } = createChecker()

;(async () => {
  await database.init()

  // ── Normalisation ──────────────────────────────────────────────
  const key = database.answerKey
  check('case is ignored',
    key('Tell me about a time you handled conflict'),
    key('TELL ME ABOUT A TIME YOU HANDLED CONFLICT'))
  check('trailing punctuation is ignored',
    key('Tell me about a time you handled conflict.'),
    key('Tell me about a time you handled conflict'))
  check('surrounding whitespace is ignored',
    key('  Tell me about a time you handled conflict  '),
    key('Tell me about a time you handled conflict'))
  check('collapsed whitespace is ignored',
    key('Tell  me   about a time'), key('Tell me about a time'))
  // The opener is the part employers vary most and mean least by.
  check('"describe" and "tell me about" reach the same entry',
    key('Describe a time you missed a deadline'),
    key('Tell me about a time you missed a deadline'))
  check('"walk me through" too',
    key('Walk me through a time you missed a deadline'),
    key('Tell me about a time you missed a deadline'))

  // Different questions must stay different. A key that collapsed these would
  // put the wrong answer in front of a real question.
  check('different questions get different keys',
    key('Why do you want to leave your current role') === key('Why do you want this role'), false)

  // ── Saving and reading back ────────────────────────────────────
  const Q = 'Tell me about a time you handled conflict.'
  database.saveInterviewAnswer({ question: Q, answer: 'I mediated between two teams…', source: 'ai', category: 'behavioral' })
  check('an answer can be read back', database.getInterviewAnswer(Q).answer, 'I mediated between two teams…')
  check('by a differently worded version of the same question',
    database.getInterviewAnswer('describe a time you handled conflict')?.answer,
    'I mediated between two teams…')
  check('an unknown question returns nothing',
    database.getInterviewAnswer('What is your favourite colour?'), null)
  check('an empty question returns nothing', database.getInterviewAnswer(''), null)

  // ── An AI draft is not yet an answer ───────────────────────────
  // The UI says so, and it can only say so because the source is recorded. An
  // unedited draft and something the candidate has actually decided to say are
  // different things.
  check('an AI draft is marked as one', database.getInterviewAnswer(Q).source, 'ai')
  database.saveInterviewAnswer({ question: Q, answer: 'In my own words…', source: 'user' })
  check('editing it makes it the user\'s own', database.getInterviewAnswer(Q).source, 'user')
  check('and replaces the text', database.getInterviewAnswer(Q).answer, 'In my own words…')
  check('without creating a second entry', database.listInterviewAnswers().length, 1)
  // The category came from the generated question and should survive an edit
  // that does not mention one.
  check('the category survives an edit', database.getInterviewAnswer(Q).category, 'behavioral')

  // ── Usage ──────────────────────────────────────────────────────
  check('a new entry has not been used', database.getInterviewAnswer(Q).times_used, 0)
  database.markInterviewAnswerUsed(Q, 42)
  database.markInterviewAnswerUsed(Q, 43)
  check('use is counted', database.getInterviewAnswer(Q).times_used, 2)
  check('and the last application is recorded', database.getInterviewAnswer(Q).last_used_application_id, 43)

  // ── Listing and search ─────────────────────────────────────────
  database.saveInterviewAnswer({ question: 'Why do you want to leave your current role?', answer: 'Looking for more ownership.' })
  database.saveInterviewAnswer({ question: 'What is your greatest weakness?', answer: 'I over-invest in tooling.' })
  check('every entry is listed', database.listInterviewAnswers().length, 3)
  // The ones that keep coming up belong at the top.
  check('the most used sorts first', database.listInterviewAnswers()[0].question, Q)
  check('search matches the question', database.listInterviewAnswers({ search: 'weakness' }).length, 1)
  check('and the answer text', database.listInterviewAnswers({ search: 'ownership' }).length, 1)
  check('search is case-insensitive', database.listInterviewAnswers({ search: 'OWNERSHIP' }).length, 1)
  check('a search matching nothing returns nothing',
    database.listInterviewAnswers({ search: 'zzzz' }).length, 0)

  // ── Deleting ───────────────────────────────────────────────────
  database.deleteInterviewAnswer('describe a time you handled conflict')
  check('a differently worded question deletes the same entry',
    database.getInterviewAnswer(Q), null)
  check('and the rest survive', database.listInterviewAnswers().length, 2)

  // ── Prep carries the bank ──────────────────────────────────────
  // This is the whole value: the second time a question comes up, the answer is
  // already there rather than being worked out again.
  const app = database.insertApplication({
    job_title: 'Data Engineer', company: 'Acme', platform: 'Seek', salary: '',
    job_url: 'https://example.test/prep', job_description: 'd', match_score: 80,
    match_explanation: '', tailored_resume: '', cover_letter: '', screening_qa: [],
    status: 'applied', closing_date: null, resume_id: null, resume_name: null, recruiter_email: '',
  })
  database.saveInterviewPrep(app.id, [
    { question: 'What is your greatest weakness?', answer: 'Generated answer', category: 'behavioral' },
    { question: 'How do you approach schema design?', answer: 'Generated answer', category: 'technical' },
  ])
  const prep = database.getInterviewPrepWithAnswers(app.id)
  // Same shape as getInterviewPrep — a plain array — so no caller has to know
  // which of the two it called.
  check('prep comes back as an array', Array.isArray(prep), true)
  check('a question with a saved answer carries it', prep[0].savedAnswer, 'I over-invest in tooling.')
  check('and says whose it is', prep[0].savedSource, 'user')
  check('a question without one carries nothing', prep[1].savedAnswer, undefined)
  check('and the generated answer is untouched either way', prep[0].answer, 'Generated answer')

  // ── The bank is standalone data ────────────────────────────────
  // It is not attached to an application: the answer to "why are you leaving
  // your current role" belongs to the candidate, not to whichever employer
  // happened to ask it first.
  database.deleteApplication(app.id)
  check('deleting the application leaves the bank alone',
    database.listInterviewAnswers().length, 2)

  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
