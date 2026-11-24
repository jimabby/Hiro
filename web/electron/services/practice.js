// Practice: interview flashcards, a few a day, with spaced repetition.
//
// Three decks feed it:
//   - the question bank (electron/data/questions.json), shipped with the app as
//     data rather than code so it can later be refreshed without a release;
//   - job decks: the likely interview questions Hiro already generates for an
//     application (interview_prep). No new model call — the questions were paid
//     for when the brief was built — and the user's own polished answer, where
//     they wrote one, replaces the generated sample;
//   - generated decks: questions written from a job ad the user pastes or
//     uploads (generateDeck), one model call per deck.
//
// Each day gets a fixed set (default 8): due reviews first, then new cards. The
// set is stored, so reopening the page at lunch shows the same cards as the
// morning; changing topics rebuilds the unanswered part and keeps what was done.
// The rules themselves are in practiceCore.js, free of anything Hiro-specific.
//
// Any card can carry the user's own note, and can be explained further by the
// AI (explain). Explanations are stored, so reading one again costs nothing.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const database = require('./database')
const configService = require('./config')
const core = require('./practiceCore')
const aiAdapter = require('./ai/index')
const { isAiConfigured } = require('./ai/configured')
const { fence, FENCE_RULES } = require('./ai/untrusted')

const BANK_PATH = path.join(__dirname, '..', 'data', 'questions.json')
const JOB_TOPIC = 'Job decks'
const DEFAULT_COUNT = 8
const MAX_COUNT = 30
const WEEKLY_GOAL_DAYS = 4
const FLAG_REASONS = ['outdated', 'wrong', 'other']
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_NOTE = 5000
const MAX_FOLLOW_UP = 1000
const MIN_JOB_TEXT = 80
const MAX_JOB_TEXT = 20000
const DECK_SIZES = [10, 15, 20]

// ─── The question bank: shipped, then kept current ─────────────────
//
// The bank ships inside the app and is also published from the public repo.
// Once a day the published copy is fetched (refreshBank); when it is at least
// as new as the shipped one it is cached in the profile and used instead, so a
// corrected answer or a new question reaches users without a release. Nothing
// fetched is trusted: it goes through the same validation as the shipped file,
// answers are rebuilt tag by tag when shown, and a reply that is too large, in
// an unknown format or suspiciously small is ignored, keeping what was there.

const BANK_URL = 'https://raw.githubusercontent.com/jimabby/Hiro/main/web/electron/data/questions.json'
const MAX_BANK_BYTES = 3 * 1024 * 1024
const MIN_REMOTE_QUESTIONS = 50
const BANK_CHECK_HOURS = 20
const bankCachePath = () => (configService.CONFIG_DIR ? path.join(configService.CONFIG_DIR, 'practice-bank.json') : null)

let bankCache = null

function readBankFile(file) {
  if (!file) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.schema !== 1) return null
    const questions = core.cleanBank(parsed)
    return questions.length ? { updatedAt: String(parsed.updatedAt || '').slice(0, 10), questions } : null
  } catch { return null }
}

function loadBank(file = BANK_PATH) {
  if (bankCache && bankCache.file === file) return bankCache.questions
  const bundled = readBankFile(file) || { updatedAt: '', questions: [] }
  let chosen = { ...bundled, source: 'bundled' }
  if (file === BANK_PATH) {
    const cached = readBankFile(bankCachePath())
    if (cached && cached.updatedAt >= bundled.updatedAt && cached.questions.length >= MIN_REMOTE_QUESTIONS) {
      chosen = { ...cached, source: 'downloaded' }
    }
  }
  bankCache = { file, questions: chosen.questions, source: chosen.source, updatedAt: chosen.updatedAt, bundledAt: bundled.updatedAt }
  return chosen.questions
}

// For tests: forget the cached bank.
function resetBank() { bankCache = null }

function bankInfo({ cfg = configService.load() } = {}) {
  loadBank()
  return {
    source: bankCache.source, updatedAt: bankCache.updatedAt, count: bankCache.questions.length,
    updates: cfg.practiceBankUpdates !== false, lastCheck: cfg.practiceBankCheck || null,
  }
}

async function refreshBank({ cfg = configService.load(), fetchImpl = globalThis.fetch, now = new Date(), force = false } = {}) {
  if (cfg.practiceBankUpdates === false) return { success: true, skipped: 'disabled' }
  const url = typeof cfg.practiceBankUrl === 'string' && cfg.practiceBankUrl.trim() ? cfg.practiceBankUrl.trim() : BANK_URL
  if (!/^https:\/\//i.test(url)) return { success: false, error: 'The question bank address must use https.' }
  const last = cfg.practiceBankCheck?.at ? Date.parse(cfg.practiceBankCheck.at) : NaN
  if (!force && Number.isFinite(last) && now - last < BANK_CHECK_HOURS * 3600 * 1000) return { success: true, skipped: 'recent' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > MAX_BANK_BYTES) throw new Error('the file is larger than a question bank should be')
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error('the file is not valid JSON') }
    if (parsed?.schema !== 1) throw new Error('the file is in a format this version does not understand')
    const questions = core.cleanBank(parsed)
    if (questions.length < MIN_REMOTE_QUESTIONS) throw new Error(`only ${questions.length} usable questions`)
    const updatedAt = String(parsed.updatedAt || '').slice(0, 10)
    loadBank()
    const before = { source: bankCache.source, updatedAt: bankCache.updatedAt, count: bankCache.questions.length }
    let updated = false
    // Older than the copy this version shipped with: the app is ahead of the
    // published bank, so there is nothing to take.
    if (updatedAt >= bankCache.bundledAt) {
      const file = bankCachePath()
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(parsed), { mode: 0o600 })
      fs.renameSync(tmp, file)
      resetBank()
      loadBank()
      updated = before.updatedAt !== bankCache.updatedAt || before.count !== bankCache.questions.length || before.source !== bankCache.source
    }
    configService.update({ practiceBankCheck: { at: now.toISOString(), ok: true, updatedAt, count: questions.length } })
    return { success: true, updated, updatedAt, count: questions.length }
  } catch (err) {
    const error = controller.signal.aborted ? 'the request timed out' : (err?.message || String(err))
    configService.update({ practiceBankCheck: { at: now.toISOString(), ok: false, error } })
    return { success: false, error }
  } finally {
    clearTimeout(timer)
  }
}

