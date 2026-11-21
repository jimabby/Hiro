// Practice: interview flashcards, a few a day, with spaced repetition.
//
// Two decks feed it:
//   - the question bank (electron/data/questions.json), shipped with the app as
//     data rather than code so it can later be refreshed without a release;
//   - job decks: the likely interview questions Hiro already generates for an
//     application (interview_prep). No new model call — the questions were paid
//     for when the brief was built — and the user's own polished answer, where
//     they wrote one, replaces the generated sample.
//
// Each day gets a fixed set (default 8): due reviews first, then new cards. The
// set is stored, so reopening the page at lunch shows the same cards as the
// morning; changing topics rebuilds the unanswered part and keeps what was done.
// The rules themselves are in practiceCore.js, free of anything Hiro-specific.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const database = require('./database')
const configService = require('./config')
const core = require('./practiceCore')

const BANK_PATH = path.join(__dirname, '..', 'data', 'questions.json')
const JOB_TOPIC = 'Job decks'
const DEFAULT_COUNT = 8
const MAX_COUNT = 30
const WEEKLY_GOAL_DAYS = 4
const FLAG_REASONS = ['outdated', 'wrong', 'other']
const CARD_ID = /^(?:[a-z0-9][a-z0-9-]{0,63}|job-\d+-[0-9a-f]{10})$/

let bankCache = null

function loadBank(file = BANK_PATH) {
  if (bankCache && bankCache.file === file) return bankCache.questions
  let questions = []
  try { questions = core.cleanBank(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { questions = [] }
  bankCache = { file, questions }
  return questions
}

// For tests: forget the cached bank.
function resetBank() { bankCache = null }

const hashText = s => crypto.createHash('sha1').update(String(s).trim().toLowerCase()).digest('hex').slice(0, 10)

// Cards made from the questions generated for each application. The id hashes
// the question text, so regenerated questions start fresh while an unchanged
// question keeps its schedule.
function jobCards() {
  const cards = []
  const seen = new Set()
  let apps = []
  try { apps = database.getPracticeJobApplications() } catch { return cards }
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
        id, deck: 'job', format: 'text', topic: label, question: text.trim().slice(0, 500),
        answer: String(answer).slice(0, 8000), difficulty: null, tags: [], versions: [], updatedAt: null,
        category: typeof q === 'object' && typeof q.category === 'string' ? q.category : null,
        applicationId: app.id, ownAnswer: Boolean(typeof q === 'object' && q.savedAnswer),
      })
    }
  }
  return cards
}

function allCards() {
  return [...loadBank(), ...jobCards()]
}

