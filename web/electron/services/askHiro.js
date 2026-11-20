// Ask Hiro: questions about your own job search, in plain words.
//
// Everything Hiro knows is on one of nine pages, each answering the question
// its designer anticipated. "Which applications have gone quiet this week?",
// "how many Seek jobs reached interview?", "what do I owe Acme?" each needed
// the right page, the right filter and some arithmetic. This answers them
// directly, from a snapshot of the user's own data.
//
// Two rules hold it in place:
//
//   It answers from the data, not from the model's imagination. The snapshot is
//   the only source it is given, and the instructions say to say so when the
//   data does not hold the answer.
//
//   It never acts. It may SUGGEST one of a small set of actions (run a scan
//   with given keywords, open a page, set a follow-up date) and the suggestion
//   becomes a button the user presses. Anything it proposes outside that set is
//   dropped, and a follow-up is validated again when the user confirms it,
//   because the button may be pressed days later from a reopened thread. Job titles
//   and company names in the snapshot are written by employers, so the
//   snapshot is fenced as untrusted text like every other listing-derived
//   prompt in the app.

const database = require('./database')
const configService = require('./config')
const aiAdapter = require('./ai/index')
const { isAiConfigured } = require('./ai/configured')
const { fence, FENCE_RULES } = require('./ai/untrusted')
const { TAILOR_RESUME_RULES } = require('./ai/prompts')
const { inspectTailoring, inspectCoverLetter } = require('./fabricationGuard')

const MAX_APPLICATIONS = 80
const MAX_HISTORY = 10
// A question may be a pasted résumé or job ad, the way people use ChatGPT.
const MAX_QUESTION = 20000
// Per history turn sent back: long enough to carry a drafted résumé, so "now
// make it one page" works on the draft rather than on a truncated copy of it.
const MAX_TURN = 8000
const MAX_DOCUMENT = 40000
// A full résumé or cover letter needs room; a data question uses a few hundred
// tokens of this. It is a ceiling, not a cost.
const MAX_REPLY_TOKENS = 4000
// A follow-up further out than this is almost certainly a model mistake (a
// wrong year), and a past one would be overdue the moment it was saved.
const MAX_FOLLOW_UP_DAYS = 366

const PAGES = ['dashboard', 'pipeline', 'offers', 'review', 'attention', 'timeline', 'analytics', 'settings', 'workbench']

function daysSince(sqlUtc, now = Date.now()) {
  if (!sqlUtc) return null
  const t = new Date(String(sqlUtc).includes('T') ? sqlUtc : `${String(sqlUtc).replace(' ', 'T')}Z`).getTime()
  return isNaN(t) ? null : Math.floor((now - t) / 86400000)
}