const hashText = s => crypto.createHash('sha1').update(String(s).trim().toLowerCase()).digest('hex').slice(0, 10)

// Cards made from the questions generated for each application. The id hashes
// the question text, so regenerated questions start fresh while an unchanged
// question keeps its schedule.
// `applicationId` limits it to one application.
function jobCards({ applicationId = null } = {}) {
  const cards = []
  const seen = new Set()
  let apps = []
  try { apps = database.getPracticeJobApplications() } catch { return cards }
  if (applicationId != null) apps = apps.filter(a => a.id === applicationId)
  for (const app of apps) {
    let questions = null
    try { questions = database.getInterviewPrepWithAnswers(app.id) } catch { questions = null }
    if (!Array.isArray(questions)) continue
    const label = [app.company, app.job_title].filter(Boolean).join(' — ').slice(0, 80) || `Application ${app.id}`
    for (const q of questions) {
      const text = typeof q === 'string' ? q : q?.question
      if (typeof text !== 'string' || !text.trim()) continue
      const id = `job-${app.id}-${hashText(text)}`
      if (seen.has(id)) continue
      seen.add(id)
      const answer = (typeof q === 'object' && (q.savedAnswer || q.answer)) || ''
      cards.push({
        id, deck: 'job', format: 'markdown', topic: label, question: text.trim().slice(0, 500),
        answer: String(answer).slice(0, 8000), difficulty: null, tags: [], versions: [], updatedAt: null,
        category: typeof q === 'object' ? core.normalizeCategory(q.category) : null,
        applicationId: app.id, ownAnswer: Boolean(typeof q === 'object' && q.savedAnswer),
      })
    }
  }
  return cards
}

// Cards from decks generated out of a job ad.
function deckCards() {
  let rows = []
  try { rows = database.getPracticeDeckCards() } catch { return [] }
  const seen = new Set()
  const cards = []
  for (const r of rows) {
    const id = `deck-${r.deck_id}-${hashText(r.question)}`
    if (seen.has(id)) continue
    seen.add(id)
    cards.push({
      id, deck: 'custom', format: r.format === 'html' ? 'html' : 'markdown', topic: r.deck_title, question: r.question, answer: r.answer,
      category: core.normalizeCategory(r.category), difficulty: core.DIFFICULTIES.includes(r.difficulty) ? r.difficulty : null,
      tags: r.skill ? [r.skill] : [], versions: [], updatedAt: null, deckId: r.deck_id,
    })
  }
  return cards
}

function allCards() {
  return [...loadBank(), ...jobCards(), ...deckCards()]
}

// The name a card is filtered by: its topic for the bank, one shared name for
// application decks, and "Deck: <title>" for a generated deck (so a deck called
// "Java" cannot merge with the bank's Java topic).
function topicKey(card) {
  if (card.deck === 'job') return JOB_TOPIC
  if (card.deck === 'custom') return `Deck: ${card.topic}`
  return card.topic
}

// Topics in bank order, then job decks, then generated decks.
function topicList(cards) {
  const counts = new Map()
  for (const c of cards) {
    const t = topicKey(c)
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count }))
}

function settingsFrom(cfg, known) {
  const raw = cfg?.practice || {}
  const n = Math.floor(Number(raw.dailyCount))
  const topics = Array.isArray(raw.topics) ? raw.topics.filter(t => typeof t === 'string' && (!known || known.has(t))) : []
  return { topics, dailyCount: Number.isFinite(n) ? Math.min(MAX_COUNT, Math.max(1, n)) : DEFAULT_COUNT }
}

const filterKey = s => JSON.stringify([...s.topics].sort())
const matches = (card, topics) => topics.length === 0 || topics.includes(topicKey(card))

// Everything a view needs, read once.
function snapshot({ now = new Date(), cfg = configService.load() } = {}) {
  const today = database.localDateString(now)
  const cards = allCards()
  const topics = topicList(cards)
  const settings = settingsFrom(cfg, new Set(topics.map(t => t.name)))
  const states = new Map(database.getPracticeStates().map(s => [s.card_id, s]))
  const flags = new Map(database.getPracticeFlags().map(f => [f.card_id, f]))
  const notes = new Map(database.getPracticeNotes().map(n => [n.card_id, n]))
  const explained = new Set(database.getPracticeExplainedIds())
  const storyLinks = new Map()
  for (const l of database.getPracticeStoryLinks()) storyLinks.set(l.card_id, [...(storyLinks.get(l.card_id) || []), l.story_id])
  const reviewedToday = new Set(database.getPracticeReviewedOn(today))
  const eligible = cards.filter(c => !flags.has(c.id) && matches(c, settings.topics))
  return { today, cards, topics, settings, states, flags, notes, explained, storyLinks, reviewedToday, eligible }
}

// ─── Interview countdown ───────────────────────────────────────────
//
// An interview booked in the next week puts that application's questions at
// the front of each day's set, whatever topics are chosen, until the day
// itself. "Left" is what still needs doing today: new cards, and cards due.
const COUNTDOWN_DAYS = 7

function countdownFor(snap) {
  let rows = []
  try { rows = database.getPracticeInterviews(core.addDays(snap.today, COUNTDOWN_DAYS)) } catch { rows = [] }
  const nearest = new Map()
  for (const r of rows) if (!nearest.has(r.application_id)) nearest.set(r.application_id, r)
  return [...nearest.values()].map(r => {
    const cards = snap.cards.filter(c => c.deck === 'job' && c.applicationId === r.application_id && !snap.flags.has(c.id))
    const left = cards.filter(c => {
      if (snap.reviewedToday.has(c.id)) return false
      const s = snap.states.get(c.id)
      return !s || s.due_on <= snap.today
    })
    return {
      applicationId: r.application_id, company: r.company || '', jobTitle: r.job_title || '',
      scheduledAt: r.scheduled_at, hasTime: r.has_time == null || Number(r.has_time) === 1,
      daysLeft: Math.max(0, core.daysBetween(snap.today, r.scheduled_at)),
      cards: cards.length, cardsLeft: left.length, cardIds: left.map(c => c.id),
    }
  })
}

