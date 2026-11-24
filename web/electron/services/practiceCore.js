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

// How much further Easy sends a card than Good, and how much Hard grows the
// current interval. Plain SM-2 gives Hard, Good and Easy the same next interval
// (they differ only in the ease they leave behind), so the three buttons showed
// the same "back in 15d" and the choice looked meaningless. These are Anki's
// defaults.
const HARD_FACTOR = 1.2
const EASY_BONUS = 1.3
const EASY_FIRST = 4

// Days until the next look after a pass. Good follows SM-2 as published:
// 1 → 6 → interval × ease. Hard grows the current interval more slowly (and by
// at least a day once the card is past its first steps); Easy goes further
// than Good. Hard never exceeds Good, and Easy always beats it.
function passInterval(q, reps, interval, ease) {
  const good = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ease)
  if (q === RATINGS.good) return good
  if (q === RATINGS.easy) return reps === 0 ? EASY_FIRST : Math.max(good + 1, Math.round(good * EASY_BONUS))
  const hard = reps === 0 ? 1 : reps === 1 ? Math.round(good / 2) : Math.max(interval + 1, Math.round(interval * HARD_FACTOR))
  return Math.min(good, hard)
}

// The next schedule for a card after a rating. `prev` is the stored state (or
// null for a card never seen). A failed recall restarts the repetitions without
// touching the ease (SM-2); a pass grows the interval (passInterval), then
// adjusts the ease by how hard the recall was.
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
    interval = passInterval(q, reps, interval, ease)
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
//   keep     — ids that must stay (cards already answered today)
//   exclude  — ids that may not be chosen (already in today's set)
//   priority — ids that go before everything else (an interview is close)
//
// Priority cards come first: an interview in three days outranks any schedule.
// Then due reviews, most overdue and then hardest first: a forgotten card is
// what spaced repetition exists to catch. New cards fill what is left, job
// cards before bank cards, because a deck made from a real application is the
// one with an interview attached.
function buildSet({ cards, states, today, count, keep = [], exclude = [], priority = [], rng = Math.random }) {
  const taken = new Set([...keep, ...exclude])
  const chosen = [...keep]
  for (const id of priority) {
    if (chosen.length >= count) break
    if (!taken.has(id) && !chosen.includes(id)) { chosen.push(id); taken.add(id) }
  }
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

// Whole days from `today` to `day` (both "YYYY-MM-DD"); 0 is today.
function daysBetween(today, day) {
  const [y1, m1, d1] = String(today).split('-').map(Number)
  const [y2, m2, d2] = String(day).slice(0, 10).split('-').map(Number)
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000)
}

// Ratings → how often each topic is forgotten. `reviews` is [{ card_id,
// rating }], `topicOf` maps a card id to its topic name (or null for a card
// that no longer exists). Topics with fewer than `minReviews` ratings are left
// out: two misses out of two says nothing yet.
function weakTopics(reviews, topicOf, { minReviews = 4 } = {}) {
  const by = new Map()
  for (const r of reviews) {
    const topic = topicOf(r.card_id)
    if (!topic) continue
    const t = by.get(topic) || { name: topic, reviews: 0, again: 0, hard: 0, cards: new Set() }
    t.reviews++
    if (r.rating === 'again') t.again++
    if (r.rating === 'hard') t.hard++
    t.cards.add(r.card_id)
    by.set(topic, t)
  }
  return [...by.values()]
    .filter(t => t.reviews >= minReviews)
    .map(t => ({ name: t.name, reviews: t.reviews, again: t.again, hard: t.hard, cards: t.cards.size, againRate: Math.round((t.again / t.reviews) * 100) / 100 }))
    .sort((a, b) => b.againRate - a.againRate || b.again - a.again || a.name.localeCompare(b.name))
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

// What kind of question it is, shown beside the topic. Bank questions carry one
// of these; generated ones are mapped onto them (normalizeCategory).
const CATEGORIES = ['Concept', 'Comparison', 'Practical', 'Best practice', 'Problem solving', 'Behavioural', 'Technical', 'Situational', 'Role-specific', 'System design']
const CATEGORY_ALIASES = {
  behavioral: 'Behavioural', behavioural: 'Behavioural', technical: 'Technical', situational: 'Situational',
  'role-specific': 'Role-specific', 'role specific': 'Role-specific', concept: 'Concept', conceptual: 'Concept',
  comparison: 'Comparison', practical: 'Practical', 'best practice': 'Best practice', 'best practices': 'Best practice',
  'problem solving': 'Problem solving', 'problem-solving': 'Problem solving', coding: 'Problem solving',
  'system design': 'System design', design: 'System design',
}
function normalizeCategory(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (CATEGORIES.includes(v)) return v
  return CATEGORY_ALIASES[v.toLowerCase()] || null
}

function cleanQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id)) return null
  if (!isText(raw.topic, 60) || !isText(raw.question, 500) || !isText(raw.answer, 8000)) return null
  return {
    id: raw.id,
    deck: 'bank',
    format: 'html',
    category: normalizeCategory(raw.category),
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

// ─── Questions generated from a job ad ─────────────────────────────
//
// A model's reply → clean questions. The reply should be a JSON array, but a
// model may wrap it in prose or a code fence, so the first [...] is taken. Each
// entry is checked like a bank entry: anything malformed is dropped, the rest
// is trimmed to size, and duplicate questions keep the first.
function parseGeneratedQuestions(text, max = 25) {
  const s = String(text || '')
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let list
  try { list = JSON.parse(s.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const question = typeof raw.question === 'string' ? raw.question.trim().slice(0, 500) : ''
    const answer = typeof raw.answer === 'string' ? raw.answer.trim().slice(0, 4000) : ''
    if (question.length < 8 || !answer) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      question,
      answer,
      category: normalizeCategory(raw.category) || 'Technical',
      skill: typeof raw.skill === 'string' ? raw.skill.trim().slice(0, 40) : '',
      difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : null,
    })
    if (out.length >= max) break
  }
  return out
}