// The user's local calendar date. Follow-up dates are local days (see
// database.setNextAction), so "today" has to be the same kind of day — the UTC
// date is yesterday or tomorrow for half the world for part of every day.
function localDate(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// What the model is shown. Compact on purpose: the fields people ask about,
// newest first, and nothing that is a document (résumés, letters, replies).
// The query selects only these fields, so no document is even read.
function snapshot({ now = Date.now() } = {}) {
  const stats = database.getStats()
  const apps = database.getApplicationsForAsk(MAX_APPLICATIONS)
    .map(a => ({
      id: a.id, title: a.job_title, company: a.company, platform: a.platform, status: a.status,
      score: a.match_score, salary: a.salary || undefined,
      appliedDaysAgo: daysSince(a.applied_at, now), lastChangeDaysAgo: daysSince(a.updated_at, now),
      nextAction: a.next_action_at ? `${a.next_action_at}${a.next_action_note ? ` — ${a.next_action_note}` : ''}` : undefined,
      resume: a.resume_name || undefined, note: a.comment ? String(a.comment).slice(0, 120) : undefined,
    }))
  const interviews = database.getUpcomingInterviews(15).map(i => ({ applicationId: i.application_id, company: i.company, title: i.job_title, when: i.scheduled_at }))
  let offers = []
  try {
    const o = database.getOffers()
    offers = (o?.offers || o || []).slice(0, 10).map(x => ({ company: x.company, title: x.job_title, base: x.base_salary, respondBy: x.respond_by, decision: x.decision }))
  } catch { /* optional */ }
  return {
    today: localDate(now),
    totals: {
      sentAllTime: stats.totalAllTime, sentThisWeek: stats.totalThisWeek, sentToday: stats.totalToday,
      interviews: stats.interviews, responseRate: stats.responseRate, interviewRate: stats.interviewRate,
      needsAttention: stats.attentionCount, heldForReview: stats.heldCount, byStatus: stats.byStatus, byPlatform: stats.byPlatform,
    },
    applications: apps,
    upcomingInterviews: interviews,
    offers,
  }
}

// The rules TAILOR_RESUME_RULES states for the automated tailoring, minus its
// closing "return only the résumé" line — here the résumé sits inside a marked
// block and comments are allowed around it.
const TAILOR_RULES_FOR_CHAT = TAILOR_RESUME_RULES.replace(/\n*Return ONLY[^\n]*$/, '')

const SYSTEM = `You are Hiro's assistant. You help the user with two things:
1. Questions about their own job search, answered from the JSON snapshot of their applications.
2. Their résumé and cover letters, like a careful human career coach, using the résumé and job ad they shared.

Job search questions:
- Answer ONLY from the JSON snapshot. If it does not contain the answer, say so plainly. Never invent applications, numbers or dates.
- When you mention a specific application, write it as "Job title at Company".
- "applied" status means sent and waiting; "held" means drafted but not sent; "skipped" means never sent.

Résumé help:
- The résumé is in the "MY RÉSUMÉ" block, or pasted into the conversation. If the user asks for résumé help and
  there is no résumé, ask them to attach one (the paperclip button, or drop a PDF or Word file on the chat) or paste it.
- Be specific: quote the line, say what is weak about it, and show the better version. Lead with the few changes
  that matter most rather than listing everything.
- When a job ad is shared ("JOB AD" block), say which of its requirements the résumé shows, which it does not, and
  give an honest fit estimate. Do not pretend a weak match is a strong one.
- NEVER invent experience, employers, job titles, dates, numbers, qualifications, tools or achievements. When a
  stronger line needs a fact the résumé does not give (a number, a result), write a placeholder in square
  brackets such as [number] or [result] and tell the user to fill it in or delete it.
- Write the way the candidate writes: plain verbs, their spelling convention, no buzzwords ("spearheaded",
  "leveraged", "results-driven", "passionate"), no em dashes in sentences.

Full documents:
- Only when the user asks for a complete résumé (rewritten, tailored, shortened and so on), put the WHOLE résumé
  between a line reading exactly <<<RESUME>>> and a line reading exactly <<<END>>>. Plain text only: the name and
  contact details first, exactly as written; section headings in capitals on their own line; bullets start with "• ".
- When tailoring to a job ad, also follow these rules:
${TAILOR_RULES_FOR_CHAT}
- Only when the user asks for a cover letter, put the whole letter between a line reading exactly
  <<<COVER_LETTER>>> and a line reading exactly <<<END>>>. Under 350 words, first person, from facts in the résumé.
- Put any comments outside the markers. For a single line or two, just write them inline without markers.

Style: be brief unless writing a document. Use short sentences or "- " bullet lists. No markdown headings, no bold.

Actions: you cannot change anything. You may SUGGEST up to two actions by ending your reply with one line:
  ACTIONS: [{"type":"scan","keywords":"..."}] or [{"type":"open","page":"pipeline"}] or [{"type":"openApplication","id":123}]
  or [{"type":"setFollowUp","id":123,"date":"YYYY-MM-DD","note":"Chase the recruiter"}]
  Valid pages: ${PAGES.join(', ')}. setFollowUp sets an application's next action date; use an id from the
  snapshot and a date on or after "today". The user confirms it before anything changes.
  Only suggest an action when it directly helps with what was asked. Omit the ACTIONS line otherwise.`

// What a conversation is about: the résumé and job ad the user attached.
// Bounded and plain strings whatever the renderer sent; null when empty.
function normalizeDocuments(documents) {
  if (!documents || typeof documents !== 'object') return null
  const docs = {
    resumeName: String(documents.resumeName || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    resumeText: String(documents.resumeText || '').trim().slice(0, MAX_DOCUMENT),
    jobText: String(documents.jobText || '').trim().slice(0, MAX_DOCUMENT),
  }
  return docs.resumeText || docs.jobText ? docs : null
}

// The documents the assistant wrote, in order: [{ kind, text }] where kind is
// 'resume' or 'coverLetter'. A block the model never closed (it ran out of
// room, or forgot) runs to the end of the reply rather than being lost.
// src/chatDrafts.js splits a reply the same way for display.
const DRAFT_OPEN = /^<<<(RESUME|COVER_LETTER)>>>$/
function extractDrafts(text) {
  const drafts = []
  let current = null
  const close = () => {
    if (current) {
      const body = current.lines.join('\n').trim()
      if (body) drafts.push({ kind: current.kind, text: body })
    }
    current = null
  }
  for (const line of String(text || '').split('\n')) {
    const t = line.trim()
    const open = DRAFT_OPEN.exec(t)
    if (open) { close(); current = { kind: open[1] === 'RESUME' ? 'resume' : 'coverLetter', lines: [] }; continue }
    if (t === '<<<END>>>') { close(); continue }
    if (current) current.lines.push(line)
  }
  close()
  return drafts
}

// One check per drafted document, against the résumé the user gave us. The
// same guard that stands between the automated tailoring and an employer: a
// date, credential or employer the résumé never mentioned is named, so a
// "polished" line that quietly grew a degree is caught before it is saved.
// Advisory here — the user is looking at the draft and decides.
function checkDrafts(reply, baseResume) {
  const base = String(baseResume || '').trim()
  return extractDrafts(reply).slice(0, 4).map(d => {
    if (!base) return { type: 'draft', kind: d.kind, checked: false, flags: [] }
    const res = d.kind === 'resume' ? inspectTailoring(base, d.text) : inspectCoverLetter(base, d.text)
    return {
      type: 'draft', kind: d.kind, checked: true,
      flags: res.flags.slice(0, 8).map(f => ({ kind: f.kind, value: String(f.value).slice(0, 80) })),
    }
  })
}

// What a draft is checked against when no résumé is attached: whatever the
// user pasted into the conversation themselves, if it is long enough to be a
// résumé. Their words, not the model's — and nothing at all is better than
// checking against a one-line question, which would flag every line.
function pastedReference(kept, q) {
  const userText = [...kept.filter(m => m.role === 'user').map(m => m.content), q]
  return userText.some(t => t.length > 400) ? userText.join('\n') : ''
}

// A real calendar day, today or later and within a year. Shared by the parse
// (what the model proposed) and the apply (what the user confirmed).
function validFollowUpDate(date, now = Date.now()) {
  const text = String(date || '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // Date rolls 2026-02-31 over to March; a round trip catches it.
  if (localDate(d.getTime()) !== text) return null
  const today = localDate(now)
  if (text < today) return null
  const [ty, tm, td] = today.split('-').map(Number)
  if ((d - new Date(ty, tm - 1, td)) / 86400000 > MAX_FOLLOW_UP_DAYS) return null
  return text
}

function cleanNote(note) {
  return String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

// The ACTIONS line, validated. Anything outside the allowed shapes is dropped.
// `validIds` is a Set of the snapshot's ids, or a Map of id → application,
// in which case a follow-up carries the title and company for its button.
function parseActions(text, validIds = new Set(), { now = Date.now() } = {}) {
  const m = /\n?\s*ACTIONS:\s*(\[[\s\S]*\])\s*$/.exec(String(text || ''))
  if (!m) return { reply: String(text || '').trim(), actions: [] }
  let raw = []
  try { raw = JSON.parse(m[1]) } catch { raw = [] }
  const actions = []
  for (const a of Array.isArray(raw) ? raw.slice(0, 2) : []) {
    if (a?.type === 'scan' && typeof a.keywords === 'string' && a.keywords.trim() && a.keywords.length <= 200) {
      actions.push({ type: 'scan', keywords: a.keywords.trim() })
    } else if (a?.type === 'open' && PAGES.includes(a.page)) {
      actions.push({ type: 'open', page: a.page })
    } else if (a?.type === 'openApplication' && validIds.has(Number(a.id))) {
      actions.push({ type: 'openApplication', id: Number(a.id) })
    } else if (a?.type === 'setFollowUp' && validIds.has(Number(a.id)) && validFollowUpDate(a.date, now)) {
      const app = validIds instanceof Map ? validIds.get(Number(a.id)) : null
      actions.push({
        type: 'setFollowUp', id: Number(a.id), date: validFollowUpDate(a.date, now), note: cleanNote(a.note),
        ...(app ? { title: String(app.title || ''), company: String(app.company || '') } : {}),
      })
    }
  }
  return { reply: String(text).slice(0, m.index).trim(), actions }
}

// One turn. `history` is the conversation so far, [{ role, content }], as the
// renderer holds it; only the tail is sent.
//
// `documents` is what the conversation is about ({ resumeName, resumeText,
// jobText }), or nothing. Both are fenced as untrusted: a job ad is written by
// an employer, and a résumé may be someone else's file the user was sent.
//
// `onText(textSoFar)` receives the reply as it is written; `signal` (an
// AbortSignal) stops it. A stopped reply keeps what was written so far and
// comes back with `stopped: true`; one stopped before any text throws an error
// marked `stopped`.
async function ask(question, history = [], { cfg = configService.load(), now = Date.now(), documents = null, onText = null, signal = null } = {}) {
  const q = String(question || '').trim()
  if (!q) throw new Error('Ask a question first.')
  if (q.length > MAX_QUESTION) throw new Error('That message is too long. Attach the document instead of pasting it.')
  if (!isAiConfigured(cfg)) throw new Error('Set up an AI provider in Settings to use Ask Hiro.')

  const docs = normalizeDocuments(documents)
  const snap = snapshot({ now })
  const validIds = new Map(snap.applications.map(a => [a.id, a]))
  const blocks = [FENCE_RULES]
  if (docs?.resumeText) blocks.push(fence(`MY RÉSUMÉ${docs.resumeName ? ` (${docs.resumeName})` : ''}`, docs.resumeText))
  if (docs?.jobText) blocks.push(fence('JOB AD I AM LOOKING AT', docs.jobText))
  blocks.push(fence('MY JOB SEARCH DATA (JSON)', JSON.stringify(snap), 60000))
  const context = blocks.join('\n\n')
  const kept = modelHistory(history)
  const turns = kept
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_TURN) }))

  // The data rides with the first message of the window rather than the
  // system prompt, so it is fenced exactly like every other untrusted input.
  const messages = turns.length
    ? [{ role: 'user', content: `${context}\n\n${turns[0].role === 'user' ? turns[0].content : ''}` }, ...turns.slice(turns[0].role === 'user' ? 1 : 0), { role: 'user', content: q }]
    : [{ role: 'user', content: `${context}\n\n${q}` }]
  // Models require alternating roles; merge any two adjacent user turns.
  const merged = []
  for (const m of messages) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += `\n\n${m.content}`
    else merged.push({ ...m })
  }

  let partial = ''
  const streamed = (textSoFar) => {
    partial = String(textSoFar || '')
    if (onText) { try { onText(partial.replace(/\*\*/g, '')) } catch { /* the display is not the answer */ } }
  }
  let text
  let stopped = false
  try {
    text = await untilStopped(aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
      operation: 'askHiro', tier: 'smart', maxTokens: MAX_REPLY_TOKENS, system: SYSTEM, messages: merged,
      ...(onText ? { onText: streamed } : {}), ...(signal ? { signal } : {}),
    }, cfg.geminiModel), signal)
  } catch (err) {
    if (!signal?.aborted) throw err
    if (!partial.trim()) throw Object.assign(new Error('Stopped before Hiro answered.'), { stopped: true })
    text = partial
    stopped = true
  }
  // A half-written ACTIONS line is not a suggestion anyone made.
  const finished = stopped ? String(text).replace(/\n?\s*ACTIONS:[^\n]*$/, '') : text
  const parsed = parseActions(String(finished || '').replace(/\*\*/g, ''), validIds, { now })
  const reference = docs?.resumeText || pastedReference(kept, q)
  return { ...parsed, actions: [...parsed.actions, ...checkDrafts(parsed.reply, reference)], ...(stopped ? { stopped: true } : {}) }
}

