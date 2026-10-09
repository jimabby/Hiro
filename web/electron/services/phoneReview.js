// Approving held drafts from the phone — which ones may be, and running them.
//
// Approving a draft submits it to an employer. The desktop does the submitting
// either way; the phone only asks. What the phone cannot do is show the
// evidence a careful approval needs, so the drafts it may approve are limited
// to the ones where there is nothing to weigh:
//
//   - still 'held' (a second tap, or one from another device, finds it gone);
//   - not a company career board — those cannot be auto-submitted at all, and
//     an approval that can never succeed used to sit in the cloud queue being
//     retried every sync, forever;
//   - not flagged by the fabrication guard or the listing-injection check. A
//     flagged draft is one where Hiro found something it could not vouch for,
//     and the side-by-side diff that lets a person judge it is on the desktop.
//
// Both routes — the local-network API and the cloud review queue — go through
// canApprove(), so the two cannot drift apart.

const database = require('./database')

const MAX_BATCH = 10
const PHONE_PLATFORMS = new Set(['ios', 'android'])

function flagsOf(row) {
  try {
    const flags = JSON.parse(row?.fabrication_flags || '[]')
    return Array.isArray(flags) ? flags : []
  } catch {
    return []
  }
}

// { ok } or { ok: false, reason, permanent } — permanent means retrying the
// same request can never succeed, so a queued request should be dropped.
function canApprove(row) {
  if (!row) return { ok: false, reason: 'That draft no longer exists.', permanent: true }
  if (row.status !== 'held') return { ok: false, reason: `Already ${row.status}.`, permanent: true }
  if (row.platform === 'ATS') return { ok: false, reason: 'Career-board drafts are submitted from the desktop with Fill Application.', permanent: true }
  if (flagsOf(row).length > 0) return { ok: false, reason: 'Hiro flagged something in this draft — review it on the desktop.', permanent: true }
  return { ok: true }
}

// Which device may approve. Phones only: the browser extension pairs as a
// device too, and importing a job is all it is for.
function deviceMayApprove(device) {
  return !!device && PHONE_PLATFORMS.has(String(device.platform || '').toLowerCase())
}

// Sort requested ids into those that will be submitted and those that will
// not, with the reason for each refusal.
function partition(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))]
  const accepted = []
  const refused = []
  for (const id of unique) {
    if (accepted.length >= MAX_BATCH) { refused.push({ id, reason: `At most ${MAX_BATCH} at a time.` }); continue }
    const verdict = canApprove(database.getApplication(id))
    if (verdict.ok) accepted.push(id)
    else refused.push({ id, reason: verdict.reason })
  }
  return { accepted, refused }
}

module.exports = { canApprove, deviceMayApprove, partition, flagsOf, MAX_BATCH }
