// Sorting the applications list, and the counts behind the tab badges.
//
// CommonJS and free of any react-native import for the same reason as dates.js
// and stats.js: so the plain-Node suite in test/ can pin them.

const { parseInstant } = require('./dates')

// The orders offered on the phone, in the order the picker shows them. Sorted
// here rather than on the server: the LAN API and the cloud client both return
// the whole list already, and the cloud client has no server-side sort to ask.
const SORTS = [
  { id: 'newest', label: 'Newest' },
  { id: 'match', label: 'Best match' },
  { id: 'followup', label: 'Next follow-up' },
  { id: 'company', label: 'Company A–Z' },
]

const time = (a) => parseInstant(a.applied_at || a.updated_at)?.getTime() ?? 0

// Rows without the thing being sorted on go last, whichever way the sort runs —
// an unscored job is not "the worst match", and an application with no
// follow-up is not "due first".
function lastIfMissing(av, bv, compare) {
  const am = av == null || av === ''
  const bm = bv == null || bv === ''
  if (am && bm) return 0
  if (am) return 1
  if (bm) return -1
  return compare(av, bv)
}

const COMPARATORS = {
  newest: (a, b) => time(b) - time(a),
  match: (a, b) => lastIfMissing(a.match_score, b.match_score, (x, y) => y - x) || time(b) - time(a),
  followup: (a, b) => lastIfMissing(
    a.next_action_at && String(a.next_action_at).slice(0, 10),
    b.next_action_at && String(b.next_action_at).slice(0, 10),
    (x, y) => x.localeCompare(y),
  ) || time(b) - time(a),
  company: (a, b) => lastIfMissing(a.company, b.company,
    (x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' })) || time(b) - time(a),
}

// Returns a new array; never sorts the caller's list in place, since that list
// is React state.
function sortApplications(apps, sortId = 'newest') {
  const compare = COMPARATORS[sortId] || COMPARATORS.newest
  return [...(apps || [])].sort(compare)
}

// ── Tab badges ───────────────────────────────────────────────────────────

// Drafts waiting for a decision. The desktop's LAN stats carry heldCount; the
// cloud client derives stats from rows, where it is the 'held' bucket.
function heldCount(stats) {
  if (!stats) return 0
  if (Number.isFinite(stats.heldCount)) return stats.heldCount
  return (stats.byStatus || []).find(s => s.status === 'held')?.count || 0
}

// An offer is urgent from three days out — the same threshold at which the
// Offers screen turns its deadline red.
const URGENT_DAYS = 3

function urgentOffers(board) {
  return (board?.offers || []).filter(o =>
    o.decision === 'considering'
    && o.daysToRespond != null
    && o.daysToRespond >= 0
    && o.daysToRespond <= URGENT_DAYS).length
}

function deriveBadges({ stats, due, offers } = {}) {
  return {
    dashboard: (due || []).length,
    applications: heldCount(stats),
    offers: urgentOffers(offers),
  }
}

// What a badge shows. Anything past 99 is noise at badge size.
function badgeText(n) {
  if (!n) return ''
  return n > 99 ? '99+' : String(n)
}

module.exports = { SORTS, sortApplications, heldCount, urgentOffers, deriveBadges, badgeText, URGENT_DAYS }
