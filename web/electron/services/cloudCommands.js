// Claims remain in the cloud until an explicit outcome is recorded. A crash
// during submission is ambiguous, so it must never trigger automatic resubmit.
const config = require('./config')
const identity = require('./deviceIdentity')
const database = require('./database')

async function update(c, table, userId, id, patch, conditions = {}) {
  let q = c.from(table).update(patch).eq('user_id', userId).eq('id', id)
  for (const [key, value] of Object.entries(conditions)) q = q.eq(key, value)
  const { data, error } = await q.select('*')
  if (error) throw new Error(error.message)
  return data?.[0] || null
}

async function processBatch(c, userId, table, rows, review) {
  const owner = identity.ensureDeviceIdentity(config).deviceId
  for (let row of rows) {
    if (['completed', 'failed'].includes(row.status)) continue
    if (table === 'review_requests' && !database.getApplicationByCloudId(row.application_cloud_id)) continue
    if (!row.status) throw new Error('Update the cloud schema before processing phone commands.')
    if (row.status === 'queued') {
      row = await update(c, table, userId, row.id, { status: 'accepted', claimed_by: owner, error: '', updated_at: new Date().toISOString() }, { status: 'queued' })
      if (!row) continue
    }
    if (row.claimed_by !== owner) continue
    const key = `${userId}:${row.id}`
    const finish = async result => {
      await update(c, table, userId, row.id, { ...result, updated_at: new Date().toISOString() }, { claimed_by: owner })
    }
    if (table === 'scan_requests') {
      const scheduler = require('./scheduler')
      const known = scheduler.cloudCommandStatus(key)
      if (known) { await finish(known); continue }
      if (row.status === 'running') {
        await finish({ status: 'failed', error: 'Desktop restarted during this scan. Review results before retrying.' }); continue
      }
      scheduler.requestScan({ keywords: row.keywords, location: row.location, source: 'cloud', cloudCommandId: key, cloudAccount: `${config.load().supabaseUrl}:${userId}` })
      await finish(scheduler.cloudCommandStatus(key) || { status: 'accepted', error: '' })
      continue
    }
    const receipt = config.load().cloudCommandReceipts?.[key]
    if (receipt) { await finish(receipt); continue }
    if (row.status === 'running') {
      await finish({ status: 'failed', error: 'Submission outcome is uncertain after an interruption. Check the employer site before retrying.' }); continue
    }
    if (!review) continue
    const started = await update(c, table, userId, row.id, { status: 'running', updated_at: new Date().toISOString() }, { claimed_by: owner, status: 'accepted' })
    if (!started) continue
    let result
    try {
      const local = database.getApplicationByCloudId(row.application_cloud_id)
      const outcome = await review({ ...row, application_local_id: local.id })
      result = outcome?.success === false ? { status: 'failed', error: outcome.reason || 'Request declined.' } : { status: 'completed', error: '' }
    } catch (err) {
      if (err.retryable) { await finish({ status: 'accepted', error: err.message }); continue }
      result = { status: 'failed', error: err.message || String(err) }
    }
    // Persist before acknowledgement: a failed network write can be replayed
    // without repeating the external action.
    config.update(cfg => ({ ...cfg, cloudCommandReceipts: { ...cfg.cloudCommandReceipts, [key]: result } }))
    await finish(result)
  }
}

const processing = new Set()
async function processCommands(c, userId, table, rows, review) {
  const scope = `${userId}:${table}`
  if (processing.has(scope)) return
  processing.add(scope)
  try { return await processBatch(c, userId, table, rows, review) }
  finally { processing.delete(scope) }
}
module.exports = { processCommands }
