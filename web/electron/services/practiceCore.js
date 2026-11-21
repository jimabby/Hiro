// Practice: the parts with no Hiro in them.
//
// SM-2 scheduling, choosing the day's cards, streak arithmetic and question-bank
// validation. Pure functions over plain objects: no database, no config, no
// Electron. Kept apart so the phone app (and a standalone Practice app, should
// there ever be one) can reuse the same rules rather than drifting from them.
//
// Days are local calendar days written "YYYY-MM-DD", compared as strings.

// SM-2 quality per button. Again is a failed recall (below 3); Hard, Good and
// Easy are passes of increasing confidence.
const RATINGS = { again: 2, hard: 3, good: 4, easy: 5 }
const START_EASE = 2.5
const MIN_EASE = 1.3
const MAX_INTERVAL = 365
const DIFFICULTIES = ['easy', 'medium', 'hard']

const pad = n => String(n).padStart(2, '0')
const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number)
  return dayOf(new Date(y, m - 1, d + n))
}

// The next schedule for a card after a rating. `prev` is the stored state (or
// null for a card never seen). Follows SM-2 as published: a failed recall
// restarts the repetitions without touching the ease; a pass grows the interval
// 1 → 6 → interval × ease, then adjusts the ease by how hard the recall was.
function nextState(prev, rating, today) {
  const q = RATINGS[rating]
  if (q == null) throw new Error(`Unknown rating: ${rating}`)
  let ease = Number(prev?.ease) || START_EASE
  let interval = Math.max(0, Number(prev?.interval_days) || 0)
  let reps = Math.max(0, Number(prev?.reps) || 0)
  let lapses = Math.max(0, Number(prev?.lapses) || 0)
  if (q < 3) {
    reps = 0
    interval = 1
    lapses += 1
  } else {
    interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ease)
    reps += 1
    ease = Math.max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
  }
  interval = Math.min(MAX_INTERVAL, Math.max(1, interval))
  return {
    ease: Math.round(ease * 100) / 100,
    interval_days: interval,
    reps,
    lapses,
    due_on: addDays(today, interval),
    last_rating: rating,
  }
}

// Days until the card returns for each button, for the button labels.
function previewIntervals(prev, today) {
  const out = {}
  for (const r of Object.keys(RATINGS)) out[r] = nextState(prev, r, today).interval_days
  return out
}

// Fisher–Yates with an injectable random source, so tests can pin the order.
function shuffle(items, rng = Math.random) {
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Picks the day's cards.
//
//   cards   — every eligible card (already filtered by topic, flags removed)
//   states  — Map of card id → stored state
//   keep    — ids that must stay (cards already answered today)
//   exclude — ids that may not be chosen (already in today's set)
//
// Due reviews come first, most overdue and then hardest first: a forgotten card
// is what spaced repetition exists to catch. New cards fill what is left, job
// cards before bank cards, because a deck made from a real application is the
// one with an interview attached.
function buildSet({ cards, states, today, count, keep = [], exclude = [], rng = Math.random }) {
  const taken = new Set([...keep, ...exclude])
  const chosen = [...keep]
  const due = cards
    .filter(c => !taken.has(c.id) && states.get(c.id) && states.get(c.id).due_on <= today)
    .sort((a, b) => {
      const sa = states.get(a.id), sb = states.get(b.id)
      return sa.due_on === sb.due_on ? sa.ease - sb.ease : sa.due_on < sb.due_on ? -1 : 1
    })
  const fresh = cards.filter(c => !taken.has(c.id) && !states.get(c.id))
  const freshJob = fresh.filter(c => c.deck === 'job').sort((a, b) => (b.applicationId || 0) - (a.applicationId || 0))
  const freshBank = shuffle(fresh.filter(c => c.deck !== 'job'), rng)
  for (const c of [...due, ...freshJob, ...freshBank]) {
    if (chosen.length >= count) break
    chosen.push(c.id)
  }
  return chosen
}

// Practice days → streak and this week's count. `days` is any list of
// "YYYY-MM-DD" strings; duplicates are fine. A streak survives until the end of
// a day with no practice, so it still counts this morning before today's set.
function dayStats(days, today, weekStartDay) {
  const set = new Set(days)
  let streak = 0
  let cursor = set.has(today) ? today : addDays(today, -1)
  while (set.has(cursor)) { streak++; cursor = addDays(cursor, -1) }
  const thisWeek = [...set].filter(d => d >= weekStartDay && d <= today).length
  return { streak, daysThisWeek: thisWeek, practisedToday: set.has(today) }
}

// Local Monday of the week containing `day`.
function mondayOf(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return dayOf(date)
}

// ─── Question bank validation ──────────────────────────────────────
//
// The bank is data that will one day arrive over the network, so nothing in it
// is trusted: an entry that does not have the expected shape is dropped rather
// than half-shown. Answers are an HTML subset that the renderer rebuilds tag by
// tag (SafeAnswer.jsx); this only checks sizes and types.

const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const textList = (v, maxItems, maxLen) => Array.isArray(v)
  ? v.filter(s => typeof s === 'string' && s.trim() && s.length <= maxLen).slice(0, maxItems)
  : []

function cleanQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id)) return null
  if (!isText(raw.topic, 60) || !isText(raw.question, 500) || !isText(raw.answer, 8000)) return null
  return {
    id: raw.id,
    deck: 'bank',
    format: 'html',
    topic: raw.topic.trim(),
    question: raw.question.trim(),
    answer: raw.answer,
    difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : null,
    tags: textList(raw.tags, 20, 40),
    versions: textList(raw.versions, 10, 40),
    updatedAt: typeof raw.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.updatedAt) ? raw.updatedAt.slice(0, 10) : null,
  }
}

