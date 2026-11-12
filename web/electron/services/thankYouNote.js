// The thank-you note after an interview.
//
// Hiro knows when each interview was (interview_events) and puts "Send a
// thank-you note" in the task inbox for a few days after it (featureHub). This
// drafts the note itself, for the user to edit and send from their own mail app
// — nothing here sends anything.
//
// The model does not know what was said in the interview, and a thank-you note
// that invents a conversation ("I enjoyed our discussion of your Kafka
// migration") is worse than none: the interviewer knows it did not happen. So
// the draft carries one clearly marked placeholder for the user to fill with
// something that really came up, and the prompt forbids inventing anything
// else. The employer's own messages are fenced like every other input written
// by someone else.

const configService = require('./config')
const database = require('./database')
const aiAdapter = require('./ai/index')
const { isAiConfigured } = require('./ai/configured')
const { fence, FENCE_RULES } = require('./ai/untrusted')
const { stripMarkdown } = require('./ai/markdown')

const PLACEHOLDER = '[one specific thing you discussed]'

const SYSTEM = `You write short, sincere thank-you emails that a job candidate sends after an interview.
Rules:
- 110 to 170 words. Plain text, no markdown, no bullet points.
- Thank them for their time, restate genuine interest in the role, and connect it to one strength from the candidate's resume.
- You do not know what was said in the interview. Never invent topics, people, projects or anything else from it.
  Include the exact placeholder ${PLACEHOLDER} once, where the candidate should mention something that really came up.
- No salary, no questions about the decision timeline, no apology, no flattery.
- Start with a line "Subject: ..." then a blank line, then the email. Sign off with the candidate's name if the resume gives it, otherwise "[Your name]".`

function interviewPrompt({ app, interview, replies, resume }) {
  const when = String(interview.scheduled_at || '').slice(0, interview.has_time ? 16 : 10)
  return `Write the thank-you email for this interview.

Role: ${app.job_title}
Company: ${app.company}
Interview: ${when}${interview.note ? `\nThe candidate's own note about the interview (theirs, may be used): ${String(interview.note).slice(0, 400)}` : ''}

${FENCE_RULES}

${replies ? fence('EMPLOYER MESSAGES', replies, 2500) : ''}

${fence('JOB', app.job_description || '', 800)}

RESUME: ${String(resume || '').slice(0, 1200)}`
}

// "Subject: …\n\nbody" → { subject, body }. A reply without the subject line is
// taken whole as the body, with a plain subject, rather than refused.
function parseDraft(text, app) {
  const clean = stripMarkdown(String(text || '')).replace(/\r\n/g, '\n').trim()
  const m = clean.match(/^subject:\s*(.+)\n+([\s\S]*)$/i)
  const subject = (m ? m[1] : `Thank you — ${app.job_title} interview`).trim().slice(0, 200)
  let body = (m ? m[2] : clean).trim()
  // The model was told to include the placeholder. If it did not, add it, so the
  // draft never looks finished when it is missing the one line that makes it real.
  if (!body.includes(PLACEHOLDER)) {
    body = body.replace(/\n\n/, `\n\nI especially enjoyed talking about ${PLACEHOLDER}.\n\n`)
    if (!body.includes(PLACEHOLDER)) body = `${body}\n\nI especially enjoyed talking about ${PLACEHOLDER}.`
  }
  return { subject, body }
}

async function draft(interviewId, { cfg = configService.load() } = {}) {
  const interview = database.getInterviewEvent(Number(interviewId))
  if (!interview) return { success: false, error: 'That interview no longer exists.' }
  const app = database.getApplication(interview.application_id)
  if (!app) return { success: false, error: 'The application for this interview no longer exists.' }
  if (!isAiConfigured(cfg)) return { success: false, error: 'Set up an AI provider in Settings to draft a thank-you note.' }

  const replies = database.getReplyContext(app.id, { maxChars: 2500 })
  const text = await aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
    operation: 'thankYouNote', tier: 'smart', maxTokens: 600, system: SYSTEM,
    messages: [{ role: 'user', content: interviewPrompt({ app, interview, replies, resume: cfg.masterResume }) }],
  }, cfg.geminiModel)
  const { subject, body } = parseDraft(text, app)
  return { success: true, to: app.recruiter_email || '', subject, body, placeholder: PLACEHOLDER }
}

module.exports = { draft, parseDraft, interviewPrompt, PLACEHOLDER }
