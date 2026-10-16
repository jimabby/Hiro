// The offline read cache's rules, separate from its storage so the plain-Node
// suite can reach them — see test/run.js and src/offlineCache.js.
//
// What is kept: the last Applications list and the Dashboard's figures, so a
// phone on a train still shows something true-as-of-then instead of an error.
// What is not: anything that is a credential, and the long free text an
// application carries (cover letter, résumé, job description, the user's own
// notes). The cache is plain AsyncStorage, so it holds only what the list and
// the tiles draw.

const CACHE_VERSION = 1
// Older than this, a cached view misleads more than it helps: statuses move,
// interviews pass. It is dropped rather than shown.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

// Fields the Applications list draws. Everything else is left behind.
const APPLICATION_FIELDS = [
  'id', 'local_id', 'job_title', 'company', 'platform', 'status', 'match_score',
  'applied_at', 'updated_at', 'next_action_at', 'next_action_note', 'fabrication_flags',
]

function pick(obj, fields) {
  const out = {}
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f]
  return out
}

function slimApplications(list) {
  return Array.isArray(list) ? list.map(a => pick(a, APPLICATION_FIELDS)) : []
}

// Dashboard: the tiles, the chart and the two lists. Interviews and follow-ups
// are trimmed to what their rows show.
function slimDashboard({ stats, perDay, interviews, dueActions } = {}) {
  return {
    stats: stats || null,
    perDay: Array.isArray(perDay) ? perDay : [],
    interviews: (interviews || []).map(iv => pick(iv, ['id', 'application_id', 'job_title', 'company', 'scheduled_at', 'has_time', 'location', 'kind'])),
    dueActions: (dueActions || []).map(a => pick(a, ['id', 'job_title', 'company', 'next_action_at', 'next_action_note'])),
  }
}

function makeEntry(data, now = Date.now()) {
  return { v: CACHE_VERSION, savedAt: now, data }
}

// Parse what storage returned. Anything unrecognised — another version, a
// truncated write — is simply no cache.
function readEntry(raw) {
  if (!raw) return null
  try {
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!entry || entry.v !== CACHE_VERSION || !Number.isFinite(entry.savedAt) || entry.data === undefined) return null
    return entry
  } catch {
    return null
  }
}

function isStale(entry, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
  if (!entry) return true
  // A timestamp from the future (the clock was changed) cannot be trusted
  // either way; treat it as stale rather than show it as "just now" forever.
  if (entry.savedAt > now + 60 * 1000) return true
  return now - entry.savedAt > maxAgeMs
}

// "cached · 5 min ago", for the badge.
function cachedLabel(entry, now = Date.now()) {
  if (!entry) return ''
  const mins = Math.max(0, Math.round((now - entry.savedAt) / 60000))
  let age
  if (mins < 1) age = 'just now'
  else if (mins < 60) age = `${mins} min ago`
  else if (mins < 60 * 24) age = `${Math.round(mins / 60)} h ago`
  else {
    const days = Math.round(mins / (60 * 24))
    age = `${days} day${days === 1 ? '' : 's'} ago`
  }
  return `cached · ${age}`
}

// The cached list is the unfiltered one; a filter or search chosen while
// offline is applied here, the same way the desktop would.
function filterApplications(list, { status, search } = {}) {
  let out = list || []
  if (status && status !== 'all') out = out.filter(a => a.status === status)
  const q = String(search || '').trim().toLowerCase()
  if (q) out = out.filter(a => `${a.job_title || ''} ${a.company || ''}`.toLowerCase().includes(q))
  return out
}

module.exports = {
  CACHE_VERSION, MAX_AGE_MS, slimApplications, slimDashboard, makeEntry, readEntry, isStale, cachedLabel, filterApplications,
}
