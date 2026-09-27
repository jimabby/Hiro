// The list's sort orders and the tab badge counts.

const { createChecker, at, app } = require('./helpers')
const { sortApplications, heldCount, urgentOffers, deriveBadges, badgeText } = require('../src/listing')

const { check, done } = createChecker()

const ids = (rows) => rows.map(r => r.id)

const old = app({ id: 1, applied_at: at(5), match_score: 90, company: 'zeta', next_action_at: null })
const mid = app({ id: 2, applied_at: at(2), match_score: null, company: 'Alpha', next_action_at: '2026-08-10' })
const fresh = app({ id: 3, applied_at: at(0), match_score: 70, company: 'beta', next_action_at: '2026-08-07' })
const list = [old, mid, fresh]

check('newest first', ids(sortApplications(list, 'newest')), [3, 2, 1])
check('best match first, unscored last', ids(sortApplications(list, 'match')), [1, 3, 2])
check('soonest follow-up first, none last', ids(sortApplications(list, 'followup')), [3, 2, 1])
check('company ignores case', ids(sortApplications(list, 'company')), [2, 3, 1])
check('an unknown sort falls back to newest', ids(sortApplications(list, 'nope')), [3, 2, 1])
check('the input is not sorted in place', ids(list), [1, 2, 3])
check('null input is an empty list', sortApplications(null), [])

// The LAN API sends SQLite UTC timestamps, the cloud ISO ones; a mixed list
// must still order by the instant, not by the string.
const lan = app({ id: 10, applied_at: '2026-08-06 10:00:00' })
const cloud = app({ id: 11, applied_at: '2026-08-06T09:00:00Z' })
check('SQLite and ISO timestamps compare as instants', ids(sortApplications([cloud, lan], 'newest')), [10, 11])

// Ties break by recency so the order is stable across refreshes.
const tieA = app({ id: 20, applied_at: at(3), match_score: 80 })
const tieB = app({ id: 21, applied_at: at(1), match_score: 80 })
check('equal scores fall back to newest', ids(sortApplications([tieA, tieB], 'match')), [21, 20])

// ── Badges ───────────────────────────────────────────────────────
check('LAN stats carry heldCount', heldCount({ heldCount: 4, byStatus: [] }), 4)
check('cloud stats use the held bucket', heldCount({ byStatus: [{ status: 'held', count: 2 }] }), 2)
check('no held bucket is zero', heldCount({ byStatus: [{ status: 'applied', count: 9 }] }), 0)
check('no stats is zero', heldCount(null), 0)

const board = {
  offers: [
    { decision: 'considering', daysToRespond: 0 },
    { decision: 'considering', daysToRespond: 3 },
    { decision: 'considering', daysToRespond: 4 },
    { decision: 'considering', daysToRespond: -1 },
    { decision: 'considering', daysToRespond: null },
    { decision: 'accepted', daysToRespond: 1 },
  ],
}
check('urgent offers are live and due within three days', urgentOffers(board), 2)
check('no board has no urgent offers', urgentOffers(null), 0)

check('badges combine the three sources',
  deriveBadges({ stats: { heldCount: 1 }, due: [{}, {}], offers: board }),
  { dashboard: 2, applications: 1, offers: 2 })
check('badges survive missing sources', deriveBadges({}), { dashboard: 0, applications: 0, offers: 0 })

check('zero shows no badge', badgeText(0), '')
check('a count shows as-is', badgeText(7), '7')
check('large counts cap', badgeText(250), '99+')

done()
