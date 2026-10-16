const { stub, service, createChecker } = require('./helpers')
const os = require('os')
let cfg = { deviceId: 'desktop', deviceName: 'Test' }
stub({
  './config': { load: () => cfg, update: patch => { cfg = typeof patch === 'function' ? patch(cfg) : { ...cfg, ...patch }; return cfg }, CONFIG_DIR: os.tmpdir() },
  './logger': { append() {} },
  './database': { getApplicationByCloudId: () => ({ id: 7 }) },
})
const { processCommands } = service('cloudCommands')
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
  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