// Topics in bank order, then job decks. Counts are of every card, flagged or not.
function topicList(cards) {
  const counts = new Map()
  for (const c of cards) {
    const t = c.deck === 'job' ? JOB_TOPIC : c.topic
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
const matches = (card, topics) => topics.length === 0 || topics.includes(card.deck === 'job' ? JOB_TOPIC : card.topic)

// Everything a view needs, read once.
function snapshot({ now = new Date(), cfg = configService.load() } = {}) {
  const today = database.localDateString(now)
  const cards = allCards()
  const topics = topicList(cards)
  const settings = settingsFrom(cfg, new Set(topics.map(t => t.name)))
  const states = new Map(database.getPracticeStates().map(s => [s.card_id, s]))
  const flags = new Map(database.getPracticeFlags().map(f => [f.card_id, f]))
  const eligible = cards.filter(c => !flags.has(c.id) && matches(c, settings.topics))
  return { today, cards, topics, settings, states, flags, eligible }
}

const view = (card, snap) => {
  const state = snap.states.get(card.id) || null
  return {
    ...card,
    state: state ? { ease: state.ease, interval: state.interval_days, reps: state.reps, lapses: state.lapses, dueOn: state.due_on } : null,
    flag: snap.flags.get(card.id) || null,
    intervals: core.previewIntervals(state, snap.today),
  }
}

// Today's set, building or rebuilding it when needed.
function today({ now = new Date(), cfg = configService.load(), rng = Math.random } = {}) {
  const snap = snapshot({ now, cfg })
  const { today: day, settings } = snap
  const key = filterKey(settings)
  const done = new Set(database.getPracticeReviewedOn(day))
  let row = database.getPracticeDay(day)
  if (!row || row.filterKey !== key) {
    const keep = (row?.cardIds || []).filter(id => done.has(id))
    const ids = core.buildSet({ cards: snap.eligible, states: snap.states, today: day, count: settings.dailyCount, keep, rng })
    database.savePracticeDay(day, ids, key)
    row = { day, cardIds: ids, filterKey: key }
  }
  const byId = new Map(snap.cards.map(c => [c.id, c]))
  const set = row.cardIds.filter(id => byId.has(id))
  const cards = set.map(id => ({ ...view(byId.get(id), snap), done: done.has(id) }))
  const queue = cards.filter(c => !c.done && !c.flag)
  return {
    day,
    settings,
    topics: snap.topics,
    cards,
    queue: queue.map(c => c.id),
    doneCount: cards.filter(c => c.done).length,
    // Due cards that did not fit today, so "practise more" is an informed choice.
    dueLater: snap.eligible.filter(c => !set.includes(c.id) && snap.states.get(c.id)?.due_on <= day).length,
    available: snap.eligible.filter(c => !set.includes(c.id)).length,
  }
}

// Adds more cards to today's set.
function more({ count, now = new Date(), cfg = configService.load(), rng = Math.random } = {}) {
  const snap = snapshot({ now, cfg })
  const current = today({ now, cfg, rng })
  const extra = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(count)) || snap.settings.dailyCount))
  const existing = current.cards.map(c => c.id)
  const added = core.buildSet({ cards: snap.eligible, states: snap.states, today: snap.today, count: extra, exclude: existing, rng })
  database.savePracticeDay(snap.today, [...existing, ...added], filterKey(snap.settings))
  return today({ now, cfg, rng })
}

function knownCard(cardId) {
  return typeof cardId === 'string' && CARD_ID.test(cardId) && allCards().some(c => c.id === cardId)
}

function rate(cardId, rating, { now = new Date() } = {}) {
  if (!Object.prototype.hasOwnProperty.call(core.RATINGS, rating)) return { success: false, error: 'Unknown rating.' }
  if (!knownCard(cardId)) return { success: false, error: 'That card no longer exists.' }
  const day = database.localDateString(now)
  const prev = database.getPracticeStates().find(s => s.card_id === cardId) || null
  const state = core.nextState(prev, rating, day)
  database.savePracticeReview({ cardId, state, rating, day })
  return { success: true, state: { ease: state.ease, interval: state.interval_days, reps: state.reps, lapses: state.lapses, dueOn: state.due_on } }
}

function flag(cardId, reason, note = '') {
  if (!FLAG_REASONS.includes(reason)) return { success: false, error: 'Choose why the card is a problem.' }
  if (!knownCard(cardId)) return { success: false, error: 'That card no longer exists.' }
  database.setPracticeFlag(cardId, reason, String(note || '').trim().slice(0, 500))
  return { success: true }
}

function unflag(cardId) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return { success: false, error: 'Unknown card.' }
  database.clearPracticeFlag(cardId)
  return { success: true }
}

// Every card with its schedule, for browsing and search, plus the reported ones.
function bank({ now = new Date(), cfg = configService.load() } = {}) {
  const snap = snapshot({ now, cfg })
  return {
    day: snap.today,
    topics: snap.topics,
    settings: snap.settings,
    cards: snap.cards.map(c => view(c, snap)),
    // A reported card whose question has since gone (a regenerated job deck)
    // still appears, so the report can be cleared.
    orphanFlags: [...snap.flags.values()].filter(f => !snap.cards.some(c => c.id === f.card_id)),
  }
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
  return {
    day: t.day,
    cards: t.cards.map(c => ({
      id: c.id, deck: c.deck, topic: c.topic, question: c.question, difficulty: c.difficulty,
      versions: c.versions, category: c.category || null, blocks: core.answerBlocks(c.answer, c.format),
      intervals: c.intervals, isNew: !c.state, done: c.done, flagged: Boolean(c.flag),
    })),
    queue: t.queue,
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
  JOB_TOPIC, DEFAULT_COUNT, MAX_COUNT, FLAG_REASONS, WEEKLY_GOAL_DAYS,
  loadBank, resetBank, jobCards, today, more, rate, flag, unflag, bank, stats, saveSettings, forPhone,
}