const publicCountdown = list => list.map(({ cardIds: _ids, ...c }) => c)

const view = (card, snap) => {
  const state = snap.states.get(card.id) || null
  return {
    ...card,
    topicKey: topicKey(card),
    // Generated text arrives as light markdown; it is turned into safe text
    // blocks here, so the renderer never has to interpret it.
    blocks: card.format === 'html' ? undefined : core.answerBlocks(card.answer, card.format),
    state: state ? { ease: state.ease, interval: state.interval_days, reps: state.reps, lapses: state.lapses, dueOn: state.due_on } : null,
    flag: snap.flags.get(card.id) || null,
    note: snap.notes.get(card.id)?.note || '',
    explained: snap.explained.has(card.id),
    storyIds: snap.storyLinks.get(card.id) || [],
    intervals: core.previewIntervals(state, snap.today),
  }
}

// Today's set, building or rebuilding it when needed.
function today({ now = new Date(), cfg = configService.load(), rng = Math.random } = {}) {
  const snap = snapshot({ now, cfg })
  const { today: day, settings } = snap
  const countdown = countdownFor(snap)
  // An interview booked during the day changes the key, so the unanswered part
  // of the set is rebuilt with that job's questions first.
  const key = `${filterKey(settings)}|${countdown.filter(c => c.cards).map(c => c.applicationId).join(',')}`
  const done = snap.reviewedToday
  let row = database.getPracticeDay(day)
  if (!row || row.filterKey !== key) {
    const keep = (row?.cardIds || []).filter(id => done.has(id))
    const priority = countdown.flatMap(c => c.cardIds)
    const ids = core.buildSet({ cards: snap.eligible, states: snap.states, today: day, count: settings.dailyCount, keep, priority, rng })
    database.savePracticeDay(day, ids, key)
    row = { day, cardIds: ids, filterKey: key, relearn: row?.relearn || [] }
  }
  const byId = new Map(snap.cards.map(c => [c.id, c]))
  const set = row.cardIds.filter(id => byId.has(id))
  // Cards missed earlier today, to be seen once more after the rest.
  const relearn = (row.relearn || []).filter(id => set.includes(id) && done.has(id) && !snap.flags.has(id))
  const again = new Set(relearn)
  const cards = set.map(id => {
    const card = { ...view(byId.get(id), snap), done: done.has(id), relearn: again.has(id) }
    // A second look does not move the schedule: whatever the answer, the card
    // returns when the miss already set it to.
    if (card.relearn && card.state) {
      const n = card.state.interval
      card.intervals = { again: n, hard: n, good: n, easy: n }
    }
    return card
  })
  const queue = [...cards.filter(c => !c.done && !c.flag).map(c => c.id), ...relearn]
  return {
    day,
    settings,
    topics: snap.topics,
    cards,
    queue,
    relearnCount: relearn.length,
    doneCount: cards.filter(c => c.done).length,
    // Due cards that did not fit today, so "practise more" is an informed choice.
    dueLater: snap.eligible.filter(c => !set.includes(c.id) && snap.states.get(c.id)?.due_on <= day).length,
    available: snap.eligible.filter(c => !set.includes(c.id)).length,
    countdown: publicCountdown(countdown),
  }
}

// Adds more cards to today's set.
function more({ count, now = new Date(), cfg = configService.load(), rng = Math.random } = {}) {
  const snap = snapshot({ now, cfg })
  const current = today({ now, cfg, rng })
  const extra = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(count)) || snap.settings.dailyCount))
  const existing = current.cards.map(c => c.id)
  const countdown = countdownFor(snap)
  const added = core.buildSet({ cards: snap.eligible, states: snap.states, today: snap.today, count: extra, exclude: existing, priority: countdown.flatMap(c => c.cardIds), rng })
  const key = `${filterKey(snap.settings)}|${countdown.filter(c => c.cards).map(c => c.applicationId).join(',')}`
  database.savePracticeDay(snap.today, [...existing, ...added], key)
  return today({ now, cfg, rng })
}

// A card id says where the card comes from (job-<application>-…, deck-<deck>-…,
// otherwise the bank), so only that source is read: rating a card reads one
// application's questions, not every application's. The bank is the fallback
// in case a bank id ever starts the same way.
function findCard(cardId) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return null
  const job = /^job-(\d+)-/.exec(cardId)
  const found = job ? jobCards({ applicationId: Number(job[1]) }).find(c => c.id === cardId)
    : cardId.startsWith('deck-') ? deckCards().find(c => c.id === cardId)
      : null
  return found || loadBank().find(c => c.id === cardId) || null
}

function rate(cardId, rating, { now = new Date() } = {}) {
  if (!Object.prototype.hasOwnProperty.call(core.RATINGS, rating)) return { success: false, error: 'Unknown rating.' }
  if (!findCard(cardId)) return { success: false, error: 'That card no longer exists.' }
  const day = database.localDateString(now)
  const prev = database.getPracticeStates().find(s => s.card_id === cardId) || null
  const publicState = s => ({ ease: s.ease, interval: s.interval_days, reps: s.reps, lapses: s.lapses, dueOn: s.due_on })
  const dayRow = database.getPracticeDay(day)
  const relearn = dayRow?.relearn || []

  // A card missed earlier today, seen once more. Its schedule was already set
  // by the miss (back tomorrow), so this look only decides whether it comes
  // round again today: Again sends it to the back of the queue, anything else
  // lets it go. Nothing is written to the review history, so the topic's
  // forget rate and the streak count the first answer only.
  if (prev && relearn.includes(cardId)) {
    const rest = relearn.filter(id => id !== cardId)
    database.setPracticeRelearn(day, rating === 'again' ? [...rest, cardId] : rest)
    return { success: true, relearn: true, state: publicState(prev) }
  }

  // Otherwise a card is rated once a day. A second rating the same day is a
  // repeat of the first (a double key press before the next card loaded, or a
  // phone that rated away from home and again on the LAN before the desktop
  // applied the cloud event); applying it would push the card twice as far
  // out, so it is acknowledged and ignored.
  if (prev && database.getPracticeReviewedOn(day).includes(cardId)) {
    return { success: true, duplicate: true, state: publicState(prev) }
  }
  const state = core.nextState(prev, rating, day)
  database.savePracticeReview({ cardId, state, rating, day })
  // Missed: it comes back at the end of today's cards, while the answer is
  // still fresh enough to fix. Only for a card in today's set.
  if (rating === 'again' && dayRow?.cardIds.includes(cardId)) {
    database.setPracticeRelearn(day, [...relearn, cardId])
  }
  return { success: true, state: publicState(state) }
}