// ─── Importing the user's own question files ──────────────────────
//
// CSV, TSV (Quizlet, spreadsheets), Anki's "Notes in Plain Text" export and
// JSON (Hiro's bank format, or a plain list). Each becomes cards of
// { question, answer, format, topic?, category?, difficulty? }. Nothing here
// trusts the file: sizes are capped, HTML answers are kept only as the subset
// the renderer rebuilds tag by tag, and rows that cannot be read are reported
// back with the line they came from rather than silently dropped.

const MAX_IMPORT_CARDS = 2000
const HEADER_ALIASES = {
  question: ['question', 'questions', 'front', 'term', 'prompt', 'q'],
  answer: ['answer', 'answers', 'back', 'definition', 'response', 'a'],
  topic: ['topic', 'subject', 'deck', 'section'],
  category: ['category', 'type', 'kind'],
  difficulty: ['difficulty', 'level'],
}

// RFC 4180-style splitting: quoted fields may hold the delimiter, newlines and
// doubled quotes. Returns rows with the line each one started on.
function splitDelimited(text, delimiter) {
  const rows = []
  let row = [], field = '', quoted = false, line = 1, start = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (ch === '\n') line++
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') { quoted = true; continue }
    if (ch === delimiter) { row.push(field); field = ''; continue }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push({ cells: row, line: start })
      row = []; field = ''; line++; start = line
      continue
    }
    field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line: start }) }
  return rows.filter(r => r.cells.some(c => c.trim()))
}

