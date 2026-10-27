// Which statuses a phone may set on an application, whichever way the change
// arrives — the LAN API (mobileApi) or a cloud edit pulled by cloudSync. One
// rule for both, because a gap in either path is the same gap: the cloud path
// used to apply anything, so a client could move a sent application back to
// 'held', and approving it again submitted it a second time.

// Must cover every status the desktop can write, or the phone can see a status
// it isn't allowed to set back. 'pending' comes from the inbox classifier and
// 'no_response' from the stale sweep; both were missing here.
const VALID_STATUSES = ['applied', 'interview', 'rejected', 'offer', 'pending', 'no_response', 'skipped', 'held', 'withdrawn']

// Statuses the phone can show but never set. Both are states the desktop
// reaches by its own decision, and both are a loaded gun: approving a 'held'
// row submits it, and "apply anyway" on a 'skipped' one tailors and submits it.
// Moving an application that was already sent into either would re-arm a
// submission to an employer who has the application already.
const DESKTOP_ONLY_STATUSES = new Set(['held', 'skipped'])

// Why a phone may not set `status`, or null when it may.
function remoteStatusRefusal(status) {
  if (!VALID_STATUSES.includes(status)) return `status must be one of: ${VALID_STATUSES.join(', ')}`
  if (DESKTOP_ONLY_STATUSES.has(status)) return `'${status}' is set by the desktop only.`
  return null
}

module.exports = { VALID_STATUSES, DESKTOP_ONLY_STATUSES, remoteStatusRefusal }