// Settles as soon as `signal` aborts, whether or not the provider's own request
// noticed. Every adapter passes the signal on, but the user's Stop must not
// depend on that: the late answer, if one arrives, is simply not used.
function untilStopped(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }))
  promise.catch(() => { /* settled after Stop; nobody is waiting */ })
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

// What of a stored conversation goes back to the model. An error turn ("Set
// up an AI provider…", a timeout) is Hiro talking, not the assistant: sent
// back as an assistant message it taught the model to repeat the failure, so
// it is dropped, together with the question it failed to answer — that
// question is either asked again or abandoned, and either way it is not
// context the next answer should build on.
function modelHistory(history) {
  const list = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  return list.filter((m, i) => !m.error && !(m.role === 'user' && list[i + 1]?.error))
}

function threadTitle(question) {
  const q = String(question || '').replace(/\s+/g, ' ').trim()
  return q.length > 60 ? `${q.slice(0, 59)}…` : q
}

// One turn of a stored conversation. The history comes from the database, not
// the renderer, so a thread reopened tomorrow continues where it left off. The
// question and its answer — or its error — are written together, once.
//
// `opts.documents` replaces what the thread is about (an empty object clears
// it); left undefined, the thread's stored résumé and job ad are used.
async function askInThread(question, threadId = null, opts = {}) {
  const thread = threadId ? database.getAskThread(threadId) : null
  const q = String(question || '').trim()
  const given = opts.documents !== undefined
  const documents = normalizeDocuments(given ? opts.documents : thread?.documents)
  const stored = given ? (documents || { resumeName: '', resumeText: '', jobText: '' }) : undefined
  // A pasted résumé makes a poor title; the attachment's name is better.
  const title = threadTitle(q.length > 200 && documents?.resumeName ? `${documents.resumeName}: ${q}` : q)
  try {
    const res = await ask(q, thread?.messages || [], { ...opts, documents })
    const id = database.appendAskTurn(thread?.id, [
      { role: 'user', content: q },
      { role: 'assistant', content: res.reply, actions: res.actions },
    ], { title, documents: stored })
    return { ...res, threadId: id }
  } catch (err) {
    // An empty question was never asked; there is nothing to keep.
    if (!q) throw err
    const id = database.appendAskTurn(thread?.id, [
      { role: 'user', content: q.slice(0, MAX_QUESTION) },
      { role: 'assistant', content: err.message, error: true },
    ], { title, documents: stored })
    err.threadId = id
    throw err
  }
}

// The follow-up the user confirmed. Everything is checked again here: the
// renderer is not trusted, and a suggestion from a reopened thread may name an
// application that has since been deleted or a date that has since passed.
function applyFollowUp(id, date, note, { now = Date.now() } = {}) {
  const appId = Number(id)
  if (!Number.isInteger(appId) || appId <= 0) return { success: false, error: 'That application id is not valid.' }
  if (!database.applicationExists(appId)) {
    return { success: false, error: 'That application no longer exists.' }
  }
  const day = validFollowUpDate(date, now)
  if (!day) return { success: false, error: 'Choose a follow-up date from today onwards, within a year.' }
  const res = database.setNextAction(appId, { date: day, note: cleanNote(note) })
  return res?.success ? { success: true, date: day } : { success: false, error: res?.reason || 'Could not set the follow-up.' }
}

module.exports = {
  ask, askInThread, applyFollowUp, snapshot, parseActions, modelHistory, validFollowUpDate,
  extractDrafts, checkDrafts, normalizeDocuments, PAGES,
}