function flag(cardId, reason, note = '') {
  if (!FLAG_REASONS.includes(reason)) return { success: false, error: 'Choose why the card is a problem.' }
  if (!findCard(cardId)) return { success: false, error: 'That card no longer exists.' }
  database.setPracticeFlag(cardId, reason, String(note || '').trim().slice(0, 500))
  return { success: true }
}

function unflag(cardId) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return { success: false, error: 'Unknown card.' }
  database.clearPracticeFlag(cardId)
  return { success: true }
}

// ─── Notes ─────────────────────────────────────────────────────────

function saveNote(cardId, note) {
  if (!findCard(cardId)) return { success: false, error: 'That card no longer exists.' }
  const text = String(note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_NOTE)
  database.savePracticeNote(cardId, text)
  return { success: true, note: text }
}

// ─── Ask AI about a card ───────────────────────────────────────────

const EXPLAIN_SYSTEM = `You are a friendly senior software engineer helping a junior developer prepare for job interviews.
Explain clearly and concretely in plain language. Use short paragraphs, bullet points where they help, and a small code example in a fenced block when it makes the idea clearer.
If the answer on the card is incomplete, outdated or wrong, say so plainly and give the correct version.
When asked to explain a card, finish with two follow-up questions an interviewer might ask next, each with a one-line hint.
Keep it under about 350 words. Do not use markdown headings.`

const DEFAULT_ASK = 'Explain this in more depth: why it matters, a concrete example, and the mistakes candidates commonly make when answering it.'

const plainAnswer = (card) => core.answerBlocks(card.answer, card.format)
  .map(b => (b.marker ? `${b.marker} ` : '') + b.spans.map(s => s.text).join('')).join('\n')

const storyText = s => [`Title: ${s.title}`, ...STORY_FIELDS.filter(f => s[f]).map(f => `${f[0].toUpperCase()}${f.slice(1)}: ${s[f]}`)].join('\n')

function explainPrompt(card, { note, history, ask, stories: attached = [] }) {
  const parts = [
    `Interview question: ${card.question}`,
    `Topic: ${card.topic}${card.category ? ` · Category: ${card.category}` : ''}`,
    '',
    FENCE_RULES,
    '',
    fence('ANSWER ON THE CARD', plainAnswer(card), 6000),
  ]
  if (note) parts.push('', fence('MY NOTES', note, 2000))
  if (attached.length) {
    parts.push('', 'These are my own STAR stories for this question. Help me use them: say which fits best and how to tell it well in about two minutes.')
    parts.push(fence('MY STAR STORIES', attached.map(storyText).join('\n\n'), 6000))
  }
  if (history.length) {
    parts.push('', 'Earlier in this conversation about the card:')
    for (const h of history) parts.push(`Me: ${h.prompt || DEFAULT_ASK}`, `You: ${h.reply.slice(0, 1500)}`)
  }
  parts.push('', `My request: ${ask}`)
  return parts.join('\n')
}

function explanations(cardId) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return []
  return database.getPracticeExplanations(cardId).map(e => ({ ...e, blocks: core.markdownBlocks(e.reply) }))
}

// One model call. `followUp` is the user's own question about the card; empty
// asks for the standard deeper explanation.
async function explain(cardId, followUp = '', { cfg = configService.load() } = {}) {
  const card = findCard(cardId)
  if (!card) return { success: false, error: 'That card no longer exists.' }
  if (!isAiConfigured(cfg)) return { success: false, error: 'Set up an AI provider in Settings to ask about a question.' }
  const ask = String(followUp || '').trim().slice(0, MAX_FOLLOW_UP)
  const history = database.getPracticeExplanations(cardId).slice(-3)
  const note = database.getPracticeNotes().find(n => n.card_id === cardId)?.note || ''
  try {
    const reply = await aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
      operation: 'practiceExplain', tier: 'smart', maxTokens: 900, system: EXPLAIN_SYSTEM,
      messages: [{ role: 'user', content: explainPrompt(card, { note, history, ask: ask || DEFAULT_ASK, stories: storiesFor(cardId) }) }],
    }, cfg.geminiModel)
    const text = String(reply || '').trim()
    if (!text) return { success: false, error: 'The AI returned an empty answer. Try again.' }
    const saved = database.addPracticeExplanation(cardId, ask, text.slice(0, 12000))
    return { success: true, entry: { ...saved, blocks: core.markdownBlocks(saved.reply) } }
  } catch (err) {
    return { success: false, error: err?.message || 'The AI request failed.' }
  }
}

function clearExplanations(cardId) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return { success: false, error: 'Unknown card.' }
  database.clearPracticeExplanations(cardId)
  return { success: true }
}

// ─── Decks generated from a job ad ─────────────────────────────────

function deckPrompt(jobText, count) {
  return `Write ${count} interview questions a candidate is likely to be asked for the job below, each with a model answer.
- Base them on the technologies, skills and responsibilities the ad names. Most should be technical; include two or three behavioural questions and one or two situational ones.
- Pitch them at the seniority the ad asks for. If it does not say, assume a junior or graduate developer.
- Answers: 3 to 6 sentences, accurate and current, in plain text. Add a short fenced code snippet only where it genuinely helps. No headings.
Return only a JSON array, nothing before or after it:
[{"question": "...", "answer": "...", "category": "Technical | Behavioural | Situational | Concept | Comparison | Practical | Problem solving | System design", "skill": "the main technology or skill it tests, e.g. React", "difficulty": "easy | medium | hard"}]

${FENCE_RULES}

${fence('JOB AD', jobText, MAX_JOB_TEXT)}`
}

