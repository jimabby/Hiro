// Phone → desktop commands over the cloud (review_requests, scan_requests).
// Kept free of react-native and expo imports so the protocol can be tested in
// plain Node (app/test/cloud-commands.test.js); supabase.js passes in its client
// and a uuid generator.
//
// The row's status is the contract with the desktop (web/electron/services/
// cloudCommands.js): queued → accepted (claimed) → running → completed/failed.
// The desktop moves a row forward only with an update conditional on its id and
// current status, so the phone can safely change a row the desktop has not yet
// started by doing the same: a conditional update that either wins outright or
// matches nothing. Changing a decision also gives the row a new id, so a desktop
// holding the old row from an earlier poll can never claim or start it.

export const ACTIVE = ['queued', 'accepted', 'running']

// Review decisions the desktop has not started can still be changed or
// cancelled. 'accepted' qualifies for reviews because the desktop's start is
// conditional on status 'accepted' and the row id; it waits there while the
// desktop is busy, which is exactly when changing your mind is useful.
const REVIEW_CHANGEABLE = ['queued', 'accepted']
// A claimed scan is already in the desktop's local queue, which no cloud write
// can reach, so only a scan the desktop has not claimed can be cancelled.
const SCAN_CANCELLABLE = ['queued']

const LABEL = { approve: 'approval', reject: 'rejection' }

function tooLate(row) {
  const err = new Error(row.status === 'running'
    ? `Too late to change — the desktop is already processing the ${LABEL[row.action] || 'decision'}.`
    : `Too late to change — the desktop has already ${row.status === 'cancelled' ? 'dropped' : 'finished'} this command.`)
  err.tooLate = true
  return err
}

function schemaError(error) {
  return new Error(/review_requests/.test(error.message)
    ? 'Remote review needs the review_requests table — re-run supabase/schema.sql.' : error.message)
}

// The one decision for this application the desktop may still act on, if any.
// Finished commands are kept as history and never block a new decision.
export async function activeReview(db, userId, applicationId) {
  const { data, error } = await db.from('review_requests').select('id, action, status')
    .eq('user_id', userId).eq('application_cloud_id', applicationId).in('status', ACTIVE)
    .order('created_at', { ascending: false }).limit(1)
  if (error) throw schemaError(error)
  return data?.[0] || null
}

// Queue a decision, or change the one already queued. Resolves with
// { success, queued, action, replaced? }; rejects with err.tooLate when the
// desktop has started a different decision, so the caller can say so instead
// of claiming the new choice was queued.
export async function requestReviewAction(db, userId, applicationId, action, newId) {
  if (!['approve', 'reject'].includes(action)) throw new Error('Invalid review action.')
  // Each pass either finishes or saw the row move under it (the desktop claimed
  // it, or another tap inserted first); a few passes settle any such race.
  let conflicted = false
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await activeReview(db, userId, applicationId)
    if (!existing) {
      const { error } = await db.from('review_requests').insert({ user_id: userId, application_cloud_id: applicationId, action })
      if (!error) return { success: true, queued: true, action }
      if (error.code === '23505') { conflicted = true; continue }
      throw schemaError(error)
    }
    if (existing.action === action) return { success: true, queued: true, action }
    if (!REVIEW_CHANGEABLE.includes(existing.status)) throw tooLate(existing)
    const { data, error } = await db.from('review_requests')
      .update({ id: newId(), action, status: 'queued', claimed_by: null, error: '', updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('id', existing.id).eq('status', existing.status).select('id')
    if (error) throw schemaError(error)
    if (data?.length) return { success: true, queued: true, action, replaced: existing.action }
  }
  // An insert that conflicts with no active row means the project still has
  // the old one-row-per-application index, where a finished command blocks
  // every later decision.
  throw new Error(conflicted
    ? 'A finished command is blocking a new decision — re-run supabase/schema.sql to update your cloud project.'
    : 'The command changed while saving. Refresh and try again.')
}

// Cancel a command the desktop has not started. Rejects with err.tooLate (and
// the real state in the message) when it has.
export async function cancelCommand(db, userId, kind, id) {
  const table = kind === 'scan' ? 'scan_requests' : kind === 'review' ? 'review_requests' : null
  if (!table) throw new Error('Invalid command kind.')
  const allowed = kind === 'scan' ? SCAN_CANCELLABLE : REVIEW_CHANGEABLE
  // claimed_by is cleared too: the desktop acknowledges only rows it still
  // holds a claim on, so nothing it writes afterwards can overwrite the cancel.
  const { data, error } = await db.from(table)
    .update({ status: 'cancelled', claimed_by: null, error: 'Cancelled from the phone.', updated_at: new Date().toISOString() })
    .eq('user_id', userId).eq('id', id).in('status', allowed).select('id')
  if (error) throw new Error(error.message)
  if (data?.length) return { success: true }
  const { data: rows, error: readError } = await db.from(table).select('id, status, action').eq('user_id', userId).eq('id', id).limit(1)
  if (readError) throw new Error(readError.message)
  const row = rows?.[0]
  if (!row) throw new Error('That command no longer exists. Refresh command history.')
  if (row.status === 'cancelled') return { success: true }
  if (kind === 'scan' && row.status === 'accepted') {
    const err = new Error('Too late to cancel — the desktop has already queued this scan. Stop it from the desktop.')
    err.tooLate = true
    throw err
  }
  throw tooLate(row)
}

// Approve several drafts, one command each. A failure on one id no longer
// abandons the rest: every id is attempted and reported, so the screen can say
// how many were queued and which were not.
export async function approveDrafts(requestOne, ids, describe = () => '') {
  const accepted = [], refused = []
  for (const id of ids) {
    try {
      await requestOne(id, 'approve')
      accepted.push(id)
    } catch (err) {
      const name = describe(id)
      refused.push({ id, reason: name ? `${name}: ${err.message}` : err.message })
    }
  }
  return { started: accepted.length > 0, queued: true, accepted, refused }
}
