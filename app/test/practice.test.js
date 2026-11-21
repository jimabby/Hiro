// Pure helpers behind the Practice tab.
const { createChecker } = require('./helpers')
const { formatInterval, statsLine, currentCard, applyPendingPractice } = require('../src/practice')
const { check, done } = createChecker()

check('days', formatInterval(6), '6d')
check('months', formatInterval(45), '2mo')
check('a year', formatInterval(365), '1y')
check('nonsense reads as a day', formatInterval(undefined), '1d')

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

done()