// Anki writes <div> and <br> for line breaks and may include media and
// cloze markup; keep the text and the tags the renderer allows.
function cleanImportedHtml(html) {
  return String(html || '')
    .replace(/\[sound:[^\]]*\]/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/g, '$1')
    .replace(/<div\b[^>]*>/gi, '<p>').replace(/<\/div>/gi, '</p>')
    .replace(/<(\/?)(b|strong|i|em|code|pre|ul|ol|li|p)\b[^>]*>/gi, '<$1$2>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

const looksHtml = s => /<\/?(p|div|br|b|i|strong|em|ul|ol|li|code|pre)\b/i.test(s)

function importCard(raw) {
  // Block-level tags become a space; inline ones (<b>, <code>) just go, so
  // "What is <b>REST</b>?" does not become "What is REST ?".
  // A leading apostrophe before = + @ is the formula guard exportCards adds to
  // CSV cells, not part of the text.
  const unguard = v => (typeof v === 'string' ? v.replace(/^'(?=[=+@])/, '') : v)
  raw = { ...raw, question: unguard(raw.question), answer: unguard(raw.answer) }
  const question = String(raw.question ?? '')
    .replace(/<\/?(br|p|div|li|ul|ol|h[1-6]|tr|td)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    // One pass, so "&amp;lt;" (a literal "&lt;" in the source) stays "&lt;"
    // instead of being decoded twice into "<".
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, m => decode(m))
    .replace(/\s+/g, ' ').trim()
  let answer = String(raw.answer ?? '').trim()
  if (!question) return { error: 'no question' }
  if (!answer) return { error: 'no answer' }
  if (question.length > 500) return { error: 'question longer than 500 characters' }
  const html = raw.html === true || (raw.html !== false && looksHtml(answer))
  answer = html ? cleanImportedHtml(answer) : answer.replace(/\r\n?/g, '\n')
  if (answer.length > 8000) return { error: 'answer longer than 8,000 characters' }
  const card = { question, answer, format: html ? 'html' : 'markdown' }
  const topic = String(raw.topic ?? '').trim().slice(0, 60)
  if (topic) card.topic = topic
  const category = normalizeCategory(raw.category)
  if (category) card.category = category
  if (DIFFICULTIES.includes(String(raw.difficulty || '').toLowerCase())) card.difficulty = String(raw.difficulty).toLowerCase()
  return { card }
}

function detectFormat(text, name = '') {
  const ext = String(name).toLowerCase().split('.').pop()
  const trimmed = text.trimStart()
  if (ext === 'json' || trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json'
  if (/^#(separator|html|columns|notetype|deck|tags)/im.test(text.slice(0, 2000))) return 'anki'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'csv') return 'csv'
  const first = text.split(/\r?\n/).find(l => l.trim()) || ''
  return first.includes('\t') ? 'tsv' : 'csv'
}

function parseImport(input, { name = '' } = {}) {
  const text = String(input || '').replace(/^\uFEFF/, '')
  const format = detectFormat(text, name)
  const cards = []
  const skipped = []
  const seen = new Set()
  const add = (raw, where) => {
    const { card, error } = importCard(raw)
    if (error) { skipped.push({ where, reason: error }); return }
    const key = card.question.toLowerCase()
    if (seen.has(key)) { skipped.push({ where, reason: 'duplicate question' }); return }
    if (cards.length >= MAX_IMPORT_CARDS) { skipped.push({ where, reason: `more than ${MAX_IMPORT_CARDS} cards` }); return }
    seen.add(key)
    cards.push(card)
  }

  if (format === 'json') {
    let parsed
    try { parsed = JSON.parse(text) } catch { return { format, cards, skipped: [{ where: 'file', reason: 'not valid JSON' }] } }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : Array.isArray(parsed?.cards) ? parsed.cards : null
    if (!list) return { format, cards, skipped: [{ where: 'file', reason: 'no list of questions found' }] }
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object') { skipped.push({ where: `item ${i + 1}`, reason: 'not an object' }); return }
      add({
        question: item.question ?? item.q ?? item.front ?? item.term,
        answer: item.answer ?? item.a ?? item.back ?? item.definition,
        topic: item.topic, category: item.category, difficulty: item.difficulty,
      }, `item ${i + 1}`)
    })
    return { format, cards, skipped }
  }

  let delimiter = format === 'csv' ? ',' : '\t'
  let html = null
  let body = text
  // Anki puts the note type, deck, guid and tags in columns of their own when
  // the export includes them, and says where in "#deck column:2" headers.
  // Those columns are not the question or the answer: the note's fields are
  // the columns left over, in order.
  const ankiColumns = {}
  if (format === 'anki') {
    const lines = text.split(/\r?\n/)
    const headers = []
    while (lines.length && lines[0].startsWith('#')) headers.push(lines.shift())
    for (const h of headers) {
      const col = /^#(notetype|deck|guid|tags)\s+column:\s*(\d+)\s*$/i.exec(h.trim())
      if (col) { ankiColumns[col[1].toLowerCase()] = Number(col[2]) - 1; continue }
      const m = /^#(\w+):(.*)$/.exec(h.trim())
      if (!m) continue
      if (m[1] === 'separator') delimiter = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' }[m[2].trim().toLowerCase()] || m[2] || '\t'
      if (m[1] === 'html') html = m[2].trim().toLowerCase() === 'true'
    }
    body = lines.join('\n')
  } else if (format === 'csv') {
    const first = text.split(/\r?\n/).find(l => l.trim()) || ''
    if (!first.includes(',') && first.includes(';')) delimiter = ';'
  }

  const rows = splitDelimited(body, delimiter)
  let cols = { question: 0, answer: 1 }
  const reserved = new Set(Object.values(ankiColumns).filter(n => n >= 0))
  if (reserved.size) {
    const fields = []
    for (let i = 0; fields.length < 2 && i < 64; i++) if (!reserved.has(i)) fields.push(i)
    cols = { question: fields[0], answer: fields[1] }
    if (ankiColumns.deck >= 0) cols.deck = ankiColumns.deck
  }
  // A deck name is the closest thing an Anki export has to a topic; nested
  // decks ("Interview::Java") keep the innermost name.
  const deckTopic = s => (s == null ? undefined : String(s).split('::').pop().trim() || undefined)
  if (rows.length && !reserved.size) {
    const header = rows[0].cells.map(c => c.trim().toLowerCase())
    const mapped = {}
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const idx = header.findIndex(h => aliases.includes(h))
      if (idx >= 0) mapped[field] = idx
    }
    if (mapped.question != null && mapped.answer != null) { cols = mapped; rows.shift() }
  }
  for (const r of rows) {
    const cell = k => (cols[k] != null ? r.cells[cols[k]] : undefined)
    add({ question: cell('question'), answer: cell('answer'), topic: cell('topic') ?? deckTopic(cell('deck')), category: cell('category'), difficulty: cell('difficulty'), html: html ?? undefined }, `line ${r.line}`)
  }
  return { format, cards, skipped }
}

// The readable part of a web page: the <main> or <article> if it has one, so
// navigation and footers do not become flashcards, else the whole body.
function mainHtml(html) {
  const src = String(html || '')
  for (const tag of ['article', 'main']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(src)
    if (m && m[1].replace(/<[^>]+>/g, '').trim().length > 400) return m[1]
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(src)
  return (body ? body[1] : src).replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
}

function pageTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  const t = og?.[1] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || ''
  return t.replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim().slice(0, 120)
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

// Inline markdown → spans: **bold**, *italic* / _italic_, `code`. Anything
// unbalanced is left as the literal characters.
function inlineSpans(text) {
  const spans = []
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g
  let last = 0
  for (const m of String(text).matchAll(re)) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('**')) spans.push({ text: tok.slice(2, -2), bold: true })
    else if (tok.startsWith('`')) spans.push({ text: tok.slice(1, -1), code: true })
    else spans.push({ text: tok.slice(1, -1), italic: true })
    last = m.index + tok.length
  }
  if (last < text.length) spans.push({ text: text.slice(last) })
  return spans.filter(s => s.text)
}

// A model's reply (light markdown) → the same blocks as answerBlocks.
// Fenced code becomes 'pre', "- " / "* " / "1. " lines become list items,
// headings become bold paragraphs, and blank lines separate paragraphs.
function markdownBlocks(text) {
  const blocks = []
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  let para = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', spans: inlineSpans(para.join(' ').replace(/\s+/g, ' ').trim()) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      if (code.length) blocks.push({ type: 'pre', spans: [{ text: code.join('\n'), code: true }] })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (bullet) { flush(); blocks.push({ type: 'li', marker: '•', spans: inlineSpans(bullet[1].trim()) }); continue }
    if (numbered) { flush(); blocks.push({ type: 'li', marker: `${numbered[1]}.`, spans: inlineSpans(numbered[2].trim()) }); continue }
    if (heading) { flush(); blocks.push({ type: 'p', spans: [{ text: heading[1].replace(/\*\*/g, '').trim(), bold: true }] }); continue }
    para.push(line.trim())
  }
  flush()
  return blocks.filter(b => b.spans.length)
}

