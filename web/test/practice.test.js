// Practice flashcards: SM-2 scheduling, the daily set, reports, streaks, job
// decks, and the shipped question bank itself.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-practice-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { practice: { topics: [], dailyCount: 8 } }
// The AI, replaced: deck generation gets a JSON reply, Ask AI gets markdown.
const aiCalls = []
let deckReply = null
const NL = String.fromCharCode(10)
const BT = String.fromCharCode(96)
stub({
  './ai/index': {
    chat: async (provider, key, input) => {
      aiCalls.push(input)
      if (input.operation === 'practiceDeck') return deckReply
      return ['It is **a runtime**.', '', '- Point one', '', '```js', 'console.log(1)', '```'].join(NL)
    },
  },
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
  check('button previews', core.previewIntervals(null, today), { again: 1, hard: 1, good: 1, easy: 4 })
  // Plain SM-2 sent Hard, Good and Easy the same distance (15, 15, 15 here),
  // so the buttons read as interchangeable.
  check('Hard, Good and Easy differ once a card is learned', core.previewIntervals(s, '2026-12-13'), { again: 1, hard: 18, good: 38, easy: 49 })
  check('and on the second look', core.previewIntervals({ ease: 2.5, interval_days: 1, reps: 1 }, today), { again: 1, hard: 3, good: 6, easy: 8 })
  check('Hard never beats Good, even at the lowest ease', (() => { const p = core.previewIntervals({ ease: 1.3, interval_days: 2, reps: 2 }, today); return p.hard <= p.good && p.good < p.easy })(), true)
  check('Hard still moves a learned card on by at least a day', core.nextState({ ease: 1.3, interval_days: 10, reps: 4 }, 'hard', today).interval_days > 10, true)

  // ─── Cram selection ───────────────────────────────────────────
  const cramCards = Array.from({ length: 12 }, (_, i) => ({ id: `c-${i}` }))
  const cramStates = new Map([
    ['c-3', { lapses: 4, ease: 1.8 }], ['c-7', { lapses: 1, ease: 2.3 }], ['c-9', { lapses: 0, ease: 2.2 }], ['c-1', { lapses: 0, ease: 2.5 }],
  ])
  const crammed = core.cramSet({ cards: cramCards, states: cramStates, count: 4, rng: seq() })
  check('a cram set always includes the cards forgotten before or found hard', ['c-3', 'c-7', 'c-9'].every(id => crammed.includes(id)), true)
  check('and fills up to the size asked for', new Set(crammed).size, 4)
  check('a cram set is never bigger than the topic', core.cramSet({ cards: cramCards, states: cramStates, count: 50 }).length, 12)

  // ─── Export formats ───────────────────────────────────────────
  const exportable = [
    { question: 'What is <b>REST</b>?', answer: '<p>An <code>HTTP</code> style</p>', format: 'html', topic: 'Web', category: 'Concept', difficulty: 'easy', note: 'Said "stateless"\nin my demo' },
    { question: '=HYPERLINK("x") is a formula?', answer: '- one\n- two', format: 'markdown', topic: 'Deck: Mine' },
  ]
  const csvOut = core.exportCards(exportable, 'csv')
  const csvBack = core.parseImport(csvOut, { name: 'out.csv' })
  check('CSV round-trips questions, answers and topics', csvBack.cards.map(c => [c.question, c.answer, c.topic]), [
    ['What is REST?', '<p>An <code>HTTP</code> style</p>', 'Web'], ['=HYPERLINK("x") is a formula?', '- one\n- two', 'Deck: Mine'],
  ])
  check('a cell a spreadsheet would run is guarded', csvOut.includes(`"'=HYPERLINK`), true)
  const ankiOut = core.exportCards(exportable, 'anki')
  const ankiBack = core.parseImport(ankiOut, { name: 'out.txt' })
  check('Anki export reads back with the deck as topic', ankiBack.cards.map(c => [c.question, c.topic]), [['What is <b>REST</b>?', 'Web'], ['=HYPERLINK("x") is a formula?', 'Deck: Mine']])
  check('Anki answers are rebuilt as safe HTML, notes included', ankiBack.cards[0].answer.startsWith('<p>An <code>HTTP</code> style</p><hr>'), true)
  check('markdown lists become HTML lists for Anki', ankiBack.cards[1].answer, '<ul><li>one</li><li>two</li></ul>')
  check('Anki tags carry the category and difficulty', ankiOut.split('\n')[4].endsWith('\tConcept easy'), true)

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
  const repeat = practice.rate(first, 'easy', { now: at(day) })
  check('a second rating the same day is acknowledged but not applied', [repeat.success, repeat.duplicate, repeat.state.dueOn], [true, true, '2026-11-22'])
  check('and is not counted as another review', practice.insights({ now: at(day), skillsGap: { enoughData: false } }).totals.reviews, 1)
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

  // ─── Cram and export ──────────────────────────────────────────
  const later = at('2026-11-22')
  const statesBefore = JSON.stringify(db.getPracticeStates())
  const reviewsBefore = practice.insights({ now: later, skillsGap: { enoughData: false } }).totals.reviews
  const cr = practice.cram({ topic: 'Java', count: 6, now: later, rng: seq() })
  check('cram draws only from the chosen topic', [cr.success, cr.cards.length, cr.cards.every(c => c.topicKey === 'Java'), cr.total], [true, 6, true, 28])
  check('cram cards carry no rating previews', cr.cards.some(c => 'intervals' in c), false)
  check('cramming saves nothing', [JSON.stringify(db.getPracticeStates()), practice.insights({ now: later, skillsGap: { enoughData: false } }).totals.reviews], [statesBefore, reviewsBefore])
  check('cram sessions are capped at the topic size', practice.cram({ topic: 'Java', count: 999, now: later }).cards.length, 28)
  check('a topic with no cards cannot be crammed', practice.cram({ topic: 'Made up', now: later }).success, false)
  check('cram needs a topic', practice.cram({ now: later }).success, false)

  const exportId = tomorrow.cards[0].id
  practice.saveNote(exportId, 'Used it in the booking API')
  const ex = practice.exportCards({ ids: [exportId, 'nope-999', exportId, '../etc'], format: 'csv', now: later })
  check('export takes each existing card once', [ex.success, ex.count, ex.extension], [true, 1, 'csv'])
  const exBack = core.parseImport(ex.text, { name: 'x.csv' })
  check('an exported CSV imports back with the same question', exBack.cards[0].question, tomorrow.cards[0].question)
  check('and the note travels in its own column', ex.text.includes('Used it in the booking API'), true)
  const exAnki = practice.exportCards({ ids: [exportId], format: 'anki', now: later })
  check('Anki export', [exAnki.extension, exAnki.text.startsWith('#separator:tab'), exAnki.text.includes(`Hiro::${tomorrow.cards[0].topic}`)], ['txt', true, true])
  check('an unknown export format is refused', practice.exportCards({ ids: [exportId], format: 'xlsx' }).success, false)
  check('nothing to export is refused', practice.exportCards({ ids: [], format: 'csv' }).success, false)
  practice.saveNote(exportId, '')

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
  check('job answers are read as light markdown', jobs[0].format, 'markdown')
  check('job card ids are stable for the same question', practice.jobCards()[0].id, jobs[0].id)
  config.practice = { topics: [practice.JOB_TOPIC], dailyCount: 8 }
  const jt = practice.today({ now: at('2026-11-23'), rng: seq() })
  check('the job deck can be practised on its own', jt.cards.length, 3)
  check('a job card can be rated', practice.rate(jobs[1].id, 'easy', { now: at('2026-11-23') }).success, true)

  // ─── Categories ───────────────────────────────────────────────
  check('every bank question has a category', practice.loadBank().every(q => q.category), true)
  check('model categories are normalised', [core.normalizeCategory('behavioral'), core.normalizeCategory('Role specific'), core.normalizeCategory('nonsense')], ['Behavioural', 'Role-specific', null])
  check('job cards carry their category', jobs.find(j => j.question === 'Why Acme?').category, 'Behavioural')

  // ─── Notes ────────────────────────────────────────────────────
  const noteCard = practice.loadBank()[0].id
  check('saving a note', practice.saveNote(noteCard, '  My example: the booking API  ').note, 'My example: the booking API')
  check('the note travels with the card', practice.bank({ now: at('2026-11-23') }).cards.find(c => c.id === noteCard).note, 'My example: the booking API')
  check('notes are capped', practice.saveNote(noteCard, 'x'.repeat(6000)).note.length, 5000)
  practice.saveNote(noteCard, '')
  check('an empty note removes it', practice.bank({ now: at('2026-11-23') }).cards.find(c => c.id === noteCard).note, '')
  check('a note on an unknown card is refused', practice.saveNote('nope-1', 'x').success, false)

  // ─── Ask AI ───────────────────────────────────────────────────
  config.aiProvider = undefined
  check('asking needs an AI provider', (await practice.explain(noteCard)).success, false)
  config.aiProvider = 'claude'; config.aiApiKey = 'test-key'
  const firstAsk = await practice.explain(noteCard)
  check('the AI explains a card', firstAsk.success, true)
  check('the reply arrives as safe blocks', firstAsk.entry.blocks.map(b => b.type), ['p', 'li', 'pre'])
  check('the card text is fenced as data in the prompt', /untrusted input/i.test(aiCalls[aiCalls.length - 1].messages[0].content), true)
  const followAsk = await practice.explain(noteCard, 'Show me a C# example')
  check('a follow-up is asked and kept', followAsk.entry.prompt, 'Show me a C# example')
  check('the follow-up sees the earlier answer', aiCalls[aiCalls.length - 1].messages[0].content.includes('Earlier in this conversation'), true)
  check('explanations are saved with the card', practice.explanations(noteCard).length, 2)
  check('the card shows it has saved AI help', practice.bank({ now: at('2026-11-23') }).cards.find(c => c.id === noteCard).explained, true)
  practice.clearExplanations(noteCard)
  check('clearing removes them', practice.explanations(noteCard).length, 0)

  // ─── Decks from a job ad ──────────────────────────────────────
  const ad = 'Junior React Developer at Acme. You will build features in React and TypeScript, call REST APIs, write Jest tests and join code reviews. Nice to have: Node.js and Docker.'
  check('a short ad is refused before any AI call', (await practice.generateDeck({ jobText: 'React dev' })).success, false)
  deckReply = 'Here you go:' + NL + JSON.stringify([
    { question: 'What does useEffect do?', answer: 'Runs side effects after render.', category: 'technical', skill: 'React', difficulty: 'easy' },
    { question: 'How do you type props in TypeScript?', answer: 'With an interface or type alias.', category: 'Practical', skill: 'TypeScript', difficulty: 'medium' },
    { question: 'Tell me about a code review you learned from.', answer: 'Use STAR.', category: 'behavioral', difficulty: 'easy' },
    { question: 'What does useEffect do?', answer: 'Duplicate.', category: 'technical' },
    { question: 'x', answer: '' },
  ])
  const made = await practice.generateDeck({ jobText: ad, count: 15 })
  check('a deck is generated from the ad', [made.success, made.deck && made.deck.cards], [true, 3])
  check('the deck is named from the ad when no name is given', made.deck.title, ad.slice(0, 60))
  check('the ad is fenced as untrusted input', aiCalls[aiCalls.length - 1].messages[0].content.includes('JOB AD'), true)
  const named = await practice.generateDeck({ title: 'Acme', jobText: ad, count: 10 })
  check('a chosen name is used', named.deck.title, 'Acme')
  check('a second deck with the same name is numbered', (await practice.generateDeck({ title: 'Acme', jobText: ad })).deck.title, 'Acme (2)')
  const deckList = practice.decks()
  check('decks are listed', deckList.generated.map(d => d.title).includes('Acme'), true)
  check('deck cards join the topics', practice.bank({ now: at('2026-11-23') }).topics.some(t => t.name === 'Deck: Acme'), true)
  config.practice = { topics: ['Deck: Acme'], dailyCount: 8 }
  const dt = practice.today({ now: at('2026-11-24'), rng: seq() })
  check('a generated deck can be practised on its own', [dt.cards.length, dt.cards.every(c => c.deck === 'custom')], [3, true])
  check('generated answers come as blocks', Array.isArray(dt.cards[0].blocks), true)
  check('a generated card can be rated', practice.rate(dt.cards[0].id, 'good', { now: at('2026-11-24') }).success, true)
  check('renaming a deck', practice.renameDeck(named.deck.id, 'Acme React').success, true)
  check('the chosen topic follows the rename', config.practice.topics, ['Deck: Acme React'])
  check('a rename may not clash', practice.renameDeck(named.deck.id, 'Acme (2)').success, false)
  check('deleting a deck', practice.deleteDeck(named.deck.id).success, true)
  check('its cards are gone', practice.deckCards().some(c => c.deckId === named.deck.id), false)
  deckReply = 'Sorry, I cannot help with that.'
  check('an unusable reply is reported, not saved', (await practice.generateDeck({ jobText: ad })).success, false)

  // ─── Markdown for model text ──────────────────────────────────
  const md = ['# Title', 'Some **bold** and ' + BT + 'code' + BT + '.', '', '1. One', '2. Two'].join(NL)
  check('markdown blocks', core.markdownBlocks(md).map(b => [b.type, b.marker || '', b.spans.map(x => x.text).join('')]),
    [['p', '', 'Title'], ['p', '', 'Some bold and code.'], ['li', '1.', 'One'], ['li', '2.', 'Two']])

  // ─── Core: priority, days, weak topics ─────────────────────────
  check('priority cards go first', core.buildSet({ cards, states, today, count: 3, priority: ['c', 'd'], rng: seq() }), ['c', 'd', 'b'])
  check('priority respects kept cards and the count', core.buildSet({ cards, states, today, count: 2, keep: ['a'], priority: ['c', 'd'], rng: seq() }), ['a', 'c'])
  check('days between', [core.daysBetween('2026-11-21', '2026-11-24 10:00:00'), core.daysBetween('2026-12-31', '2027-01-01')], [3, 1])
  const wt = core.weakTopics([
    { card_id: 'x1', rating: 'again' }, { card_id: 'x1', rating: 'again' }, { card_id: 'x2', rating: 'good' }, { card_id: 'x2', rating: 'hard' },
    { card_id: 'y1', rating: 'good' }, { card_id: 'y1', rating: 'good' }, { card_id: 'y2', rating: 'again' }, { card_id: 'y2', rating: 'good' },
    { card_id: 'z1', rating: 'again' }, { card_id: 'gone', rating: 'again' },
  ], id => ({ x1: 'Node', x2: 'Node', y1: 'SQL', y2: 'SQL', z1: 'CSS' }[id] || null))
  check('weak topics are ranked by how often they are forgotten', wt.map(t => [t.name, t.againRate, t.cards]), [['Node', 0.5, 2], ['SQL', 0.25, 2]])

  // ─── Interview countdown ──────────────────────────────────────
  const realNow = new Date()
  const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const inDays = n => { const d = new Date(realNow); d.setDate(d.getDate() + n); return localDay(d) }
  // A day well clear of the fixed dates the earlier tests used.
  const testDay = new Date(realNow.getTime() + 10 * 86400000)
  config.practice = { topics: ['Java'], dailyCount: 4 }
  db.addInterviewEvent({ applicationId: appId, scheduledAt: `${inDays(13)} 10:00:00` })
  db.insertApplication({ job_title: 'Graduate .NET Developer', company: 'Contoso', platform: 'seek', job_url: 'https://example.com/job/2', status: 'Interview' })
  const contosoId = db.getApplications().find(a => a.company === 'Contoso').id
  db.addInterviewEvent({ applicationId: contosoId, scheduledAt: `${inDays(15)} 09:00:00` })
  db.insertApplication({ job_title: 'Far Away', company: 'Later Co', platform: 'seek', job_url: 'https://example.com/job/3', status: 'Interview' })
  db.addInterviewEvent({ applicationId: db.getApplications().find(a => a.company === 'Later Co').id, scheduledAt: `${inDays(30)} 09:00:00` })
  const ct = practice.today({ now: testDay, rng: seq() })
  check('interviews in the next week are counted down', ct.countdown.map(c => [c.company, c.daysLeft]), [['Acme', 3], ['Contoso', 5]])
  const acmeLeft = ct.countdown[0].cardsLeft
  check('the job deck leads the day, whatever topics are chosen', ct.cards.slice(0, acmeLeft).every(c => c.applicationId === appId), true)
  check('an interview with no questions yet says so', ct.countdown[1].cards, 0)
  check('card ids stay out of the public countdown', 'cardIds' in ct.countdown[0], false)
  practice.rate(ct.queue[0], 'good', { now: testDay })
  check('cards left goes down as they are done', practice.today({ now: testDay }).countdown[0].cardsLeft, acmeLeft - 1)
  check('preparing a deck for an unknown application is refused', (await practice.prepareJobDeck(99999)).success, false)

  // ─── Weak topics with demand ──────────────────────────────────
  const nodeCards = practice.loadBank().filter(q => q.topic === 'Node.js').slice(10, 14)
  for (const q of nodeCards) practice.rate(q.id, 'again', { now: testDay })
  const ins = practice.insights({ now: testDay, skillsGap: { enoughData: true, sample: 30, missing: [{ skill: 'Node.js', share: 0.4, jobs: 12 }], covered: [{ skill: 'Java', share: 0.3, jobs: 9 }] } })
  const nodeRow = ins.topics.find(t => t.name === 'Node.js')
  check('a forgotten topic shows up as weak', nodeRow && nodeRow.again >= 4, true)
  check('demand from the skills report is joined to the topic', nodeRow.demand, { skill: 'Node.js', share: 0.4, jobs: 12, inResume: false })
  check('the cards forgotten most are listed', ins.weakCards.some(c => nodeCards.some(q => q.id === c.id)), true)
  check('totals', ins.totals.reviews > 0 && ins.skillsGap.available, true)

  // ─── STAR stories ─────────────────────────────────────────────
  check('a story needs a title', practice.saveStory({ situation: 'x' }).success, false)
  check('a story needs some content', practice.saveStory({ title: 'Empty' }).success, false)
  const behaviouralCard = practice.loadBank().find(q => q.category === 'Behavioural').id
  const story1 = practice.saveStory({ title: 'Capstone demo', situation: 'Final-year project', task: 'Deploy broke', action: 'Fixed the pipeline', result: 'Demo on time', cardId: behaviouralCard })
  check('a story is saved', story1.success, true)
  check('written from a question, it is attached to it', practice.bank({ now: testDay }).cards.find(c => c.id === behaviouralCard).storyIds, [story1.story.id])
  check('editing a story', practice.saveStory({ id: story1.story.id, title: 'Capstone demo rescue', result: 'Demo on time; client signed off' }).story.title, 'Capstone demo rescue')
  const other = practice.loadBank().find(q => q.category === 'Behavioural' && q.id !== behaviouralCard).id
  check('attaching a story to another question', practice.linkStory(other, story1.story.id).success, true)
  check('the story counts its questions', practice.stories().find(x => x.id === story1.story.id).linkedCards, 2)
  await practice.explain(behaviouralCard)
  check('Ask AI sees the attached story', aiCalls[aiCalls.length - 1].messages[0].content.includes('MY STAR STORIES'), true)
  check('the phone gets the story with the card', (() => {
    config.practice = { topics: ['Behavioural'], dailyCount: 30 }
    const ph = practice.forPhone({ now: new Date(testDay.getTime() + 2 * 86400000) })
    const c = ph.cards.find(x => x.id === behaviouralCard)
    return c ? c.stories.map(x => x.title) : ['card not in set']
  })(), ['Capstone demo rescue'])
  practice.unlinkStory(other, story1.story.id)
  check('detaching', practice.stories().find(x => x.id === story1.story.id).linkedCards, 1)
  practice.deleteStory(story1.story.id)
  check('deleting a story removes its links', practice.bank({ now: testDay }).cards.find(c => c.id === behaviouralCard).storyIds, [])

  // ─── Daily reminder ───────────────────────────────────────────
  check('the reminder is off by default', practice.reminderSettings(), { enabled: false, time: '19:00' })
  check('a bad time is refused', practice.saveReminder({ enabled: true, time: '7pm' }).success, false)
  check('saving the reminder', practice.saveReminder({ enabled: true, time: '07:30' }).settings, { enabled: true, time: '07:30' })
  const tomorrow2 = new Date(testDay.getTime() + 86400000)
  config.practice = { topics: [], dailyCount: 8 }
  const text = practice.reminderText({ now: tomorrow2 })
  check('the reminder leads with the interview when one is close', /Acme interview in 2 days/.test(text || ''), true)
  check('and says how long it takes', /about \d+ minutes/.test(text || ''), true)
  const t2 = practice.today({ now: tomorrow2 })
  practice.rate(t2.queue[0], 'good', { now: tomorrow2 })
  check('no reminder once you have practised that day', practice.reminderText({ now: tomorrow2 }), null)

  // ─── Question bank updates ────────────────────────────────────
  const bundled = practice.bankInfo()
  check('the built-in bank is used until a newer one is fetched', bundled.source, 'bundled')
  const published = (updatedAt, n, extraQ) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ schema: 1, updatedAt, questions: [
      ...Array.from({ length: n }, (_, i) => ({ id: `pub-${i}`, topic: 'Published', category: 'Concept', question: `Published question ${i}?`, answer: '<p>Answer</p>', difficulty: 'easy' })),
      ...(extraQ || []),
    ] }),
  })
  config.practiceBankUpdates = false
  check('updates can be switched off', (await practice.refreshBank({ fetchImpl: async () => published('2099-01-01', 60) })).skipped, 'disabled')
  config.practiceBankUpdates = true
  check('plain http is refused', (await practice.refreshBank({ cfg: { practiceBankUrl: 'http://example.com/q.json' }, fetchImpl: async () => published('2099-01-01', 60) })).success, false)
  check('a bank with too few questions is ignored', (await practice.refreshBank({ force: true, fetchImpl: async () => published('2099-01-01', 5) })).success, false)
  check('a server error is reported, not fatal', (await practice.refreshBank({ force: true, fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) })).error, 'the server answered HTTP 503')
  check('an older published bank is not taken', (await practice.refreshBank({ force: true, fetchImpl: async () => published('2000-01-01', 60) })).updated, false)
  let fetchedUrl = null
  const got = await practice.refreshBank({ force: true, fetchImpl: async (url) => { fetchedUrl = url; return published('2099-01-01', 60) } })
  check('a newer published bank is taken', [got.success, got.updated, got.count], [true, true, 60])
  check('it comes from the public repo by default', fetchedUrl, practice.BANK_URL)
  check('and is used from then on', [practice.bankInfo().source, practice.loadBank().length], ['downloaded', 60])
  check('a recent check is not repeated', (await practice.refreshBank({ fetchImpl: async () => published('2099-01-02', 61) })).skipped, 'recent')
  const evil = [{ id: 'pub-evil', topic: 'Published', question: 'Evil?', answer: '<p onclick="x()">Hi</p><script>alert(1)</script>' }]
  await practice.refreshBank({ force: true, fetchImpl: async () => published('2099-01-03', 60, evil) })
  check('downloaded answers still become safe text for the phone', core.answerBlocks(practice.loadBank().find(q => q.id === 'pub-evil').answer).map(b => b.spans.map(x => x.text).join('')), ['Hi'])
  fs.rmSync(path.join(TMP, 'practice-bank.json'), { force: true })
  practice.resetBank()
  check('without the cached copy the built-in bank is back', practice.bankInfo().source, 'bundled')

  // ─── Importing question files ─────────────────────────────────
  const NL2 = String.fromCharCode(10)
  const TAB = String.fromCharCode(9)
  const csv = ['question,answer,topic,difficulty', '"What is a closure?","A function that remembers, even later, the variables in scope.",JavaScript,easy',
    '"Multi-line?","Line one' + NL2 + '- a bullet",JavaScript,medium', ',no question,JS,', '"What is a closure?","dup",JS,', '"No answer",,JS,'].join(NL2)
  const pc = core.parseImport(csv, { name: 'js.csv' })
  check('CSV with a header row', [pc.format, pc.cards.length], ['csv', 2])
  check('quoted commas survive', pc.cards[0].answer, 'A function that remembers, even later, the variables in scope.')
  check('header columns are mapped', [pc.cards[0].topic, pc.cards[0].difficulty], ['JavaScript', 'easy'])
  check('quoted newlines survive and plain text reads as markdown', [pc.cards[1].format, core.answerBlocks(pc.cards[1].answer, 'markdown').map(b => b.type)], ['markdown', ['p', 'li']])
  check('bad rows are reported with the line they start on (after a two-line row)', pc.skipped.map(x => [x.where, x.reason]), [['line 5', 'no question'], ['line 6', 'duplicate question'], ['line 7', 'no answer']])
  const tsv = core.parseImport(['Event loop' + TAB + 'Runs callbacks when the stack is empty', 'Hoisting' + TAB + 'Declarations move up'].join(NL2), { name: 'quizlet.txt' })
  check('a Quizlet/TSV export without a header', [tsv.format, tsv.cards.map(c => c.question)], ['tsv', ['Event loop', 'Hoisting']])
  const anki = core.parseImport(['#separator:tab', '#html:true', '#tags column:3', 'What is <b>REST</b>?' + TAB + '<div>Resources and verbs</div><div><img src="x.png">Stateless</div>[sound:a.mp3]' + TAB + 'web'].join(NL2))
  check('Anki headers are honoured', anki.format, 'anki')
  check('HTML in the question is reduced to text', anki.cards[0].question, 'What is REST?')
  check('Anki HTML keeps only safe tags', [anki.cards[0].format, anki.cards[0].answer], ['html', '<p>Resources and verbs</p><p>Stateless</p>'])
  // An export with "Include deck name" / "Include notetype name" put the note
  // type in the question and the deck in the answer.
  const ankiCols = core.parseImport(['#separator:tab', '#html:true', '#notetype column:1', '#deck column:2', '#tags column:5', 'Basic' + TAB + 'Interview::Java' + TAB + 'What is the JVM?' + TAB + 'The runtime' + TAB + 'java'].join(NL2))
  check('Anki note type and deck columns are skipped', [ankiCols.cards[0].question, ankiCols.cards[0].answer], ['What is the JVM?', 'The runtime'])
  check('the innermost deck becomes the topic', ankiCols.cards[0].topic, 'Java')
  const ankiGuid = core.parseImport(['#separator:tab', '#html:true', '#guid column:1', 'Ab1:xQ' + TAB + 'What is a closure?' + TAB + 'A function with its scope'].join(NL2))
  check('an Anki guid column is skipped', [ankiGuid.cards[0].question, ankiGuid.cards[0].answer], ['What is a closure?', 'A function with its scope'])
  const json = core.parseImport(JSON.stringify([{ front: 'What is SQL?', back: 'A query language', category: 'concept' }, { q: 'x' }]))
  check('JSON with front/back keys', [json.format, json.cards[0].question, json.cards[0].category, json.skipped.length], ['json', 'What is SQL?', 'Concept', 1])
  check('Hiro bank JSON imports too', core.parseImport(fs.readFileSync(path.join(__dirname, '..', 'electron', 'data', 'questions.json'), 'utf8')).cards.length >= 180, true)
  check('semicolon CSV (European Excel)', core.parseImport('Q1;A1' + NL2 + 'Q2;A2', { name: 'x.csv' }).cards.length, 2)
  check('broken JSON is reported', core.parseImport('[{', { name: 'x.json' }).skipped[0].reason, 'not valid JSON')
  const big = Array.from({ length: core.MAX_IMPORT_CARDS + 5 }, (_, i) => 'Q' + i + ',A').join(NL2)
  check('imports are capped', core.parseImport(big).cards.length, core.MAX_IMPORT_CARDS)

  const pv = practice.previewImport({ name: 'react_basics.csv', text: csv })
  check('the preview counts and samples without saving', [pv.success, pv.count, pv.skippedCount, pv.suggestedTitle, Array.isArray(pv.sample[0].blocks)], [true, 2, 3, 'react basics', true])
  check('an empty file is refused', practice.previewImport({ name: 'x.csv', text: '   ' }).success, false)
  const imp = practice.importDeck({ name: 'react_basics.csv', text: csv, title: 'My React cards' })
  check('importing creates a deck', [imp.success, imp.deck.title, imp.deck.cards, imp.skippedCount], [true, 'My React cards', 2, 3])
  const ankiDeck = practice.importDeck({ name: 'anki.txt', text: ['#html:true', 'What is REST?' + TAB + '<p>Resources <b>and</b> verbs</p>'].join(NL2) })
  const ankiCard = practice.deckCards().find(c => c.deckId === ankiDeck.deck.id)
  check('an imported HTML answer stays HTML and becomes safe blocks', [ankiCard.format, core.answerBlocks(ankiCard.answer, ankiCard.format)[0].spans.map(x => x.text).join('')], ['html', 'Resources and verbs'])
  check('imported decks say where they came from', practice.decks().generated.find(d => d.id === imp.deck.id).source, 'import')
  check('a file with no usable rows is refused', practice.importDeck({ name: 'x.csv', text: 'just one column' }).success, false)

  // ─── Web page to cards ────────────────────────────────────────
  const longText = 'The JavaScript event loop lets a single thread handle asynchronous work. '.repeat(12)
  const pageHtml = '<html><head><title>Event loop explained &amp; more</title></head><body><nav>Home About Login</nav><main><h1>Event loop</h1><p>' + longText + '</p></main><footer>Copyright</footer></body></html>'
  let fetched = null
  const fakeFetch = async (u) => { fetched = u; return { url: u, html: pageHtml } }
  deckReply = JSON.stringify([
    { question: 'What does the event loop do?', answer: 'It runs queued callbacks when the call stack is empty.', category: 'Concept', skill: 'JavaScript', difficulty: 'easy' },
    { question: 'Microtasks or macrotasks first?', answer: 'Microtasks run first.', category: 'Comparison', difficulty: 'medium' },
    { question: 'Why is JavaScript single-threaded?', answer: 'One call stack keeps the DOM safe.', category: 'Concept' },
  ])
  const web = await practice.deckFromUrl({ url: 'https://example.com/event-loop', count: 10 }, { fetchPage: fakeFetch })
  check('a page becomes a deck', [web.success, web.deck && web.deck.cards], [true, 3])
  check('named from the page title', web.deck.title, 'Event loop explained & more')
  const pagePromptText = aiCalls[aiCalls.length - 1].messages[0].content
  check('the page is fenced as untrusted input', pagePromptText.includes('WEB PAGE https://example.com/event-loop') && /untrusted input/i.test(pagePromptText), true)
  check('navigation and footers are left out', [pagePromptText.includes('Home About Login'), pagePromptText.includes('Copyright')], [false, false])
  const webDeck = practice.decks().generated.find(d => d.id === web.deck.id)
  check('the deck remembers its page', [webDeck.source, webDeck.sourceUrl], ['web-page', 'https://example.com/event-loop'])
  check('a page with too little text is refused before any AI call', (await practice.deckFromUrl({ url: 'https://example.com/x' }, { fetchPage: async (u) => ({ url: u, html: '<p>Sign in</p>' }) })).success, false)
  check('a private address is refused by the guarded fetch', /local|private/i.test((await practice.deckFromUrl({ url: 'http://localhost:3000/admin' })).error || ''), true)
  check('only http(s) links', (await practice.deckFromUrl({ url: 'file:///etc/passwd' })).success, false)
  check('the fake fetch saw the address', fetched, 'https://example.com/event-loop')

  // ─── A missed card comes back the same day ────────────────────
  config.practice = { topics: ['Java'], dailyCount: 3 }
  const rd = at('2030-03-04')
  const reviewsSoFar = () => practice.insights({ now: rd, skillsGap: { enoughData: false } }).totals.reviews
  let rt = practice.today({ now: rd, rng: seq() })
  const [m1, m2, m3] = rt.queue
  practice.rate(m1, 'again', { now: rd })
  rt = practice.today({ now: rd })
  check('a missed card goes to the back of the queue', rt.queue, [m2, m3, m1])
  const missed = rt.cards.find(c => c.id === m1)
  check('marked as a second look, its buttons showing the schedule the miss set', [missed.relearn, missed.done, Object.values(missed.intervals)], [true, true, [1, 1, 1, 1]])
  check('and counted', rt.relearnCount, 1)
  check('the phone gets it the same way', [practice.forPhone({ now: rd }).cards.find(c => c.id === m1).relearn, practice.forPhone({ now: rd }).queue], [true, [m2, m3, m1]])
  practice.rate(m2, 'good', { now: rd })
  practice.rate(m3, 'good', { now: rd })
  const missedState = practice.bank({ now: rd }).cards.find(c => c.id === m1).state
  const missAgain = practice.rate(m1, 'again', { now: rd })
  check('missing it again keeps it coming round', [missAgain.relearn, practice.today({ now: rd }).queue], [true, [m1]])
  config.practice = { topics: [], dailyCount: 3 }
  check('changing topics keeps a card still to see again', practice.today({ now: rd, rng: seq() }).queue, [m1])
  const pass = practice.rate(m1, 'good', { now: rd })
  check('any other answer lets it go for today', [pass.relearn, practice.today({ now: rd }).queue], [true, []])
  check('the schedule the first miss set is untouched', practice.bank({ now: rd }).cards.find(c => c.id === m1).state, missedState)
  check('second looks are not counted as reviews', reviewsSoFar(), 3)
  check('a later repeat is ignored', practice.rate(m1, 'again', { now: rd }).duplicate, true)
  check('and does not bring it back', practice.today({ now: rd }).queue, [])

  // ─── Imported text is decoded once ────────────────────────────
  check('an escaped entity in a question stays escaped', core.parseImport('What does &amp;lt;br&amp;gt; mean?,A line break', { name: 'x.csv' }).cards[0].question, 'What does &lt;br&gt; mean?')
  check('ordinary entities are decoded', core.parseImport('Fish &amp; chips &lt;3?,Yes', { name: 'x.csv' }).cards[0].question, 'Fish & chips <3?')

  done()
}

main().catch(err => { console.error(err); process.exit(1) })
