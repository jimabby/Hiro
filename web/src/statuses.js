// The one description of what an application status is called and how it looks.
//
// This existed twice — Dashboard.jsx and Timeline.jsx each held their own
// STATUS_BADGE literal — and the two had already drifted. `withdrawn` was added
// as a first-class status (it counts as sent, but leaves the response-rate
// denominator) and reached neither map; `held` reached only one. Both pages
// fall back to the raw column value, so those statuses rendered as bare
// lowercase text in a grey badge — the one status added specifically to stop
// misreporting an outcome was the one that looked like a bug.
//
// Every status the database can hold belongs here. A page that wants a subset
// picks it, rather than re-describing the ones it wants.

export const STATUS_BADGE = {
  applied: { label: 'Applied', color: 'badge-blue' },
  interview: { label: 'Interview', color: 'badge-green' },
  offer: { label: 'Offer', color: 'badge-green' },
  rejected: { label: 'Rejected', color: 'badge-red' },
  pending: { label: 'Pending', color: 'badge-yellow' },
  no_response: { label: 'No Response', color: 'badge-gray' },
  skipped: { label: 'Skipped', color: 'badge-gray' },
  // Drafted by review mode but not sent. Amber, because it is waiting on the
  // user rather than finished.
  held: { label: 'Held for review', color: 'badge-yellow' },
  // You pulled out. Grey rather than red: nobody rejected you, and colouring it
  // like a rejection is the same misattribution the status exists to avoid.
  withdrawn: { label: 'Withdrawn', color: 'badge-gray' },
}

// Label and class for any status, including one written by a newer build than
// this renderer. Unknown values keep their raw text rather than disappearing.
export function statusBadge(status) {
  return STATUS_BADGE[status] || { label: status || 'Unknown', color: 'badge-gray' }
}

// The statuses a user may set by hand, in the order every picker shows them.
// 'skipped' and 'held' are deliberately absent — both are assigned by the scan,
// and neither is a claim a person makes about what happened.
export const SETTABLE_STATUSES = [
  'applied', 'interview', 'offer', 'rejected', 'pending', 'no_response', 'withdrawn',
].map(value => ({ value, label: STATUS_BADGE[value].label }))

// The Dashboard's filter tabs, in the order work flows through them. Labels are
// spelled out here rather than taken from STATUS_BADGE because a tab strip has a
// width budget a badge does not — "Held" fits, "Held for review" does not.
export const FILTER_TABS = [
  { value: '', label: 'All' },
  { value: 'applied', label: 'Applied' },
  // Drafted by review mode, not yet sent. Sits directly after Applied so it is
  // obvious these are waiting rather than done.
  { value: 'held', label: 'Held' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'pending', label: 'Pending' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'no_response', label: 'No Response' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'skipped', label: 'Skipped' },
]