// A short name for the deck: what the user typed, else the ad's first line.
function deckTitle(title, jobText, existing) {
  let t = String(title || '').replace(/\s+/g, ' ').trim()
  if (!t) t = (String(jobText).split('\n').map(s => s.trim()).find(s => s.length >= 3) || 'Job ad').replace(/\s+/g, ' ')
  t = t.slice(0, 60)
  let name = t
  for (let i = 2; existing.has(name); i++) name = `${t} (${i})`
  return name
}

async function generateDeck({ title, jobText, count } = {}, { cfg = configService.load() } = {}) {
  const text = String(jobText || '').replace(/\r\n?/g, '\n').trim()
  if (text.length < MIN_JOB_TEXT) return { success: false, error: 'Paste the full job description (at least a few sentences) so the questions can match it.' }
  if (!isAiConfigured(cfg)) return { success: false, error: 'Set up an AI provider in Settings to generate questions.' }
  const n = DECK_SIZES.includes(Number(count)) ? Number(count) : 15
  let reply
  try {
    reply = await aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
      operation: 'practiceDeck', tier: 'smart', maxTokens: Math.min(9000, 450 * n),
      system: 'You write interview practice questions for junior and graduate software developers. You reply with JSON only.',
      messages: [{ role: 'user', content: deckPrompt(text.slice(0, MAX_JOB_TEXT), n) }],
    }, cfg.geminiModel)
  } catch (err) {
    return { success: false, error: err?.message || 'The AI request failed.' }
  }
  const questions = core.parseGeneratedQuestions(reply, n)
  if (questions.length < 3) return { success: false, error: 'The AI did not return usable questions. Try again, or try a different model.' }
  const existing = new Set(database.getPracticeDecks().map(d => d.title))
  const name = deckTitle(title, text, existing)
  const id = database.createPracticeDeck(name, text.slice(0, MAX_JOB_TEXT), questions, { source: 'job-ad' })
  return { success: true, deck: { id, title: name, cards: questions.length, topic: `Deck: ${name}` } }
}

// ─── Importing a question file ─────────────────────────────────────
//
// Two steps, so nothing is saved until the user has seen what will be: a
// preview (counts, a sample, what was skipped and why), then the import.

const MAX_IMPORT_CHARS = 2 * 1024 * 1024

function importTitle(name) {
  return String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Imported questions'
}

function readImport({ name, text } = {}) {
  const content = String(text ?? '')
  if (!content.trim()) return { error: 'That file is empty.' }
  if (content.length > MAX_IMPORT_CHARS) return { error: 'That file is larger than 2 MB. Split it into smaller files.' }
  return { parsed: core.parseImport(content, { name }) }
}

const FORMAT_LABELS = { csv: 'CSV', tsv: 'tab-separated', anki: 'Anki text export', json: 'JSON' }

function previewImport(input = {}) {
  const { parsed, error } = readImport(input)
  if (error) return { success: false, error }
  return {
    success: true,
    format: parsed.format,
    formatLabel: FORMAT_LABELS[parsed.format] || parsed.format,
    count: parsed.cards.length,
    sample: parsed.cards.slice(0, 5).map(c => ({ ...c, blocks: core.answerBlocks(c.answer, c.format) })),
    skipped: parsed.skipped.slice(0, 20),
    skippedCount: parsed.skipped.length,
    suggestedTitle: importTitle(input.name),
  }
}

function importDeck(input = {}) {
  const { parsed, error } = readImport(input)
  if (error) return { success: false, error }
  if (!parsed.cards.length) return { success: false, error: 'No questions could be read from that file. Each row needs a question and an answer.' }
  const existing = new Set(database.getPracticeDecks().map(d => d.title))
  const name = deckTitle(input.title || importTitle(input.name), '', existing)
  const id = database.createPracticeDeck(name, '', parsed.cards, { source: 'import' })
  return { success: true, deck: { id, title: name, cards: parsed.cards.length, topic: `Deck: ${name}` }, skippedCount: parsed.skipped.length }
}

// ─── A web page turned into cards ──────────────────────────────────
//
// For the user's own study: the page is read with the same guarded fetch as a
// job link (no private addresses, limited redirects and size), reduced to its
// main text, and the AI writes flashcards from it. The page is untrusted input
// and is fenced in the prompt. The deck is private to this user.

const MIN_PAGE_TEXT = 300
const MAX_PAGE_TEXT = 30000

function pagePrompt(text, count, url) {
  return `Write up to ${count} interview flashcards from the web page below, for a junior software developer preparing for interviews.
- Use only what the page covers, and correct it where it is clearly wrong or out of date.
- Each question should be one an interviewer could ask; each answer 2 to 6 sentences in plain language, with a short fenced code snippet only where it genuinely helps. No headings.
- If the page is already a list of interview questions, keep its best ones and write your own answers.
- Skip navigation, adverts, comments and anything unrelated to software development. If the page has nothing useful, return an empty list.
Return only a JSON array, nothing before or after it:
[{"question": "...", "answer": "...", "category": "Concept | Comparison | Practical | Best practice | Problem solving | Behavioural | System design", "skill": "the main technology, e.g. React", "difficulty": "easy | medium | hard"}]

${FENCE_RULES}

${fence(`WEB PAGE ${url}`, text, MAX_PAGE_TEXT)}`
}

