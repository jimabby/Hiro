// Keeping what the employer actually wrote, and turning it into prompt context.
//
// The inbox check already downloaded these bodies to classify them and then
// discarded them. They are the only record of the interview format, the panel
// and the round — none of which the job ad knows — so prep built without them
// is preparing for a different conversation.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-replies-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { interviewQuestionsPrompt } = require(path.join(__dirname, '..', 'electron', 'services', 'ai', 'prompts'))
const { check, done } = createChecker()

function add(jobUrl) {
  db.insertApplication({
    job_title: 'Engineer', company: 'Example', platform: 'Seek', job_url: jobUrl,
    salary: '', job_description: '', match_score: 80, match_explanation: '',
    tailored_resume: '', screening_qa: [], status: 'applied',
  })
  return db.getApplications().find(a => a.job_url === jobUrl).id
}

async function main() {
  await db.init()
  const id = add('https://r/1')

  check('a reply needs an application', db.saveRecruiterReply({ subject: 'x' }).success, false)
  check('no replies is an empty context', db.getReplyContext(id), '')
  check('no replies is an empty list', db.getRecruiterReplies(id).length, 0)

  db.saveRecruiterReply({
    applicationId: id, uid: 10, from: 'jo@example.com',
    subject: 'Interview invitation',
    body: 'We would like to invite you to a technical panel with Sam and Alex.',
    classifiedAs: 'interview', receivedAt: '2026-01-02T09:00:00Z',
  })
  check('a reply is stored', db.getRecruiterReplies(id).length, 1)
  check('the body is kept', /technical panel/.test(db.getRecruiterReplies(id)[0].body), true)

  // The same message re-read on a later inbox pass must not become a second
  // copy — a duplicated reply would weight the prompt towards whichever email
  // happened to be fetched twice.
  db.saveRecruiterReply({
    applicationId: id, uid: 10, from: 'jo@example.com',
    subject: 'Interview invitation',
    body: 'We would like to invite you to a technical panel with Sam and Alex.',
    classifiedAs: 'interview', receivedAt: '2026-01-02T09:00:00Z',
  })
  check('re-reading the same email does not duplicate it', db.getRecruiterReplies(id).length, 1)

  db.saveRecruiterReply({
    applicationId: id, uid: 11, from: 'jo@example.com',
    subject: 'Re: Interview invitation',
    body: 'The panel will focus on system design.',
    classifiedAs: 'interview', receivedAt: '2026-01-03T09:00:00Z',
  })

  const context = db.getReplyContext(id)
  check('the context carries both replies',
    /technical panel/.test(context) && /system design/.test(context), true)
  // Oldest first, so the model reads the thread in the order it happened.
  check('the thread reads in order',
    context.indexOf('technical panel') < context.indexOf('system design'), true)

  // The list is newest first — that is what a UI wants — while the context is
  // oldest first. Both orderings are deliberate and both matter.
  check('the list is newest first', db.getRecruiterReplies(id)[0].uid, 11)

  // A very long body must be truncated on write, not carried whole: sql.js
  // rewrites the entire database file on every save.
  const other = add('https://r/2')
  db.saveRecruiterReply({ applicationId: other, uid: 1, subject: 's', body: 'x'.repeat(50000) })
  check('an oversized body is truncated', db.getRecruiterReplies(other)[0].body.length <= 8000, true)

  // The whole context is budgeted, so one enormous email cannot crowd out the
  // rest of the thread or blow the prompt.
  check('the context is budgeted', db.getReplyContext(other, { maxChars: 500 }).length <= 500, true)

  // Replies belong to one application only.
  check('replies do not leak between applications', db.getRecruiterReplies(id).length, 2)

  // ─── The prompt itself ─────────────────────────────────────────
  const without = interviewQuestionsPrompt('Job ad text', 'Resume text', '')
  check('with no replies the prompt is the plain one', /EMPLOYER MESSAGES/.test(without), false)
  check('the plain prompt still carries the job', /Job ad text/.test(without), true)

  const with_ = interviewQuestionsPrompt('Job ad text', 'Resume text', context)
  check('with replies the prompt includes them', /EMPLOYER MESSAGES/.test(with_), true)
  check('the replies reach the prompt', /system design/.test(with_), true)
  check('the prompt still carries the job ad', /Job ad text/.test(with_), true)
  // The correspondence has to outrank the ad, or it is decoration.
  check('the prompt says the messages lead', /PRIMARY guide/.test(with_), true)
  // Guarding against the model inventing a panel that was never mentioned.
  check('the prompt forbids invention', /Do not invent/.test(with_), true)

  check('a null reply context is safe', /EMPLOYER MESSAGES/.test(interviewQuestionsPrompt('a', 'b', null)), false)
  check('a whitespace reply context is treated as none',
    /EMPLOYER MESSAGES/.test(interviewQuestionsPrompt('a', 'b', '   \n ')), false)

  // Deleting the application takes the correspondence with it. These are the
  // most sensitive rows in the database — someone else's words about the user.
  db.deleteApplication(id)
  check('deleting an application removes its replies', db.getRecruiterReplies(id).length, 0)

  done()
}

main()
