// Pure helpers behind the Practice tab.
const { createChecker } = require('./helpers')
const { formatInterval, ratingWhen, statsLine, currentCard, applyPendingPractice, positionLabel, localDay, currentCountdown, isStale, speechText, widgetSummary, widgetView, isPracticeLink } = require('../src/practice')
const { check, done } = createChecker()

check('days', formatInterval(6), '6d')
check('months', formatInterval(45), '2mo')
check('a year', formatInterval(365), '1y')
check('nonsense reads as a day', formatInterval(undefined), '1d')
check('Again comes back today, the rest when scheduled', ['again', 'hard', 'easy'].map(k => ratingWhen(k, { again: 1, hard: 3, good: 6, easy: 8 })), ['today', '3d', '8d'])

check('no stats, no line', statsLine(null), '')
check('week, streak and due', statsLine({ daysThisWeek: 3, weeklyGoalDays: 4, streak: 5, due: 2 }), '3 of 4 days this week · 5-day streak · 2 due')
check('no streak is left out', statsLine({ daysThisWeek: 0, weeklyGoalDays: 4, streak: 0, due: 0 }), '0 of 4 days this week')

const data = { cards: [{ id: 'a', done: true }, { id: 'b' }, { id: 'c' }], queue: ['b', 'c'] }
check('the first card still queued', currentCard(data).id, 'b')
check('done for the day', currentCard({ cards: data.cards, queue: [] }), null)
check('nothing loaded yet', currentCard(null), null)

// ── Practice through the cloud ──
const snap = { day: '2026-11-21', cards: [{ id: 'a' }, { id: 'b', note: '' }, { id: 'c' }], queue: ['a', 'b', 'c'], doneCount: 0, available: 5 }
const over = applyPendingPractice(snap, [
  { type: 'rate', cardId: 'a', rating: 'good' },
  { type: 'note', cardId: 'b', note: '  my example  ' },
  { type: 'flag', cardId: 'c', reason: 'wrong' },
  { type: 'rate', cardId: 'gone', rating: 'good' },
])
check('a card answered on the phone leaves the queue before the desktop applies it', over.queue, ['b'])
check('and counts as done', [over.cards[0].done, over.doneCount], [true, 1])
check('a note shows straight away', over.cards[1].note, 'my example')
check('a reported card leaves the queue', over.cards[2].flagged, true)
check('pending changes are counted; unknown cards ignored', over.pendingChanges, 3)
check('it is marked as coming through the cloud, with nothing more to add', [over.cloud, over.available], [true, 0])
check('the snapshot itself is not changed', [snap.queue.length, snap.cards[0].done], [3, undefined])
check('rating the same card twice counts it once', applyPendingPractice(snap, [{ type: 'rate', cardId: 'a' }, { type: 'rate', cardId: 'a' }]).doneCount, 1)

// ── A missed card comes back, as on the desktop ──
const miss = applyPendingPractice(snap, [{ type: 'rate', cardId: 'a', rating: 'again' }])
check('a card missed away from home goes to the back of the queue', miss.queue, ['b', 'c', 'a'])
check('as a second look whose buttons show the schedule the miss set', [miss.cards[0].relearn, miss.cards[0].done, miss.cards[0].intervals], [true, true, { again: 1, hard: 1, good: 1, easy: 1 }])
check('and is counted', [miss.relearnCount, miss.doneCount], [1, 1])
const missTwice = applyPendingPractice(snap, [{ type: 'rate', cardId: 'a', rating: 'again' }, { type: 'rate', cardId: 'a', rating: 'again' }])
check('missing it on the second look sends it round again', [missTwice.queue, missTwice.doneCount], [['b', 'c', 'a'], 1])
const passed = applyPendingPractice(snap, [{ type: 'rate', cardId: 'a', rating: 'again' }, { type: 'rate', cardId: 'a', rating: 'good' }, { type: 'rate', cardId: 'a', rating: 'again' }])
check('a pass lets it go, and a later repeat does not bring it back', [passed.queue, passed.relearnCount], [['b', 'c'], 0])
const fromDesktop = applyPendingPractice({ ...snap, cards: [{ id: 'a', done: true, relearn: true }, { id: 'b' }], queue: ['b', 'a'] }, [{ type: 'rate', cardId: 'a', rating: 'easy' }])
check('a second look the desktop queued is finished on the phone', fromDesktop.queue, ['b'])