async function deckFromUrl({ url, title, count } = {}, { cfg = configService.load(), fetchPage } = {}) {
  if (!isAiConfigured(cfg)) return { success: false, error: 'Set up an AI provider in Settings to turn a page into cards.' }
  const n = DECK_SIZES.includes(Number(count)) ? Number(count) : 15
  const jobPage = require('./jobPage')
  let page
  try {
    page = await (fetchPage || jobPage.fetchPage)(String(url || '').trim().slice(0, 2000))
  } catch (err) {
    return { success: false, error: err?.message || 'That page could not be read.' }
  }
  const text = jobPage.htmlToText(core.mainHtml(page.html)).slice(0, MAX_PAGE_TEXT)
  if (text.length < MIN_PAGE_TEXT) {
    return { success: false, error: 'Hiro could not find enough text on that page. Some sites only show their content after you sign in or run JavaScript; copy the text and paste it into "From a job ad" instead.' }
  }
  let reply
  try {
    reply = await aiAdapter.chat(cfg.aiProvider, cfg.aiApiKey, {
      operation: 'practiceDeck', tier: 'smart', maxTokens: Math.min(9000, 450 * n),
      system: 'You write interview flashcards for junior and graduate software developers. You reply with JSON only.',
      messages: [{ role: 'user', content: pagePrompt(text, n, page.url) }],
    }, cfg.geminiModel)
  } catch (err) {
    return { success: false, error: err?.message || 'The AI request failed.' }
  }
  const questions = core.parseGeneratedQuestions(reply, n)
  if (questions.length < 3) return { success: false, error: 'That page did not give enough to make interview questions from. Try a page that explains a topic.' }
  const existing = new Set(database.getPracticeDecks().map(d => d.title))
  const name = deckTitle(title || core.pageTitle(page.html) || new URL(page.url).hostname, text, existing)
  const id = database.createPracticeDeck(name, text, questions, { source: 'web-page', sourceUrl: page.url })
  return { success: true, deck: { id, title: name, cards: questions.length, topic: `Deck: ${name}` } }
}

// Generated decks, plus the application decks for context.
function decks() {
  const job = jobCards()
  const apps = new Map()
  for (const c of job) apps.set(c.applicationId, { applicationId: c.applicationId, title: c.topic, cards: (apps.get(c.applicationId)?.cards || 0) + 1 })
  return {
    generated: database.getPracticeDecks().map(d => ({ id: d.id, title: d.title, cards: d.cards, created_at: d.created_at, topic: `Deck: ${d.title}`, source: d.source || 'job-ad', sourceUrl: d.source_url || '' })),
    applications: [...apps.values()],
    sizes: DECK_SIZES,
  }
}

function renameDeck(id, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!t) return { success: false, error: 'Give the deck a name.' }
  const all = database.getPracticeDecks()
  const deck = all.find(d => d.id === Number(id))
  if (!deck) return { success: false, error: 'That deck no longer exists.' }
  if (all.some(d => d.title === t && d.id !== deck.id)) return { success: false, error: 'Another deck already has that name.' }
  database.renamePracticeDeck(deck.id, t)
  // A deck chosen as a topic follows the rename.
  const cfg = configService.load()
  const topics = cfg.practice?.topics || []
  if (topics.includes(`Deck: ${deck.title}`)) {
    configService.update({ practice: { ...cfg.practice, topics: topics.map(x => x === `Deck: ${deck.title}` ? `Deck: ${t}` : x) } })
  }
  return { success: true }
}

function deleteDeck(id) {
  const deck = database.getPracticeDecks().find(d => d.id === Number(id))
  if (!deck) return { success: false, error: 'That deck no longer exists.' }
  database.deletePracticeDeck(deck.id)
  return { success: true }
}

// ─── STAR stories ──────────────────────────────────────────────────
//
// The user's own examples — Situation, Task, Action, Result — written once and
// attached to the behavioural questions they answer. A story can serve many
// questions ("a time you disagreed", "a time you showed leadership").

const STORY_FIELDS = ['situation', 'task', 'action', 'result']
const MAX_STORY_FIELD = 2000

function cleanStory(input) {
  const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max)
  const story = { title: text(input?.title, 120), tags: text(input?.tags, 200) }
  for (const f of STORY_FIELDS) story[f] = text(input?.[f], MAX_STORY_FIELD)
  return story
}

function stories() {
  const links = database.getPracticeStoryLinks()
  return database.getPracticeStories().map(s => ({ ...s, linkedCards: links.filter(l => l.story_id === s.id).length }))
}

function saveStory(input) {
  const story = cleanStory(input)
  if (!story.title) return { success: false, error: 'Give the story a short title.' }
  if (!STORY_FIELDS.some(f => story[f])) return { success: false, error: 'Write at least one part of the story.' }
  const id = input?.id != null ? Number(input.id) : null
  if (id != null && !database.getPracticeStories().some(s => s.id === id)) return { success: false, error: 'That story no longer exists.' }
  const saved = database.savePracticeStory({ id, ...story })
  // Attaching while creating: written from a question, it belongs to it.
  if (!id && input?.cardId && findCard(input.cardId)) database.linkPracticeStory(input.cardId, saved.id)
  return { success: true, story: saved }
}

function deleteStory(id) {
  const story = database.getPracticeStories().find(s => s.id === Number(id))
  if (!story) return { success: false, error: 'That story no longer exists.' }
  database.deletePracticeStory(story.id)
  return { success: true }
}

function linkStory(cardId, storyId) {
  if (!findCard(cardId)) return { success: false, error: 'That card no longer exists.' }
  if (!database.getPracticeStories().some(s => s.id === Number(storyId))) return { success: false, error: 'That story no longer exists.' }
  database.linkPracticeStory(cardId, Number(storyId))
  return { success: true }
}

function unlinkStory(cardId, storyId) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return { success: false, error: 'Unknown card.' }
  database.unlinkPracticeStory(cardId, Number(storyId))
  return { success: true }
}

function storiesFor(cardId) {
  const ids = new Set(database.getPracticeStoryLinks().filter(l => l.card_id === cardId).map(l => l.story_id))
  return database.getPracticeStories().filter(s => ids.has(s.id))
}

// ─── Weak topics ───────────────────────────────────────────────────
//
// Which topics get "Again" most, beside how often employers ask for them
// (skillsGap.js, counted from the ads Hiro has read). A topic that is both
// forgotten often and in demand is where practice pays most.

