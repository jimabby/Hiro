// Practice flashcards: SM-2 scheduling, the daily set, reports, streaks, job
// decks, and the shipped question bank itself.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-practice-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { practice: { topics: [], dailyCount: 8 } }
stub({
  './config': { CONFIG_DIR: TMP, load: () => ({ ...config }), update: p => { config = { ...config, ...p }; return config } },
  './logger': { append: () => {} },
})

const db = service('database')
const core = service('practiceCore')
const practice = service('practice')
const { check, done } = createChecker()

// A fixed sequence, so "random" new cards are the same on every run.
const seq = () => { let i = 0; return () => ((i++ * 0.37) % 1) }
const at = day => new Date(`${day}T10:00:00`)

async function main() {
  // ─── SM-2 ─────────────────────────────────────────────────────
  const today = '2026-11-21'
  let s = core.nextState(null, 'good', today)
  check('first pass comes back tomorrow', [s.interval_days, s.reps, s.due_on], [1, 1, '2026-11-22'])
  check('Good leaves the ease alone', s.ease, 2.5)
  s = core.nextState(s, 'good', '2026-11-22')
  check('second pass waits six days', [s.interval_days, s.due_on], [6, '2026-11-28'])
  s = core.nextState(s, 'good', '2026-11-28')
  check('third pass multiplies by the ease', s.interval_days, 15)
  const hard = core.nextState(s, 'hard', '2026-12-13')
  check('Hard lowers the ease by 0.14', hard.ease, 2.36)
  const easy = core.nextState(s, 'easy', '2026-12-13')
  check('Easy raises the ease by 0.1', easy.ease, 2.6)
  const fail = core.nextState(s, 'again', '2026-12-13')
  check('Again restarts the card for tomorrow', [fail.reps, fail.interval_days, fail.due_on, fail.lapses], [0, 1, '2026-12-14', 1])
  check('Again keeps the ease (SM-2)', fail.ease, s.ease)
  let low = { ease: 1.35, interval_days: 10, reps: 3, lapses: 0 }
  low = core.nextState(low, 'hard', today)
  check('the ease never drops below 1.3', low.ease, 1.3)
  check('intervals are capped at a year', core.nextState({ ease: 2.5, interval_days: 300, reps: 5 }, 'easy', today).interval_days, 365)
  check('month ends roll over', core.addDays('2026-01-31', 1), '2026-02-01')
  let threw = false
  try { core.nextState(null, 'meh', today) } catch { threw = true }
  check('an unknown rating is refused', threw, true)
  check('button previews', core.previewIntervals(null, today), { again: 1, hard: 1, good: 1, easy: 1 })

  // ─── Streaks ──────────────────────────────────────────────────
  check('Monday of a Saturday', core.mondayOf('2026-11-21'), '2026-11-16')
  const ds = core.dayStats(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-12'], '2026-11-21', '2026-11-16')
  check('a streak survives until a full day is missed', ds.streak, 4)
  check('days this week', ds.daysThisWeek, 4)
  check('not yet today', ds.practisedToday, false)
  check('a gap ends the streak', core.dayStats(['2026-11-19'], '2026-11-21', '2026-11-16').streak, 0)

  // ─── Choosing cards ───────────────────────────────────────────
  const cards = [
    { id: 'a', deck: 'bank' }, { id: 'b', deck: 'bank' }, { id: 'c', deck: 'bank' },
    { id: 'd', deck: 'bank' }, { id: 'j1', deck: 'job', applicationId: 2 }, { id: 'j2', deck: 'job', applicationId: 5 },
  ]
  const states = new Map([
    ['a', { due_on: '2026-11-20', ease: 2.5 }],
    ['b', { due_on: '2026-11-18', ease: 2.5 }],
    ['c', { due_on: '2026-11-25', ease: 2.5 }],
  ])
  const set = core.buildSet({ cards, states, today, count: 4, rng: seq() })
  check('overdue first, then new job cards (newest application first)', set, ['b', 'a', 'j2', 'j1'])
  check('kept cards stay and count toward the total', core.buildSet({ cards, states, today, count: 2, keep: ['c'], rng: seq() }), ['c', 'b'])
  check('excluded cards are never chosen', core.buildSet({ cards, states, today, count: 10, exclude: ['b', 'j2'], rng: seq() }).includes('b'), false)
  check('a card not yet due is not chosen', core.buildSet({ cards, states, today, count: 10, rng: seq() }).includes('c'), false)

  // ─── The shipped bank ─────────────────────────────────────────
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'data', 'questions.json'), 'utf8'))
  const bank = practice.loadBank()
  check('every shipped question passes validation', bank.length, raw.questions.length)
  check('the bank is not empty', bank.length >= 150, true)
  const allowed = new Set(['p', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'code', 'pre', 'br'])
  const badTags = raw.questions.flatMap(q => [...q.answer.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)]
    .filter(m => !allowed.has(m[1].toLowerCase()) || m[2].trim()).map(m => `${q.id}: ${m[0]}`))
  check('answers use only the allowed tags, without attributes', badTags, [])
  for (const topic of ['HTML / Web', 'Java', 'JS / TS', 'Node.js', '.NET / C#']) {
    check(`${topic} has at least 20 questions`, bank.filter(q => q.topic === topic).length >= 20, true)
  }
  check('malformed entries are dropped, duplicates keep the first',
    core.cleanBank({ questions: [
      { id: 'x-1', topic: 'T', question: 'Q?', answer: 'A' },
      { id: 'x-1', topic: 'T', question: 'Again?', answer: 'B' },
      { id: 'Bad Id', topic: 'T', question: 'Q', answer: 'A' },
      { id: 'x-2', topic: 'T', question: '', answer: 'A' },
      null,
    ] }).map(q => [q.id, q.question]), [['x-1', 'Q?']])

  // ─── Answers for the phone ────────────────────────────────────
  const blocks = core.answerBlocks('<p>Use <code>===</code>, not <b>==</b>.</p><ul><li>One</li><li><i>Two</i></li></ul><ol><li>A</li><li>B</li></ol><pre><code>if (a &lt; b) {\n  go();\n}</code></pre>')
  check('paragraph spans keep bold and code', blocks[0], { type: 'p', spans: [{ text: 'Use ' }, { text: '===', code: true }, { text: ', not ' }, { text: '==', bold: true }, { text: '.' }] })
  check('bullets', blocks.slice(1, 3).map(b => [b.type, b.marker, b.spans[0].text]), [['li', '•', 'One'], ['li', '•', 'Two']])
  check('italic carried', blocks[2].spans[0].italic, true)
  check('numbered list', blocks.slice(3, 5).map(b => b.marker), ['1.', '2.'])
  check('code blocks keep their lines and decode entities', blocks[5], { type: 'pre', spans: [{ text: 'if (a < b) {\n  go();\n}', code: true }] })
  check('scripts lose their text, unknown tags keep theirs',
    core.answerBlocks('<p>Hi<script>alert(1)</script> <a href="x">there</a></p>').map(b => b.spans.map(s => s.text).join('')), ['Hi there'])
  check('text answers become paragraphs', core.answerBlocks('One\n\nTwo <b>x</b>', 'text').map(b => b.spans[0].text), ['One', 'Two <b>x</b>'])
  const everyBankAnswer = practice.loadBank().every(q => core.answerBlocks(q.answer).length > 0)
  check('every bank answer converts to at least one block', everyBankAnswer, true)

  // ─── The service, end to end ──────────────────────────────────
  await db.init()
  const day = '2026-11-21'
  config.practice = { topics: ['Node.js'], dailyCount: 5 }
  let t = practice.today({ now: at(day), rng: seq() })
  check('a day gets the configured number of cards', t.cards.length, 5)
  check('only the chosen topics', t.cards.every(c => c.topic === 'Node.js'), true)
  check('everything starts in the queue', t.queue.length, 5)
  const again = practice.today({ now: at(day), rng: Math.random })
  check('the set stays the same all day', again.cards.map(c => c.id), t.cards.map(c => c.id))

  const first = t.queue[0]
  check('rating a card', practice.rate(first, 'good', { now: at(day) }).state.dueOn, '2026-11-22')
  t = practice.today({ now: at(day) })
  check('a rated card leaves the queue', [t.queue.includes(first), t.doneCount], [false, 1])
  check('an unknown card cannot be rated', practice.rate('nope-999', 'good', { now: at(day) }).success, false)
  check('an unknown rating is refused by the service', practice.rate(t.queue[0], 'meh', { now: at(day) }).success, false)

  const second = t.queue[0]
  check('reporting needs a reason', practice.flag(second, 'boring').success, false)
  check('reporting a card', practice.flag(second, 'outdated', 'Express 5 is out').success, true)
  t = practice.today({ now: at(day) })
  check('a reported card leaves the queue', t.queue.includes(second), false)
  const b = practice.bank({ now: at(day) })
  check('the report is kept with its note', b.cards.find(c => c.id === second).flag.note, 'Express 5 is out')
  check('stats count reports', practice.stats({ now: at(day) }).flagged, 1)
  practice.unflag(second)
  check('restoring puts it back', practice.today({ now: at(day) }).queue.includes(second), true)

  config.practice = { topics: ['Java'], dailyCount: 5 }
  t = practice.today({ now: at(day), rng: seq() })
  check('changing topics keeps what was done today', t.cards.some(c => c.id === first && c.done), true)
  check('and fills the rest from the new topic', t.cards.filter(c => !c.done).every(c => c.topic === 'Java'), true)
  check('the set is still the configured size', t.cards.length, 5)

  for (const id of t.queue) practice.rate(id, 'good', { now: at(day) })
  t = practice.today({ now: at(day) })
  check('done for the day', t.queue.length, 0)
  t = practice.more({ count: 3, now: at(day), rng: seq() })
  check('practising more adds new cards', [t.cards.length, t.queue.length], [8, 3])

  const st = practice.stats({ now: at(day) })
  check('practised today', [st.practisedToday, st.streak, st.daysThisWeek], [true, 1, 1])
  practice.rate(t.queue[0], 'hard', { now: at('2026-11-22') })
  const next = practice.stats({ now: at('2026-11-22') })
  check('two days running is a streak of 2', next.streak, 2)
  check('cards rated Good yesterday are due today', next.due >= 4, true)
  const tomorrow = practice.today({ now: at('2026-11-22'), rng: seq() })
  check('a new day brings due cards back first', tomorrow.cards.slice(0, 3).every(c => c.state && c.state.dueOn <= '2026-11-22'), true)

  const phone = practice.forPhone({ now: at('2026-11-22') })
  check('the phone gets text blocks, not HTML', [Array.isArray(phone.cards[0].blocks), 'answer' in phone.cards[0]], [true, false])
  check('the phone gets the stats with the day', phone.stats.streak, 2)

  check('saving settings drops unknown topics and clamps the count',
    practice.saveSettings({ topics: ['Java', 'Made up'], dailyCount: 500 }).settings, { topics: ['Java'], dailyCount: 30 })

  // ─── Job decks ────────────────────────────────────────────────
  db.insertApplication({ job_title: 'Backend Developer', company: 'Acme', platform: 'seek', job_url: 'https://example.com/job/1', status: 'Interview' })
  const appId = db.getApplications()[0].id
  db.saveInterviewPrep(appId, [
    { question: 'Tell me about a REST API you built.', answer: 'At Uni I built…', category: 'technical' },
    { question: 'Why Acme?', answer: 'Because…', category: 'behavioral' },
    'A bare string question',
  ])
  const jobs = practice.jobCards()
  check('one card per generated question', jobs.length, 3)
  check('job cards are labelled with the application', jobs[0].topic, 'Acme — Backend Developer')
  check('job answers are plain text', jobs[0].format, 'text')
  check('job card ids are stable for the same question', practice.jobCards()[0].id, jobs[0].id)
  config.practice = { topics: [practice.JOB_TOPIC], dailyCount: 8 }
  const jt = practice.today({ now: at('2026-11-23'), rng: seq() })
  check('the job deck can be practised on its own', jt.cards.length, 3)
  check('a job card can be rated', practice.rate(jobs[1].id, 'easy', { now: at('2026-11-23') }).success, true)

  done()
}

main().catch(err => { console.error(err); process.exit(1) })
