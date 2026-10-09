// The cloud review queue: a phone's approval is put back only when the desktop
// was merely busy. A permanent failure used to be re-queued too, so the same
// doomed approval was retried on every sync, forever.

const { stub, service, createChecker } = require('./helpers')
const os = require('os')
stub({
  './config': { load: () => ({}), update: () => ({}), CONFIG_DIR: os.tmpdir() },
  './logger': { append: () => {} },
  './database': {},
})
const cloudSync = service('cloudSync')
const { check, done } = createChecker()

function fakeClient(queue) {
  const requeued = []
  const chain = (result) => {
    const q = { eq: () => q, in: () => q, order: () => q, select: () => q, then: (ok, bad) => Promise.resolve(result()).then(ok, bad) }
    return q
  }
  return {
    requeued,
    from: () => ({
      select: () => chain(() => ({ data: [...queue], error: null })),
      delete: () => chain(() => { const taken = queue.splice(0); return { data: taken, error: null } }),
      upsert: async (row) => { requeued.push(row); return { error: null } },
    }),
  }
}

;(async () => {
  const user = { id: 'u1' }
  const seen = []

  const permanent = fakeClient([{ id: 1, application_local_id: 7, action: 'approve' }])
  await cloudSync._pollReviewRequests(permanent, user, async (r) => { seen.push(r.application_local_id); throw new Error('Career-board drafts are submitted from the desktop') })
  check('the request was attempted', seen, [7])
  check('a permanent failure is not put back', permanent.requeued.length, 0)

  const busy = fakeClient([{ id: 2, application_local_id: 8, action: 'approve' }])
  await cloudSync._pollReviewRequests(busy, user, async () => { const e = new Error('A scan is currently running'); e.retryable = true; throw e })
  check('a busy desktop puts it back for the next sync', busy.requeued.map(r => r.application_local_id), [8])

  const fine = fakeClient([{ id: 3, application_local_id: 9, action: 'reject' }])
  await cloudSync._pollReviewRequests(fine, user, async () => ({ success: true }))
  check('a processed request is gone', fine.requeued.length, 0)
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