const TOPIC_SKILLS = {
  'JS / TS': ['JavaScript', 'TypeScript'], '.NET / C#': ['.NET', 'C#'], 'HTML / Web': ['HTML', 'CSS'],
  Cloud: ['AWS', 'Azure', 'GCP'], 'Tools & Process': ['Docker', 'Kubernetes', 'Git', 'CI/CD', 'Agile'],
  'Design Patterns': [], OOP: [], DSA: [], Behavioural: [],
}
const skillsFor = topic => (Object.prototype.hasOwnProperty.call(TOPIC_SKILLS, topic) ? TOPIC_SKILLS[topic] : [topic])

function insights({ now = new Date(), cfg = configService.load(), days = 90, skillsGap } = {}) {
  const snap = snapshot({ now, cfg })
  const span = [30, 90, 365].includes(Number(days)) ? Number(days) : 90
  const reviews = database.getPracticeReviewsSince(core.addDays(snap.today, -span))
  const byId = new Map(snap.cards.map(c => [c.id, c]))
  const topics = core.weakTopics(reviews, id => (byId.has(id) ? topicKey(byId.get(id)) : null))

  let gap = null
  try { gap = skillsGap || require('./skillsGap').analyse({ days: 90 }) } catch { gap = null }
  const demand = new Map()
  if (gap?.enoughData) {
    for (const row of gap.missing || []) demand.set(String(row.skill).toLowerCase(), { skill: row.skill, share: row.share, jobs: row.jobs, inResume: false })
    for (const row of gap.covered || []) demand.set(String(row.skill).toLowerCase(), { skill: row.skill, share: row.share, jobs: row.jobs, inResume: true })
  }
  for (const t of topics) {
    const hits = skillsFor(t.name).map(s => demand.get(s.toLowerCase())).filter(Boolean).sort((a, b) => b.share - a.share)
    t.demand = hits[0] || null
  }

  const weakCards = database.getPracticeStates()
    .filter(s => s.lapses > 0 && byId.has(s.card_id) && !snap.flags.has(s.card_id))
    .sort((a, b) => b.lapses - a.lapses || a.ease - b.ease)
    .slice(0, 8)
    .map(s => { const c = byId.get(s.card_id); return { id: c.id, question: c.question, topic: c.topic, topicKey: topicKey(c), category: c.category, deck: c.deck, lapses: s.lapses } })

  const again = reviews.filter(r => r.rating === 'again').length
  return {
    days: span,
    topics,
    weakCards,
    totals: { reviews: reviews.length, again, againRate: reviews.length ? Math.round((again / reviews.length) * 100) / 100 : 0, activeDays: new Set(reviews.map(r => r.reviewed_on)).size },
    skillsGap: { available: Boolean(gap?.enoughData), sample: gap?.sample || 0 },
  }
}

// ─── Daily reminder ────────────────────────────────────────────────
//
// One notification a day at the user's chosen time, on the desktop and the
// phone, only when there is something to do and it has not been done. It
// leads with an interview if one is close, and with the streak if there is one
// to keep.

const DEFAULT_REMINDER = { enabled: false, time: '19:00' }

function reminderSettings(cfg = configService.load()) {
  const raw = cfg.practiceReminder || {}
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time) ? raw.time : DEFAULT_REMINDER.time
  return { enabled: raw.enabled === true, time }
}

function saveReminder(input) {
  const time = String(input?.time || '')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { success: false, error: 'Choose a time like 19:00.' }
  const settings = { enabled: input?.enabled === true, time }
  configService.update({ practiceReminder: settings })
  return { success: true, settings }
}