// A parsed bank file → its valid questions, first occurrence of each id kept.
function cleanBank(parsed) {
  const list = Array.isArray(parsed?.questions) ? parsed.questions : []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const q = cleanQuestion(raw)
    if (!q || seen.has(q.id)) continue
    seen.add(q.id)
    out.push(q)
  }
  return out
}

// ─── Answers as text blocks ────────────────────────────────────────
//
// The phone has no HTML renderer, and should not need one. An answer becomes a
// list of blocks — { type: 'p' | 'li' | 'pre', marker?, spans: [{ text, bold?,
// italic?, code? }] } — that a native app can draw with plain text views. The
// output is text only, so nothing in a bank answer can become markup or script
// on the way through. Unknown tags keep their text; script and style lose it.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const decode = s => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  const k = e.toLowerCase()
  if (ENTITIES[k] != null) return ENTITIES[k]
  const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
})

function answerBlocks(answer, format = 'html') {
  if (format === 'text') {
    return String(answer || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
      .map(text => ({ type: 'p', spans: [{ text }] }))
  }
  const blocks = []
  let block = null
  const lists = [] // { ordered, n }
  let bold = 0, italic = 0, code = 0, pre = 0, skip = null
  const open = (type, marker) => { block = { type, spans: [] }; if (marker) block.marker = marker; blocks.push(block) }
  const close = () => { block = null }
  for (const m of String(answer || '').matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*>|([^<]+)|(<)/g)) {
    const [, slash, rawTag, text, stray] = m
    if (skip) { if (slash && rawTag?.toLowerCase() === skip) skip = null; continue }
    if (text != null || stray) {
      let t = decode(text ?? stray)
      if (!pre) t = t.replace(/\s+/g, ' ')
      if (!t || (!block && !t.trim())) continue
      if (!block) open('p')
      const span = { text: t }
      if (bold) span.bold = true
      if (italic) span.italic = true
      if (code || pre) span.code = true
      block.spans.push(span)
      continue
    }
    const tag = rawTag.toLowerCase()
    const closing = slash === '/'
    if (tag === 'script' || tag === 'style' || tag === 'template') { if (!closing) skip = tag; continue }
    if (tag === 'b' || tag === 'strong') bold = Math.max(0, bold + (closing ? -1 : 1))
    else if (tag === 'i' || tag === 'em') italic = Math.max(0, italic + (closing ? -1 : 1))
    else if (tag === 'code') code = Math.max(0, code + (closing ? -1 : 1))
    else if (tag === 'pre') { pre = Math.max(0, pre + (closing ? -1 : 1)); if (closing) close(); else open('pre') }
    else if (tag === 'p') close()
    else if (tag === 'ul' || tag === 'ol') { if (closing) lists.pop(); else lists.push({ ordered: tag === 'ol', n: 0 }); close() }
    else if (tag === 'li') {
      if (closing) { close(); continue }
      const list = lists[lists.length - 1]
      open('li', list?.ordered ? `${++list.n}.` : '•')
    } else if (tag === 'br' && block) block.spans.push({ text: '\n' })
  }
  // Trim each block's edges and drop the ones left empty.
  return blocks.map(b => {
    const spans = b.spans.slice()
    if (b.type !== 'pre') {
      if (spans.length) spans[0] = { ...spans[0], text: spans[0].text.replace(/^\s+/, '') }
      if (spans.length) spans[spans.length - 1] = { ...spans[spans.length - 1], text: spans[spans.length - 1].text.replace(/\s+$/, '') }
    } else if (spans.length) {
      spans[0] = { ...spans[0], text: spans[0].text.replace(/^\n/, '') }
      spans[spans.length - 1] = { ...spans[spans.length - 1], text: spans[spans.length - 1].text.replace(/\n$/, '') }
    }
    return { ...b, spans: spans.filter(s => s.text) }
  }).filter(b => b.spans.length)
}

module.exports = {
  RATINGS, START_EASE, MIN_EASE, MAX_INTERVAL, DIFFICULTIES,
  addDays, nextState, previewIntervals, shuffle, buildSet, dayStats, mondayOf,
  cleanQuestion, cleanBank, answerBlocks,
}
