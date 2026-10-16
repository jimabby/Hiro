const fs = require('fs'), path = require('path'), vm = require('vm')
const { createChecker } = require('./helpers')
const { classifyError, isRetryable, messageFor } = require('../src/requestErrors')
const { check, done } = createChecker()

// An in-memory AsyncStorage with a switch to make reads fail.
const store = new Map()
let failReads = false
const AsyncStorage = {
  getItem: async key => { if (failReads) throw new Error('disk I/O'); return store.has(key) ? store.get(key) : null },
  setItem: async (key, value) => { store.set(key, value) },
  removeItem: async key => { store.delete(key) },
}
const KEY = 'hiro.pendingScans', BACKUP = 'hiro.pendingScans.corrupt'
const sandbox = { AsyncStorage, classifyError, isRetryable, messageFor, console }
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/scanQueue.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replaceAll('export function', 'function')
  .replaceAll('export const', 'var'), sandbox)

const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status })
const deliveredA = [], deliveredB = []
const a = { queueDestination: { key: 'a', label: 'Account A' }, requestScan: async (req, opts) => deliveredA.push({ ...req, key: opts?.idempotencyKey }) }
const b = { queueDestination: { key: 'b', label: 'Account B' }, requestScan: async req => deliveredB.push(req) }
const failing = err => ({ ...a, requestScan: async () => { throw err } })
const pending = async () => sandbox.getPending()

;(async () => {
  await sandbox.enqueue({ keywords: 'Private search A' }, a)
  await sandbox.flush(b)
  check('switching accounts never delivers another account request', deliveredB.length, 0)
  check('other account request stays queued', (await pending()).length, 1)
  await sandbox.enqueue({ keywords: 'B search' }, b)
  await sandbox.flush(b)
  check('matching destination delivered', deliveredB[0].keywords, 'B search')
  const row = (await pending())[0]
  await sandbox.editPending(row.id, { keywords: 'Edited A', location: 'Sydney' })
  await Promise.all([sandbox.flush(a), sandbox.flush(a)])
  check('concurrent flushes deliver once', deliveredA.length, 1)
  check('edited search delivered', { keywords: deliveredA[0].keywords, location: deliveredA[0].location }, { keywords: 'Edited A', location: 'Sydney' })
  check('delivery carries an idempotency key', typeof deliveredA[0].key === 'string' && deliveredA[0].key.length > 0, true)
  await sandbox.enqueue({ keywords: 'Cancelled' }, a)
  await sandbox.cancelPending((await pending())[0].id)
  check('cancel removes request', (await pending()).length, 0)

  store.set(KEY, JSON.stringify([{ id: 'legacy', keywords: 'Unknown owner' }]))
  await sandbox.flush(a)
  check('legacy queue is quarantined', (await pending()).length, 1)
  await sandbox.cancelPending('legacy')

  // ── Idempotency: the key the first attempt used is the key the retry uses.
  await sandbox.enqueue({ keywords: 'Timed out', idempotencyKey: 'first-attempt-key' }, a)
  deliveredA.length = 0
  await sandbox.flush(a)
  check('a queued retry reuses the first attempt’s key', deliveredA[0].key, 'first-attempt-key')

  // ── Error classification decides what stays queued.
  await sandbox.enqueue({ keywords: 'Retry me' }, a)
  let res = await sandbox.flush(failing(Object.assign(new Error('Network request failed'), { network: true })))
  check('unreachable: request stays with explanation', (await pending())[0].lastError, 'Network request failed')
  check('unreachable: flush reports why it stopped', res.stopped, 'Network request failed')
  res = await sandbox.flush(failing(httpError(429, 'Too many failed attempts')))
  check('429 is kept for later, not dropped', (await pending()).length, 1)
  res = await sandbox.flush(failing(Object.assign(httpError(401, 'Unauthorized'), { needsPairing: true })))
  check('401 asks for re-pairing', res.needsPairing, true)
  check('401 keeps the request visible', (await pending()).length, 1)
  await sandbox.flush(a)
  check('retry clears delivered request', (await pending()).length, 0)

  // A permanent refusal at the head of the queue must not block the rest.
  await sandbox.enqueue({ keywords: 'Bad request' }, a)
  await sandbox.enqueue({ keywords: 'Good request' }, a)
  deliveredA.length = 0
  const picky = { ...a, requestScan: async (req, opts) => {
    if (req.keywords === 'Bad request') throw httpError(400, 'Invalid keywords')
    deliveredA.push({ ...req, key: opts.idempotencyKey })
  } }
  res = await sandbox.flush(picky)
  check('400 is dropped with its reason', res.dropped.map(d => [d.label, d.error]), [['Bad request', 'Invalid keywords']])
  check('the request behind it is still delivered', deliveredA.map(d => d.keywords), ['Good request'])
  check('nothing is left blocking the queue', (await pending()).length, 0)

  // A device without the scan permission: told so, and never left queued.
  await sandbox.enqueue({ keywords: 'No scope' }, a)
  res = await sandbox.flush(failing(Object.assign(httpError(403, 'Forbidden'), { scope: 'scan' })))
  check('403 scope error is dropped, not retried', (await pending()).length, 0)
  check('and explained as a missing permission', /“scan” permission/.test(res.dropped[0].error), true)

  // ── Imports share the queue and the destination binding.
  const imported = []
  const importer = { ...a, importJob: async (job, opts) => imported.push({ ...job, key: opts.idempotencyKey }) }
  await sandbox.enqueueImport({ url: 'https://jobs.example/1' }, a)
  await sandbox.enqueueImport({ url: 'https://jobs.example/1' }, a)
  check('the same link shared twice offline is queued once', (await pending()).length, 1)
  await sandbox.flush(b)
  check('an import is never delivered to another destination', (await pending()).length, 1)
  await sandbox.flush(importer)
  check('queued import delivered', imported.map(j => j.url), ['https://jobs.example/1'])
  check('import carries an idempotency key', typeof imported[0].key, 'string')

  // ── Corruption: never treated as an empty queue, never overwritten.
  store.set(KEY, 'corrupt json')
  let err = null
  try { await sandbox.enqueue({ keywords: 'Do not erase' }, a) } catch (e) { err = e }
  check('corruption is reported instead of erasing the queue', !!err?.corrupt && store.get(KEY) === 'corrupt json', true)
  check('the corrupt value is backed up', store.get(BACKUP), 'corrupt json')
  err = null
  try { await sandbox.flush(a) } catch (e) { err = e }
  check('flush refuses a corrupt queue rather than rewriting it', !!err?.corrupt && store.get(KEY) === 'corrupt json', true)
  store.set(KEY, JSON.stringify({ not: 'a list' }))
  err = null
  try { await sandbox.getPending() } catch (e) { err = e }
  check('a non-array is corrupt too', !!err?.corrupt, true)
  await sandbox.resetCorruptQueue()
  check('reset clears the live queue', (await pending()).length, 0)
  check('reset keeps the backup', store.get(BACKUP), JSON.stringify({ not: 'a list' }))

  // A failed READ is not "nothing saved".
  await sandbox.enqueue({ keywords: 'Keep me' }, a)
  failReads = true
  err = null
  try { await sandbox.enqueue({ keywords: 'Second' }, a) } catch (e) { err = e }
  failReads = false
  check('a failed read throws instead of starting an empty queue', !!err?.unreadable, true)
  check('and the queue it could not read is untouched', JSON.parse(store.get(KEY)).map(r => r.keywords), ['Keep me'])

  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