const whenText = d => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`)

function reminderText({ now = new Date(), cfg = configService.load() } = {}) {
  const t = today({ now, cfg })
  const s = stats({ now, cfg })
  if (s.practisedToday || !t.queue.length) return null
  const n = t.queue.length
  const minutes = Math.max(2, Math.round(n * 0.6))
  const parts = []
  const soon = t.countdown.filter(c => c.cardsLeft > 0).sort((a, b) => a.daysLeft - b.daysLeft)[0]
  if (soon) parts.push(`${soon.company || 'Your'} interview ${whenText(soon.daysLeft)}: ${soon.cardsLeft} card${soon.cardsLeft === 1 ? '' : 's'} to go.`)
  if (s.streak > 0) parts.push(`Keep your ${s.streak}-day streak: ${n} card${n === 1 ? '' : 's'} waiting, about ${minutes} minutes.`)
  else parts.push(`${n} interview question${n === 1 ? ' is' : 's are'} waiting, about ${minutes} minutes.${s.daysThisWeek < s.weeklyGoalDays ? ` ${s.daysThisWeek} of ${s.weeklyGoalDays} days so far this week.` : ''}`)
  return parts.join(' ')
}

// Questions for an application with an interview coming but no questions yet:
// the same generation the interview brief uses, saved to the application, so
// the deck appears in Practice and in the brief alike.
async function prepareJobDeck(applicationId, { cfg = configService.load() } = {}) {
  const app = database.getApplication(Number(applicationId))
  if (!app) return { success: false, error: 'That application no longer exists.' }
  if (!isAiConfigured(cfg)) return { success: false, error: 'Set up an AI provider in Settings to create interview questions.' }
  try {
    await require('./interviewBrief').ensureQuestions(app, cfg)
  } catch (err) {
    return { success: false, error: err?.message || 'The AI request failed.' }
  }
  const cards = jobCards().filter(c => c.applicationId === app.id).length
  if (!cards) return { success: false, error: 'No questions came back. Try again.' }
  return { success: true, cards }
}

// Every card with its schedule, for browsing and search, plus the reported ones.
function bank({ now = new Date(), cfg = configService.load() } = {}) {
  const snap = snapshot({ now, cfg })
  return {
    day: snap.today,
    topics: snap.topics,
    settings: snap.settings,
    categories: [...new Set(snap.cards.map(c => c.category).filter(Boolean))],
    cards: snap.cards.map(c => view(c, snap)),
    // A reported card whose question has since gone (a regenerated job deck)
    // still appears, so the report can be cleared.
    orphanFlags: [...snap.flags.values()].filter(f => !snap.cards.some(c => c.id === f.card_id)),
  }
}

// ─── Cram a topic ──────────────────────────────────────────────────
//
// One topic, right now, outside the daily set: the night before an interview
// that will be about SQL. The cards come back without rating previews because
// nothing a cram session does is saved — the schedule, the review history and
// the streak belong to the daily set alone. Reported cards stay out.
const CRAM_DEFAULT = 20
const CRAM_MAX = 50

function cram({ topic, count, now = new Date(), cfg = configService.load(), rng = Math.random } = {}) {
  if (typeof topic !== 'string' || !topic.trim()) return { success: false, error: 'Choose a topic to cram.' }
  const snap = snapshot({ now, cfg })
  const cards = snap.cards.filter(c => !snap.flags.has(c.id) && topicKey(c) === topic)
  if (!cards.length) return { success: false, error: 'There are no cards in that topic.' }
  const n = Math.floor(Number(count))
  const size = Number.isFinite(n) && n > 0 ? Math.min(CRAM_MAX, n) : CRAM_DEFAULT
  const byId = new Map(cards.map(c => [c.id, c]))
  const ids = core.cramSet({ cards, states: snap.states, count: size, rng })
  return {
    success: true,
    topic,
    total: cards.length,
    cards: ids.map(id => {
      const { intervals: _intervals, ...card } = view(byId.get(id), snap)
      return card
    }),
  }
}

// ─── Export ────────────────────────────────────────────────────────
//
// The cards the user chose (Browse sends the ones its filters show), as CSV or
// an Anki import file, with the user's notes. A card id that no longer exists
// is skipped rather than failing the whole export.
const EXPORT_EXTENSIONS = { csv: 'csv', anki: 'txt' }
const MAX_EXPORT_IDS = 20000

function exportCards({ ids, format, now = new Date(), cfg = configService.load() } = {}) {
  if (!EXPORT_EXTENSIONS[format]) return { success: false, error: 'Choose CSV or Anki.' }
  const wanted = Array.isArray(ids) ? [...new Set(ids.slice(0, MAX_EXPORT_IDS).filter(id => typeof id === 'string' && CARD_ID.test(id)))] : []
  if (!wanted.length) return { success: false, error: 'There are no questions to export.' }
  const snap = snapshot({ now, cfg })
  const byId = new Map(snap.cards.map(c => [c.id, c]))
  const cards = wanted.map(id => byId.get(id)).filter(Boolean).map(c => ({
    question: c.question, answer: c.answer, format: c.format, topic: c.topic,
    category: c.category, difficulty: c.difficulty, note: snap.notes.get(c.id)?.note || '',
  }))
  if (!cards.length) return { success: false, error: 'Those questions no longer exist.' }
  return { success: true, count: cards.length, extension: EXPORT_EXTENSIONS[format], text: core.exportCards(cards, format) }
}

// The habit the MVP is measured on: practising on at least 4 days a week.
function stats({ now = new Date(), cfg = configService.load() } = {}) {
  const snap = snapshot({ now, cfg })
  const days = database.getPracticeReviewDays(core.addDays(snap.today, -400))
  const { streak, daysThisWeek, practisedToday } = core.dayStats(days, snap.today, core.mondayOf(snap.today))
  let due = 0, learned = 0, seen = 0
  for (const c of snap.eligible) {
    const s = snap.states.get(c.id)
    if (!s) continue
    seen++
    if (s.due_on <= snap.today) due++
    if (s.interval_days >= 21) learned++
  }
  return {
    streak, daysThisWeek, practisedToday, weeklyGoalDays: WEEKLY_GOAL_DAYS,
    due, learned, seen, total: snap.eligible.length, flagged: snap.flags.size,
  }
}

// Today's set and the stats in the shape the phone draws: answers as text
// blocks (core.answerBlocks) rather than HTML, and only the fields it shows.
function forPhone({ now = new Date(), cfg = configService.load(), day } = {}) {
  const t = day || today({ now, cfg })
  const allStories = new Map(database.getPracticeStories().map(s => [s.id, s]))
  return {
    day: t.day,
    countdown: t.countdown || [],
    cards: t.cards.map(c => ({
      id: c.id, deck: c.deck, topic: c.topic, question: c.question, difficulty: c.difficulty,
      versions: c.versions, category: c.category || null, blocks: core.answerBlocks(c.answer, c.format),
      intervals: c.intervals, isNew: !c.state, done: c.done, relearn: Boolean(c.relearn), flagged: Boolean(c.flag),
      note: c.note || '', explained: Boolean(c.explained),
      stories: (c.storyIds || []).map(id => allStories.get(id)).filter(Boolean)
        .map(s => ({ id: s.id, title: s.title, situation: s.situation, task: s.task, action: s.action, result: s.result })),
    })),
    queue: t.queue,
    relearnCount: t.relearnCount || 0,
    doneCount: t.doneCount,
    dueLater: t.dueLater,
    available: t.available,
    dailyCount: t.settings.dailyCount,
    stats: stats({ now, cfg }),
  }
}

function saveSettings(input) {
  const known = new Set(topicList(allCards()).map(t => t.name))
  const settings = settingsFrom({ practice: input }, known)
  configService.update({ practice: settings })
  return { success: true, settings }
}

module.exports = {
  JOB_TOPIC, DEFAULT_COUNT, MAX_COUNT, FLAG_REASONS, WEEKLY_GOAL_DAYS, DECK_SIZES,
  loadBank, resetBank, jobCards, deckCards, today, more, rate, flag, unflag, bank, stats, saveSettings, forPhone,
  saveNote, explanations, explain, clearExplanations, generateDeck, decks, renameDeck, deleteDeck,
  BANK_URL, bankInfo, refreshBank, COUNTDOWN_DAYS, prepareJobDeck,
  stories, saveStory, deleteStory, linkStory, unlinkStory, insights,
  previewImport, importDeck, deckFromUrl,
  reminderSettings, saveReminder, reminderText,
  cram, CRAM_DEFAULT, CRAM_MAX, exportCards,
}
