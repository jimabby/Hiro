// A request belongs to its original account/paired desktop. Legacy entries have
// no trustworthy destination, so retain them for inspection/cancellation only.
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'hiro.pendingScans'
let chain = Promise.resolve()
function serialized(op) {
  const run = chain.then(op, op)
  chain = run.then(() => {}, () => {})
  return run
}
async function readPending() {
  const raw = await AsyncStorage.getItem(KEY)
  if (!raw) return []
  const rows = JSON.parse(raw)
  if (!Array.isArray(rows)) throw new Error('The saved scan queue is unreadable. It has not been changed.')
  return rows
}
async function writePending(rows) { await AsyncStorage.setItem(KEY, JSON.stringify(rows)) }
export function getPending() { return serialized(readPending) }
export function enqueue(req, client) {
  return serialized(async () => {
    if (!client?.queueDestination?.key) throw new Error('Connect to a destination before queuing a scan.')
    const rows = await readPending()
    rows.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      keywords: String(req.keywords || '').slice(0, 500), location: String(req.location || '').slice(0, 160),
      createdAt: new Date().toISOString(), destination: { ...client.queueDestination }, lastError: '',
    })
    await writePending(rows)
  })
}
export function editPending(id, edits) {
  return serialized(async () => {
    const rows = await readPending(), row = rows.find(r => r.id === id)
    if (!row) throw new Error('This request has already been delivered or cancelled.')
    row.keywords = String(edits.keywords ?? row.keywords).slice(0, 500)
    row.location = String(edits.location ?? row.location).slice(0, 160)
    await writePending(rows)
  })
}
export function cancelPending(id) {
  return serialized(async () => { await writePending((await readPending()).filter(r => r.id !== id)) })
}
export function flush(client, onlyId = null) {
  return serialized(async () => {
    let rows = await readPending(), delivered = 0
    for (const req of [...rows]) {
      if (!req.destination?.key || req.destination.key !== client?.queueDestination?.key) continue
      if (onlyId && req.id !== onlyId) continue
      try {
        await client.requestScan({ keywords: req.keywords, location: req.location })
      } catch (err) {
        req.lastError = err.message || 'Destination unavailable'
        await writePending(rows)
        break
      }
      rows = rows.filter(r => r.id !== req.id)
      // Checkpoint every delivery; a later failed request must not replay these.
      await writePending(rows)
      delivered++
    }
    return delivered
  })
}
