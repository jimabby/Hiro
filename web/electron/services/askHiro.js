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
//   with given keywords, open a page) and the suggestion becomes a button the
//   user presses. Anything it proposes outside that set is dropped. Job titles
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

const PAGES = ['dashboard', 'pipeline', 'offers', 'review', 'attention', 'timeline', 'analytics', 'settings', 'workbench']

function daysSince(sqlUtc, now = Date.now()) {
  if (!sqlUtc) return null
  const t = new Date(String(sqlUtc).includes('T') ? sqlUtc : `${String(sqlUtc).replace(' ', 'T')}Z`).getTime()
  return isNaN(t) ? null : Math.floor((now - t) / 86400000)
}

// What the model is shown. Compact on purpose: the fields people ask about,
// newest first, and nothing that is a document (résumés, letters, replies).
function snapshot({ now = Date.now() } = {}) {
  const stats = database.getStats()
  const apps = database.getApplications()
    .sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')))
    .slice(0, MAX_APPLICATIONS)
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
    today: new Date(now).toISOString().slice(0, 10),
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
  Valid pages: ${PAGES.join(', ')}. Only suggest an action when it directly helps with what was asked.
  Omit the ACTIONS line otherwise.`

// The ACTIONS line, validated. Anything outside the allowed shapes is dropped.
function parseActions(text, validIds = new Set()) {
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
  const validIds = new Set(snap.applications.map(a => a.id))
  const context = `${FENCE_RULES}\n\n${fence('MY JOB SEARCH DATA (JSON)', JSON.stringify(snap), 60000)}`
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
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
  return parseActions(String(text || '').replace(/\*\*/g, ''), validIds)
}

module.exports = { ask, snapshot, parseActions, PAGES }
