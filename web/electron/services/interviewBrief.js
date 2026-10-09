// One page to read the night before an interview.
//
// Everything in it was already somewhere in Hiro — the interview time, what
// the recruiter wrote, the likely questions, the answers worked out for them,
// the notes — but in five places, and the evening before is exactly when nobody
// wants to go looking. This puts them together, adds what has been in the news
// about the employer, and sends it to the phone the evening before.
//
// Composed on read rather than stored: every part has its own home already, and
// a stored copy would go stale the moment an answer was edited. The only things
// that cost anything — the questions and the news — are cached where they live.

const database = require('./database')
const configService = require('./config')
const aiAdapter = require('./ai/index')
const { isAiConfigured } = require('./ai/configured')
const companyResearch = require('./companyResearch')
const push = require('./push')

// Good questions to ask an interviewer are not specific to the job, and a model
// call to produce them would cost money every time for the same five.
const QUESTIONS_TO_ASK = [
  'What would success look like in the first 90 days?',
  'What is the biggest challenge the team is facing right now?',
  'How is the team structured, and who would I work with most closely?',
  'What do people who do well here have in common?',
  'What are the next steps in the process, and when should I expect to hear back?',
]

// interview_events.scheduled_at is local "YYYY-MM-DD HH:MM:SS".
function parseLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''))
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
}

function nextInterview(applicationId, now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return database.getInterviewEvents(applicationId)
    .map(e => ({ ...e, when: parseLocal(e.scheduled_at) }))
    .filter(e => e.when && e.when.getTime() >= startOfToday)
    .sort((a, b) => a.when - b.when)[0] || null
}

function snippet(text, n = 600) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Generate and cache the likely questions when there are none yet. The same
// call the job panel makes, with the employer's own replies as context.
async function ensureQuestions(app, cfg) {
  const existing = database.getInterviewPrep(app.id)
  if (Array.isArray(existing) && existing.length) return
  if (!isAiConfigured(cfg)) return
  let replyContext = ''
  try { replyContext = database.getReplyContext(app.id) } catch { /* optional */ }
  const questions = await aiAdapter.generateInterviewQuestions(
    cfg.aiProvider, cfg.aiApiKey, app.job_description || app.job_title,
    app.tailored_resume || cfg.masterResume || '', cfg.geminiModel, replyContext
  )
  if (Array.isArray(questions) && questions.length) database.saveInterviewPrep(app.id, questions)
}

// The brief for one application. `generate` allows the two paid lookups
// (questions, news); without it only what is already cached is used — the
// phone's read of a brief must never spend money.
async function buildBrief(applicationId, { generate = true, refreshResearch = false, cfg = configService.load(), fetchImpl } = {}) {
  const app = database.getApplication(applicationId)
  if (!app) throw new Error('Application not found.')

  if (generate) {
    try { await ensureQuestions(app, cfg) } catch { /* a brief without questions is still a brief */ }
  }
  const research = generate
    ? await companyResearch.research(app.company, { cfg, fetchImpl, refresh: refreshResearch })
    : companyResearch.cachedResearch(app.company)

  const interview = nextInterview(applicationId)
  const questions = (database.getInterviewPrepWithAnswers(applicationId) || []).map(q => {
    const base = typeof q === 'string' ? { question: q } : q
    // `answer` is the model's sample; `savedAnswer` is the user's own, from the
    // answer bank, and wins wherever both are shown.
    return { question: base.question, category: base.category || '', sampleAnswer: base.answer || '', savedAnswer: base.savedAnswer || '' }
  }).filter(q => q.question)

  const replies = (database.getRecruiterReplies(applicationId, 3) || []).map(r => ({
    from: r.from_address || '',
    subject: r.subject || '',
    receivedAt: r.received_at || r.created_at || '',
    excerpt: snippet(r.body, 600),
  }))

  return {
    applicationId,
    jobTitle: app.job_title,
    company: app.company,
    jobUrl: app.job_url || '',
    salary: app.salary || '',
    interview: interview ? {
      id: interview.id, scheduledAt: interview.scheduled_at, hasTime: !!interview.has_time,
      note: interview.note || '', sourceZone: interview.source_zone || null, sourceLocal: interview.source_local || null,
    } : null,
    replies,
    questions,
    answered: questions.filter(q => q.savedAnswer).length,
    research: research ? { summary: research.summary || '', headlines: research.headlines || [], fetchedAt: research.fetchedAt || null } : null,
    questionsToAsk: QUESTIONS_TO_ASK,
    notes: app.comment || '',
    jobSummary: snippet(app.job_description, 900),
  }
}

