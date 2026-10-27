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

const MAX_APPLICATIONS = 80
const MAX_HISTORY = 10
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

const SYSTEM = `You are Hiro's assistant. You answer the user's questions about their own job search using ONLY the
JSON snapshot provided. Rules:
- If the snapshot does not contain the answer, say so plainly. Never invent applications, numbers or dates.
- Be brief. Use short sentences or "- " bullet lists. No markdown headings, no bold.
- When you mention a specific application, write it as "Job title at Company".
- "applied" status means sent and waiting; "held" means drafted but not sent; "skipped" means never sent.
- You cannot change anything. You may SUGGEST up to two actions by ending your reply with one line:
  ACTIONS: [{"type":"scan","keywords":"..."}] or [{"type":"open","page":"pipeline"}] or [{"type":"openApplication","id":123}]
  or [{"type":"setFollowUp","id":123,"date":"YYYY-MM-DD","note":"Chase the recruiter"}]
  Valid pages: ${PAGES.join(', ')}. setFollowUp sets an application's next action date; use an id from the
  snapshot and a date on or after "today". The user confirms it before anything changes.
  Only suggest an action when it directly helps with what was asked. Omit the ACTIONS line otherwise.`

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
async function ask(question, history = [], { cfg = configService.load(), now = Date.now() } = {}) {
  const q = String(question || '').trim()
  if (!q) throw new Error('Ask a question first.')
  if (q.length > 2000) throw new Error('That question is too long.')
  if (!isAiConfigured(cfg)) throw new Error('Set up an AI provider in Settings to use Ask Hiro.')

  const snap = snapshot({ now })
  const validIds = new Map(snap.applications.map(a => [a.id, a]))
  const context = `${FENCE_RULES}\n\n${fence('MY JOB SEARCH DATA (JSON)', JSON.stringify(snap), 60000)}`
  const turns = modelHistory(history)
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))

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

  const text = await aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
    operation: 'askHiro', tier: 'smart', maxTokens: 900, system: SYSTEM, messages: merged,
  }, cfg.geminiModel)
  return parseActions(String(text || '').replace(/\*\*/g, ''), validIds, { now })
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
async function askInThread(question, threadId = null, opts = {}) {
  const thread = threadId ? database.getAskThread(threadId) : null
  const q = String(question || '').trim()
  try {
    const res = await ask(q, thread?.messages || [], opts)
    const id = database.appendAskTurn(thread?.id, [
      { role: 'user', content: q },
      { role: 'assistant', content: res.reply, actions: res.actions },
    ], { title: threadTitle(q) })
    return { ...res, threadId: id }
  } catch (err) {
    // An empty question was never asked; there is nothing to keep.
    if (!q) throw err
    const id = database.appendAskTurn(thread?.id, [
      { role: 'user', content: q.slice(0, 2000) },
      { role: 'assistant', content: err.message, error: true },
    ], { title: threadTitle(q) })
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

module.exports = { ask, askInThread, applyFollowUp, snapshot, parseActions, modelHistory, validFollowUpDate, PAGES }
