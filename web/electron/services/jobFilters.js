// Cheap, local reasons not to look at a job at all.
//
// Every listing that reaches the scorer costs a model call, and the scorer is a
// poor way to say "never senior roles" or "remote only" — it is asked how good
// a match a job is, not whether the user would ever take it, so a strong
// candidate for a senior on-site role still scores well and still gets drafted.
// These run before any of that spend.

// ─── Excluded keywords ───────────────────────────────────────────

function parseKeywordList(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[,\n]/)
  const seen = new Set()
  const out = []
  for (const raw of parts) {
    const k = String(raw || '').trim().toLowerCase()
    if (k && !seen.has(k)) { seen.add(k); out.push(k) }
  }
  return out
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whole words, not substrings. "lead" must not exclude "Leadership
// Development Manager" any more than "intern" should exclude "International
// Sales"; a substring test would silently throw away real jobs, and a silently
// discarded job is the expensive mistake here.
function keywordPattern(keyword) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}($|[^\\p{L}\\p{N}])`, 'iu')
}

// The first excluded keyword found in the job's title or company, or null.
// The description is deliberately not searched: "you'll work alongside senior
// engineers" appears in junior ads, and excluding on it would empty the feed.
function excludedKeyword(job, keywords) {
  const list = parseKeywordList(keywords)
  if (list.length === 0) return null
  const haystack = `${job?.job_title || ''}\n${job?.company || ''}`
  return list.find(k => keywordPattern(k).test(haystack)) || null
}

// ─── Work arrangement ────────────────────────────────────────────

const NOT_REMOTE = /\b(?:not|no|non)[- ]remote\b|\bisn'?t (?:a )?remote\b|\bis not (?:a )?remote\b|\bremote work is not (?:available|offered|possible)\b/i
const HYBRID = /\bhybrid\b|\b\d\s*days? (?:a|per) week (?:in|at) (?:the )?office\b|\bsplit between (?:home|remote) and (?:the )?office\b/i
const REMOTE = /\b(?:fully |100% |full[- ]time )?remote\b|\bwork(?:ing)? from (?:home|anywhere)\b|\bwfh\b|\btelecommut/i
const ONSITE = /\bon[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b|\bin[- ]person\b/i

// What a listing says about where the work happens: 'remote', 'hybrid',
// 'onsite', or 'unknown' when it does not say. Hybrid wins over remote because
// hybrid ads almost always mention remote days too.
function workArrangement(text) {
  const t = String(text || '')
  if (!t.trim()) return 'unknown'
  if (NOT_REMOTE.test(t)) return HYBRID.test(t) ? 'hybrid' : 'onsite'
  if (HYBRID.test(t)) return 'hybrid'
  if (REMOTE.test(t)) return 'remote'
  if (ONSITE.test(t)) return 'onsite'
  return 'unknown'
}

// 'any'      — no filtering (the default)
// 'remote'   — remote only
// 'flexible' — remote or hybrid
const PREFERENCES = ['any', 'remote', 'flexible']
const ACCEPTS = {
  remote: new Set(['remote']),
  flexible: new Set(['remote', 'hybrid']),
}

// Should this job be scored, given the user's preference?
//
// The listing's own fields are read first (title, location, any work-type
// badge the scraper captured), then the description. A job that never says is
// KEPT: plenty of genuine remote roles only mention it in a line the regexes
// do not catch, and the scorer still reads the whole description.
function matchesWorkPreference(preference, job, description = '') {
  const accepts = ACCEPTS[preference]
  if (!accepts) return { ok: true, arrangement: 'unknown' }
  const listing = [job?.job_title, job?.location, job?.work_type].filter(Boolean).join('\n')
  let arrangement = workArrangement(listing)
  if (arrangement === 'unknown') arrangement = workArrangement(description)
  if (arrangement === 'unknown') return { ok: true, arrangement }
  return { ok: accepts.has(arrangement), arrangement }
}

module.exports = {
  parseKeywordList, excludedKeyword,
  workArrangement, matchesWorkPreference, PREFERENCES,
}