// ─── The evening before ──────────────────────────────────────────
// Every interview tomorrow gets its brief prepared and announced once, after
// `interviewBriefHour` (default 18:00) local time. A desktop that was asleep
// at six still sends it when it wakes, up until the interview itself.
async function runDue({ now = new Date(), cfg = configService.load(), notify = () => {} } = {}) {
  if (cfg.interviewBriefEnabled === false) return []
  const hour = Number.isFinite(Number(cfg.interviewBriefHour)) ? Number(cfg.interviewBriefHour) : 18
  const sent = []
  for (const ev of database.getUpcomingInterviews(50)) {
    const when = parseLocal(ev.scheduled_at)
    if (!when) continue
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const isTomorrow = when.getFullYear() === tomorrow.getFullYear() && when.getMonth() === tomorrow.getMonth() && when.getDate() === tomorrow.getDate()
    const isToday = when.toDateString() === now.toDateString() && when > now
    const due = (isTomorrow && now.getHours() >= hour) || isToday
    if (!due) continue
    // One brief per interview time; a reschedule earns a fresh one.
    const key = `brief:${ev.id}:${ev.scheduled_at}`
    if (!database.claimPushKey(`${key}:prepared`, 'interview-brief', ev.company, ev.job_title)) continue
    let brief
    try { brief = await buildBrief(ev.application_id, { cfg }) } catch { continue }
    const extras = [
      brief.questions.length ? `${brief.questions.length} likely questions${brief.answered ? `, ${brief.answered} with your answers` : ''}` : null,
      brief.research?.headlines?.length ? 'recent news' : null,
      brief.replies.length ? 'what they said' : null,
    ].filter(Boolean).join(', ')
    const whenText = ev.has_time
      ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : 'date to confirm'
    const title = `Interview brief: ${ev.company}`
    const body = `${isToday ? 'Today' : 'Tomorrow'} ${whenText} — ${ev.job_title}.${extras ? ` Ready: ${extras}.` : ''}`
    notify(title, body)
    await push.send({
      kind: 'interview',
      dedupeKey: key,
      title,
      body,
      data: { applicationId: ev.application_id, interviewId: ev.id, screen: 'brief' },
    })
    sent.push({ interviewId: ev.id, applicationId: ev.application_id })
  }
  return sent
}

// Plain-text form, for copying or emailing.
function toText(brief) {
  const lines = [`${brief.jobTitle} — ${brief.company}`]
  if (brief.interview) lines.push(`When: ${brief.interview.scheduledAt}${brief.interview.sourceLocal ? ` (they wrote ${brief.interview.sourceLocal})` : ''}`)
  if (brief.notes) lines.push('', 'Your notes', brief.notes)
  if (brief.replies.length) {
    lines.push('', 'What they said')
    for (const r of brief.replies) lines.push(`- ${r.subject}: ${r.excerpt}`)
  }
  if (brief.research?.summary) lines.push('', 'In the news', brief.research.summary)
  if (brief.questions.length) {
    lines.push('', 'Likely questions')
    for (const q of brief.questions) {
      const answer = q.savedAnswer ? `\n  Your answer: ${q.savedAnswer}` : q.sampleAnswer ? `\n  Draft: ${q.sampleAnswer}` : ''
      lines.push(`- ${q.question}${answer}`)
    }
  }
  lines.push('', 'Questions to ask', ...brief.questionsToAsk.map(q => `- ${q}`))
  return lines.join('\n')
}

module.exports = { buildBrief, runDue, toText, nextInterview, QUESTIONS_TO_ASK }
