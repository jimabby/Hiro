const { stub, service, createChecker } = require('./helpers')
const os = require('os')
let cfg = { deviceId: 'desktop', deviceName: 'Test' }
stub({
  './config': { load: () => cfg, update: patch => { cfg = typeof patch === 'function' ? patch(cfg) : { ...cfg, ...patch }; return cfg }, CONFIG_DIR: os.tmpdir() },
  './logger': { append() {} },
  './database': { getApplicationByCloudId: () => ({ id: 7 }) },
})
const { processCommands } = service('cloudCommands')
const outcomes = service('commandOutcomes')
const { check, done } = createChecker()
function fakeClient(row) {
  return { from: () => ({ update: patch => {
    const filters = []
    const q = { eq: (k, v) => { filters.push([k, v]); return q }, select: async () => {
      if (!filters.every(([k, v]) => row[k] === v)) return { data: [], error: null }
      Object.assign(row, patch); return { data: [{ ...row }], error: null }
    } }; return q
  } }) }
}
;(async () => {
  const make = id => ({ id, user_id: 'u', application_cloud_id: 'job', action: 'approve', status: 'queued' })
  let row = make('permanent'), calls = 0
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { calls++; throw new Error('Rejected') })
  check('permanent failure retained', row.status, 'failed')
  check('failure explanation retained', row.error, 'Rejected')
  row = make('busy')
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { const e = new Error('Busy'); e.retryable = true; throw e })
  check('busy remains durably accepted', row.status, 'accepted')
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { calls++; return { success: true } })
  check('accepted command eventually completes', row.status, 'completed')
  row.status = 'running'
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { calls++ })
  check('receipt replays acknowledgement without resubmitting', calls, 2)
  check('receipt restores completed status', row.status, 'completed')
  row = { ...make('interrupted'), status: 'running', claimed_by: 'desktop' }
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { calls++ })
  check('uncertain submission requires manual review', row.status, 'failed')
  check('uncertain submission never auto-retries', calls, 2)
  row = make('race')
  const c = fakeClient(row)
  await Promise.all([processCommands(c, 'u', 'review_requests', [{ ...row }], async () => { calls++ }), processCommands(c, 'u', 'review_requests', [{ ...row }], async () => { calls++ })])
  check('competing claims submit once', calls, 3)
  row = make('declined')
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => ({ success: false, reason: 'Flagged draft' }))
  check('returned refusal is a failure', row.status, 'failed')

  // ── Cancelled or replaced from the phone: never run ──
  row = { ...make('cancelled'), status: 'cancelled', claimed_by: 'desktop' }
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { calls++ })
  check('a cancelled command is never run', [calls, row.status], [3, 'cancelled'])
  // The desktop read the approval, then the phone swapped it for a rejection,
  // which gives the row a new id. The claim is by the id the desktop read.
  row = { ...make('swapped-new'), action: 'reject' }
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...make('swapped-old') }], async () => { calls++ })
  check('a replaced command cannot be claimed', [calls, row.status], [3, 'queued'])
  // Cancelled after the claim but before the start: the start is conditional
  // on 'accepted', so it misses.
  row = make('late-cancel')
  const lateClient = fakeClient(row)
  const realFrom = lateClient.from
  let updates = 0
  lateClient.from = t => { if (++updates === 2) Object.assign(row, { status: 'cancelled', claimed_by: null }); return realFrom(t) }
  await processCommands(lateClient, 'u', 'review_requests', [{ ...row }], async () => { calls++ })
  check('a cancel that lands after the claim still stops the submission', [calls, row.status], [3, 'cancelled'])

  // ── Receipts are bounded, and local bookkeeping never reaches the cloud ──
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()
  cfg.cloudCommandReceipts = { 'u:ancient': { status: 'completed', error: '', at: old } }
  for (let i = 0; i < 250; i++) cfg.cloudCommandReceipts[`u:r${i}`] = { status: 'completed', error: '', at: new Date(Date.now() - i * 1000).toISOString() }
  row = make('fresh')
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => ({ success: true }))
  const receipts = cfg.cloudCommandReceipts
  check('receipts are capped', Object.keys(receipts).length, outcomes.MAX_TERMINAL)
  check('the newest receipt is kept', receipts['u:fresh']?.status, 'completed')
  check('receipts past the age limit are dropped', 'u:ancient' in receipts, false)
  check('the oldest beyond the cap are dropped', 'u:r249' in receipts, false)
  row.status = 'running'
  await processCommands(fakeClient(row), 'u', 'review_requests', [{ ...row }], async () => { calls++ })
  check('the receipt timestamp is not written to the cloud row', 'at' in row, false)

  const pruned = outcomes.prune({ a: { status: 'running', at: old }, b: { status: 'accepted' }, c: { status: 'failed', at: old }, d: { status: 'cancelled', at: 'garbage' } })
  check('in-flight outcomes are never pruned, however old', Object.keys(pruned).sort(), ['a', 'b'])
  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
