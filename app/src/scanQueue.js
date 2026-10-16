// Requests held on the phone until their destination can take them: scans, and
// job links shared into Hiro.
//
// A request belongs to its original account/paired desktop. Legacy entries have
// no trustworthy destination, so retain them for inspection/cancellation only.
//
// Only requests that could not REACH the destination are held. A refusal — a
// revoked token, a malformed request — gets the same answer however often it
// is retried, so it is reported, not queued (see src/requestErrors.js). Each
// request carries an idempotency key from the moment it is first sent, so a
// retry after a timeout that DID reach the desktop is recognised as a retry.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { classifyError, isRetryable, messageFor } from './requestErrors'

const KEY = 'hiro.pendingScans'
// Where an unreadable queue is copied before anything else can touch the key.
const BACKUP_KEY = 'hiro.pendingScans.corrupt'

let chain = Promise.resolve()
function serialized(op) {
  const run = chain.then(op, op)
  chain = run.then(() => {}, () => {})
  return run
}

function queueError(message, props) {
  return Object.assign(new Error(message), props)
}

// "Nothing saved" and "could not read what is saved" are different answers.
// Treating both as an empty queue meant the next write replaced a queue that
// merely failed to parse — or failed to load at all — with an empty one. So a
// failed read throws, and an unparseable value is copied aside first and then
// left exactly where it was until the user chooses to reset it.
async function readPending() {
  let raw
  try {
    raw = await AsyncStorage.getItem(KEY)
  } catch (err) {
    throw queueError(`The saved request queue could not be read (${err?.message || 'storage error'}). It has not been changed.`, { unreadable: true })
  }
  if (raw == null || raw === '') return []
  let rows
  try { rows = JSON.parse(raw) } catch { rows = null }
  if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object')) {
    try {
      if ((await AsyncStorage.getItem(BACKUP_KEY)) !== raw) await AsyncStorage.setItem(BACKUP_KEY, raw)
    } catch { /* the original is still in place; the backup is a second copy */ }
    throw queueError('The saved request queue is unreadable. It has not been changed — a copy was kept, and you can reset the queue to start again.', { corrupt: true })
  }
  return rows
}

async function writePending(rows) { await AsyncStorage.setItem(KEY, JSON.stringify(rows)) }

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export function getPending() { return serialized(readPending) }

// Rows saved before kinds existed are scans.
export const kindOf = row => row?.kind || 'scan'

export function enqueue(req, client) {
  return serialized(async () => {
    if (!client?.queueDestination?.key) throw new Error('Connect to a destination before queuing a scan.')
    const rows = await readPending()
    const id = newId()
    rows.push({
      id, kind: 'scan',
      // The key the first attempt was sent with, so the retry matches it.
      idempotencyKey: req.idempotencyKey || id,
      keywords: String(req.keywords || '').slice(0, 500), location: String(req.location || '').slice(0, 160),
      createdAt: new Date().toISOString(), destination: { ...client.queueDestination }, lastError: '',
    })
    await writePending(rows)
  })
}

// A job link shared into Hiro while the desktop was out of reach.
export function enqueueImport(job, client) {
  return serialized(async () => {
    if (!client?.queueDestination?.key) throw new Error('Connect to a desktop before importing a job.')
    const rows = await readPending()
    // The same link shared twice while offline is one import, not two.
    const url = String(job.url || '').slice(0, 2000)
    if (rows.some(r => kindOf(r) === 'import' && r.url === url && r.destination?.key === client.queueDestination.key)) return
    const id = newId()
    rows.push({
      id, kind: 'import', idempotencyKey: job.idempotencyKey || id,
      url, title: String(job.title || '').slice(0, 200),
      createdAt: new Date().toISOString(), destination: { ...client.queueDestination }, lastError: '',
    })
    await writePending(rows)
  })
}

export function editPending(id, edits) {
  return serialized(async () => {
    const rows = await readPending(), row = rows.find(r => r.id === id)
    if (!row) throw new Error('This request has already been delivered or cancelled.')
    if (kindOf(row) !== 'scan') throw new Error('Only a queued scan can be edited.')
    row.keywords = String(edits.keywords ?? row.keywords).slice(0, 500)
    row.location = String(edits.location ?? row.location).slice(0, 160)
    // An edited search is a different request; the desktop must not answer it
    // with the reply to the old one.
    row.idempotencyKey = newId()
    await writePending(rows)
  })
}

export function cancelPending(id) {
  return serialized(async () => { await writePending((await readPending()).filter(r => r.id !== id)) })
}

// Start again after the queue was found corrupt. The unreadable value stays in
// BACKUP_KEY; only the live key is cleared.
export function resetCorruptQueue() {
  return serialized(async () => {
    let raw = null
    try { raw = await AsyncStorage.getItem(KEY) } catch { /* nothing to copy */ }
    if (raw != null) await AsyncStorage.setItem(BACKUP_KEY, raw)
    await AsyncStorage.removeItem(KEY)
  })
}

function deliver(client, row) {
  const opts = { idempotencyKey: row.idempotencyKey || row.id }
  if (kindOf(row) === 'import') {
    if (!client.importJob) {
      return Promise.reject(Object.assign(new Error('This connection cannot import jobs.'), { status: 400 }))
    }
    return client.importJob({ url: row.url, title: row.title || undefined }, opts)
  }
  return client.requestScan({ keywords: row.keywords, location: row.location }, opts)
}

// Deliver what is held for this client's destination.
//
// Returns { delivered, dropped, needsPairing, stopped }:
//   dropped      — requests the destination refused outright, with the reason.
//                  They are removed: they would be refused again, and used to
//                  block every request behind them forever.
//   needsPairing — the destination no longer accepts this phone's credential.
//                  Every later request would fail the same way, so the flush
//                  stops. The requests stay where the user can see and cancel
//                  them; re-pairing makes a new destination, so they are never
//                  silently sent somewhere else.
//   stopped      — the reason the flush stopped early (unreachable or busy),
//                  or ''. Those requests stay queued with lastError set.
export function flush(client, onlyId = null) {
  return serialized(async () => {
    let rows = await readPending()
    const result = { delivered: 0, dropped: [], needsPairing: false, stopped: '' }
    for (const req of [...rows]) {
      if (!req.destination?.key || req.destination.key !== client?.queueDestination?.key) continue
      if (onlyId && req.id !== onlyId) continue
      try {
        await deliver(client, req)
      } catch (err) {
        const kind = classifyError(err)
        const message = err?.scope ? messageFor(err) : (err?.message || 'Destination unavailable')
        if (kind === 'auth') {
          req.lastError = message
          await writePending(rows)
          result.needsPairing = true
          result.stopped = message
          break
        }
        if (isRetryable(kind)) {
          req.lastError = message
          await writePending(rows)
          result.stopped = message
          break
        }
        // Refused for good: take it out so it cannot block the rest, and say so.
        rows = rows.filter(r => r.id !== req.id)
        await writePending(rows)
        result.dropped.push({ id: req.id, kind: kindOf(req), label: req.keywords || req.url || 'Default search', error: message })
        continue
      }
      rows = rows.filter(r => r.id !== req.id)
      // Checkpoint every delivery; a later failed request must not replay these.
      await writePending(rows)
      result.delivered++
    }
    return result
  })
}