function answerBlocks(answer, format = 'html') {
  if (format === 'markdown') return markdownBlocks(answer)
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

// ─── Cram: one topic, now, outside the schedule ───────────────────
//
// Before an interview you want SQL today, not whichever SQL cards happen to be
// due. A cram session draws from one topic, puts the cards you have forgotten
// before (or found hard) into the set first, and shuffles the rest in. Nothing
// about it is recorded: the schedule, the review history and the streak only
// ever see the daily set.
function cramSet({ cards, states, count, rng = Math.random }) {
  const weak = []
  const rest = []
  for (const c of cards) {
    const s = states.get(c.id)
    if (s && (Number(s.lapses) > 0 || Number(s.ease) < START_EASE)) weak.push(c)
    else rest.push(c)
  }
  const lapses = c => Number(states.get(c.id).lapses) || 0
  const ease = c => Number(states.get(c.id).ease) || START_EASE
  weak.sort((a, b) => lapses(b) - lapses(a) || ease(a) - ease(b))
  const picked = [...weak, ...shuffle(rest, rng)].slice(0, Math.max(1, count))
  // Weakest are chosen first but not shown first: a session that opens on the
  // five worst cards in a row is a discouraging way to start.
  return shuffle(picked, rng).map(c => c.id)
}

// ─── Export: cards out, in formats other tools read ───────────────
//
// CSV (Excel, Google Sheets, Quizlet, and Hiro's own import) keeps each answer
// exactly as stored, so a file exported and imported again is the same deck.
// Anki gets HTML built from the answer's text blocks, so nothing in an answer
// reaches Anki as markup Hiro would not itself show; each card goes into a
// "Hiro::<topic>" deck, which Hiro's Anki import reads back as the topic.

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function spansHtml(spans) {
  return spans.map(s => {
    let t = escapeHtml(s.text).replace(/\n/g, '<br>')
    if (s.code) t = `<code>${t}</code>`
    if (s.italic) t = `<i>${t}</i>`
    if (s.bold) t = `<b>${t}</b>`
    return t
  }).join('')
}

// Text blocks (answerBlocks) → the small HTML subset Hiro itself renders.
// Consecutive list items share one list, numbered when their markers are.
function blocksHtml(blocks) {
  const out = []
  let list = null
  for (const b of blocks) {
    if (b.type === 'li') {
      const tag = /^\d/.test(b.marker || '') ? 'ol' : 'ul'
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag }
      out.push(`<li>${spansHtml(b.spans)}</li>`)
      continue
    }
    if (list) { out.push(`</${list}>`); list = null }
    if (b.type === 'pre') out.push(`<pre>${escapeHtml(b.spans.map(s => s.text).join(''))}</pre>`)
    else out.push(`<p>${spansHtml(b.spans)}</p>`)
  }
  if (list) out.push(`</${list}>`)
  return out.join('')
}

