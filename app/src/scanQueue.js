// Offline queue for scan requests. When the desktop is unreachable, scan
// requests are stored on the phone and delivered the next time we connect.
//
// All operations are serialized through a promise chain: enqueue and flush
// are read-modify-write cycles on one AsyncStorage key, and letting them
// interleave (mount-load + pull-to-refresh both flushing, or an enqueue
// landing mid-flush) delivered the same scan twice or silently erased a
// freshly queued request.
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'hiro.pendingScans'

let chain = Promise.resolve()

function serialized(op) {
  const run = chain.then(op, op)
  // Keep the chain alive even if this op fails.
  chain = run.then(() => {}, () => {})
  return run
}

async function readPending() {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function writePending(list) {
  await AsyncStorage.setItem(KEY, JSON.stringify(list))
}

export function getPending() {
  return serialized(readPending)
}

export function enqueue(req) {
  return serialized(async () => {
    const list = await readPending()
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...req })
    await writePending(list)
  })
}

// Try to deliver every pending request to the desktop. Anything that fails
// (desktop still offline) stays queued. Returns the number delivered.
export function flush(client) {
  return serialized(async () => {
    const list = await readPending()
    if (list.length === 0) return 0
    let delivered = 0
    const remaining = []
    // Stop at the first failure and keep the rest queued, rather than trying
    // every one. A flush runs on reconnect and on pull-to-refresh, and each
    // request carries an 8-second timeout — so against a desktop that is simply
    // not there, ten queued scans meant eighty seconds of the refresh spinner
    // before the phone gave up. One failure already answers the only question
    // that matters here, which is whether the desktop is reachable at all.
    let reachable = true
    for (const req of list) {
      if (!reachable) { remaining.push(req); continue }
      try {
        await client.requestScan({ keywords: req.keywords, location: req.location })
        delivered++
      } catch {
        remaining.push(req)
        reachable = false
      }
    }
    await writePending(remaining)
    return delivered
  })
}
