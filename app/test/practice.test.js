// Pure helpers behind the Practice tab.
const { createChecker } = require('./helpers')
const { formatInterval, statsLine, currentCard } = require('../src/practice')
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

done()