check('position on a first look', positionLabel({ doneCount: 2, cards: [1, 2, 3, 4] }, { id: 'x' }), '3 of 4')
check('a second look is not one more card', positionLabel({ doneCount: 4, relearnCount: 2, cards: [1, 2, 3, 4] }, { id: 'x', relearn: true }), 'Once more · 2 to go')

// ── Through the cloud, the phone's own today ──
check('a calendar day', localDay(new Date(2026, 0, 5, 23, 30)), '2026-01-05')
const cd = [
  { applicationId: 1, scheduledAt: '2026-11-23 09:00:00', daysLeft: 3 },
  { applicationId: 2, scheduledAt: '2026-11-21 14:00:00', daysLeft: 1 },
  { applicationId: 3, daysLeft: 4 },
]
check('days left counted from the phone\'s today, past interviews dropped', currentCountdown(cd, '2026-11-22').map(c => [c.applicationId, c.daysLeft]), [[1, 1], [3, 4]])
check('cards from an earlier day are stale through the cloud', [isStale({ cloud: true, day: '2026-11-21' }, '2026-11-22'), isStale({ cloud: true, day: '2026-11-22' }, '2026-11-22')], [true, false])
check('over the LAN they are always current', isStale({ day: '2026-11-21' }, '2026-11-22'), false)

// ─── Read aloud ──────────────────────────────────────────────────
const spoken = speechText([
  { type: 'p', spans: [{ text: 'A ' }, { text: 'closure', bold: true }, { text: ' keeps its scope' }] },
  { type: 'li', marker: '•', spans: [{ text: 'Used for callbacks.' }] },
  { type: 'pre', spans: [{ text: 'const f = () => x', code: true }] },
  { type: 'p', spans: [{ text: '   ' }] },
])
check('answers are read as sentences, code is announced not spelled out', spoken, 'A closure keeps its scope. Used for callbacks. Code example on screen.')
check('no blocks, nothing to say', speechText(undefined), '')

// ─── Home-screen widget ──────────────────────────────────────────
const dayData = { day: '2026-11-24', cards: [{}, {}, {}, {}, {}], queue: ['a', 'b'], doneCount: 3, stats: { streak: 5, practisedToday: true, daysThisWeek: 2, weeklyGoalDays: 4, due: 6 } }
const summary = widgetSummary(dayData, new Date('2026-11-24T08:00:00'))
check('the widget keeps counts only', Object.keys(summary).sort(), ['day', 'daysThisWeek', 'done', 'due', 'left', 'practisedToday', 'savedAt', 'streak', 'total', 'weeklyGoalDays'])
check('cards left are the queue', [summary.left, summary.done, summary.total], [2, 3, 5])
check('today: cards left, streak and week', widgetView(summary, '2026-11-24'), { headline: '2 cards left today', detail: '5-day streak · 2 of 4 days this week', stale: false })
check('today, all done', widgetView({ ...summary, left: 0 }, '2026-11-24').headline, 'Done for today ✓')
check('one card is singular', widgetView({ ...summary, left: 1 }, '2026-11-24').headline, '1 card left today')
check('the next morning the streak is still there to keep', widgetView(summary, '2026-11-25'), { headline: 'New cards today', detail: 'Keep your 5-day streak · 2 of 4 days this week', stale: true })
check('a day missed: the streak has gone', widgetView(summary, '2026-11-26').detail, '2 of 4 days this week')
check('a new week starts at zero', widgetView({ ...summary, day: '2026-11-29' }, '2026-11-30').detail, 'Keep your 5-day streak · 0 of 4 days this week')
check('yesterday unpractised: no streak to keep', widgetView({ ...summary, practisedToday: false }, '2026-11-25').detail, '2 of 4 days this week')
check('nothing saved yet', widgetView(null).headline, 'Daily interview practice')
check('no day data, no summary', widgetSummary(null), null)
check('the widget link opens Practice', [isPracticeLink('hiro://practice'), isPracticeLink('hiro:/practice'), isPracticeLink('hiro://import?url=x'), isPracticeLink('https://practice'), isPracticeLink(null)], [true, true, false, false, false])

done()
