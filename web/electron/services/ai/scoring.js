// Reading a match score out of a model's reply, and refusing to invent one.
//
// applicator.js already documents, at length, why a fabricated score is the
// worst failure in the scan loop: the row gets written, so `hasSeenJobUrl` skips
// that URL forever, and the score feeds the histogram the threshold advice is
// derived from. Its fix — leave the job unsaved and retry next scan — hangs off
// the model call THROWING.
//
// Every adapter then quietly defeated that by returning 50 for a reply it could
// not parse. The applicator never saw a failure, so it recorded 50 as though the
// model had said it. At the default threshold of 80 that lands in `skipped`, and
// the job is gone for good. The path is not exotic: a local model behind
// aiProvider 'local' is exactly the case where "return JSON only" comes back
// wrapped in prose, and local.js routes through the openai adapter.
//
// So: parse generously, and when there is genuinely no number, throw. A thrown
// error is retried by the usage layer and then left for the next scan, which is
// the behaviour the applicator already promises the user.

class ScoreUnavailableError extends Error {
  constructor(detail) {
    super(`The model did not return a usable match score${detail ? ` (${detail})` : ''}.`)
    this.name = 'ScoreUnavailableError'
    // Marks this as "no answer", not "bad answer" — the caller must not record
    // anything for this job.
    this.scoreUnavailable = true
  }
}

function clamp(n) {
  return Math.min(100, Math.max(0, Math.round(n)))
}

// A number is only a score if it is actually a number. `parseInt` is too eager
// on its own — parseInt('2024 was a great year', 10) is 2024, and parseInt of a
// bare 'N/A' is NaN but parseInt('80%') is 80, which we do want.
function coerce(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value)
  const text = String(value ?? '').trim()
  if (!text) return null
  // Leading number, optionally a percentage, and nothing but punctuation after.
  // The decimal part is captured rather than dropped so clamp() can round it —
  // a model that answers 82.6 means 83, not 82.
  // A leading minus is accepted and then clamped to 0. "-5" is out of contract,
  // but it is unambiguously the model saying "no fit at all" rather than failing
  // to answer, and the two must not be confused: one is a score, the other is
  // the absence of one.
  const m = /^(-?\d{1,3}(?:\.\d+)?)\s*%?\s*(?:[.,;:!]|$)/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? clamp(n) : null
}

// Last resort for a reply that is prose with a number in it somewhere:
// "I'd score this candidate 72 out of 100." Only accepts a value in range and
// only when the text reads like a score, so a stray year or salary is not
// mistaken for one.
function scavenge(text) {
  const body = String(text ?? '')
  const m = /(?:score|match|rating|rate[ds]?)\D{0,20}?(\d{1,3})\s*(?:%|\/\s*100|\bout of 100\b)?/i.exec(body)
    || /\b(\d{1,3})\s*(?:%|\/\s*100|out of 100)\b/i.exec(body)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 && n <= 100 ? clamp(n) : null
}

// Bare-number prompt ("Return ONLY a number from 0 to 100").
function parseScore(text) {
  const direct = coerce(text)
  if (direct !== null) return direct
  const found = scavenge(text)
  if (found !== null) return found
  throw new ScoreUnavailableError(preview(text))
}

// JSON prompt ({ score, explanation }). `parsed` may be null when the JSON
// itself failed, in which case we still try the raw text before giving up.
function parseScoreWithExplanation(parsed, rawText) {
  if (parsed && typeof parsed === 'object') {
    const score = coerce(parsed.score)
    if (score !== null) {
      return { score, explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '' }
    }
  }
  // The JSON was absent or had no usable score — fall back to reading the reply
  // as prose. Explanation is dropped rather than guessed.
  const direct = coerce(rawText)
  if (direct !== null) return { score: direct, explanation: '' }
  const found = scavenge(rawText)
  if (found !== null) return { score: found, explanation: '' }
  throw new ScoreUnavailableError(preview(rawText))
}

function preview(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return 'empty reply'
  return `replied: "${s.length > 80 ? `${s.slice(0, 77)}…` : s}"`
}

module.exports = { parseScore, parseScoreWithExplanation, ScoreUnavailableError }