// A cell a spreadsheet would run as a formula is opened with an apostrophe,
// which Excel and Sheets hide and parseImport takes off again. "-" is left
// alone: markdown answers start lists with it.
const csvCell = v => {
  let s = String(v ?? '')
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}
const ankiField = v => {
  const s = String(v ?? '')
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const ankiTag = s => String(s || '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_:-]/gu, '')

// cards: [{ question, answer, format, topic, category?, difficulty?, note? }]
function exportCards(cards, format) {
  if (format === 'csv') {
    const rows = [['question', 'answer', 'topic', 'category', 'difficulty', 'notes'].map(csvCell).join(',')]
    for (const c of cards) {
      rows.push([c.question, c.answer, c.topic, c.category || '', c.difficulty || '', c.note || ''].map(csvCell).join(','))
    }
    // The byte-order mark is what makes Excel read the file as UTF-8.
    return `\uFEFF${rows.join('\r\n')}\r\n`
  }
  if (format === 'anki') {
    const lines = ['#separator:tab', '#html:true', '#deck column:3', '#tags column:4']
    for (const c of cards) {
      let back = blocksHtml(answerBlocks(c.answer, c.format || 'html'))
      const note = String(c.note || '').trim()
      if (note) back += `<hr><p><b>My notes</b></p><p>${escapeHtml(note).replace(/\r?\n/g, '<br>')}</p>`
      const deck = `Hiro::${String(c.topic || 'Questions').replace(/::/g, ' ').trim() || 'Questions'}`
      const tags = [c.category, c.difficulty].map(ankiTag).filter(Boolean).join(' ')
      lines.push([escapeHtml(c.question), back, deck, tags].map(ankiField).join('\t'))
    }
    return `${lines.join('\n')}\n`
  }
  throw new Error(`Unknown export format: ${format}`)
}

module.exports = {
  RATINGS, START_EASE, MIN_EASE, MAX_INTERVAL, DIFFICULTIES,
  cramSet, exportCards, blocksHtml,
  addDays, nextState, previewIntervals, shuffle, buildSet, dayStats, mondayOf, daysBetween, weakTopics,
  cleanQuestion, cleanBank, answerBlocks, markdownBlocks, CATEGORIES, normalizeCategory, parseGeneratedQuestions,
  parseImport, splitDelimited, mainHtml, pageTitle, MAX_IMPORT_CARDS,
}
