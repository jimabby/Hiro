// Bounded storage for the outcomes of phone commands (config.cloudScanResults
// and config.cloudCommandReceipts). Both maps exist for de-duplication: an
// outcome recorded locally lets the desktop re-acknowledge a command whose
// cloud write failed without running it again. That need ends once the cloud
// row carries the terminal status, which happens on the next sync — so a
// finished outcome only has to outlive a few syncs, not forever. Unpruned, the
// maps grew by one entry per command for the life of the install.
//
// Only terminal outcomes are pruned. 'accepted' and 'running' entries describe
// work still in flight; dropping one would let the next sync start it again.

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_TERMINAL = 200

function prune(map, now = Date.now()) {
  const entries = Object.entries(map && typeof map === 'object' ? map : {})
  const live = entries.filter(([, v]) => !TERMINAL.has(v?.status))
  // Entries written before outcomes carried a timestamp have no age; they sort
  // as oldest so the count bound retires them first.
  const finished = entries.filter(([, v]) => TERMINAL.has(v?.status))
    .filter(([, v]) => !v.at || now - Date.parse(v.at) <= MAX_AGE_MS)
    .sort(([, a], [, b]) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, MAX_TERMINAL)
  return Object.fromEntries([...live, ...finished])
}

// Record one outcome, stamped, and prune the rest of the map in the same write.
function record(map, key, outcome, now = Date.now()) {
  return prune({ ...(map || {}), [key]: { ...outcome, at: new Date(now).toISOString() } }, now)
}

module.exports = { prune, record, MAX_AGE_MS, MAX_TERMINAL }
