// A match score is either the model's answer or it is nothing.
//
// applicator.js documents at length why a fabricated score is the worst failure
// in the scan loop: the row gets written, `hasSeenJobUrl` then skips that URL
// forever, and the number pollutes the histogram the threshold advice is drawn
// from. Its fix — leave the job unsaved, retry next scan — hangs off the model
// call THROWING.
//
// Every adapter quietly defeated that by returning 50 for a reply it could not
// parse, so the applicator never saw a failure and recorded 50 as though the
// model had said it. At the default threshold of 80 that lands in 'skipped' and
// the job is gone for good. Not an exotic path: a local model is exactly where
// "return JSON only" comes back wrapped in prose, and local.js routes through
// the openai adapter.

const { createChecker } = require('./helpers')
const { parseScore, parseScoreWithExplanation, ScoreUnavailableError } = require('../electron/services/ai/scoring')

const { check, done } = createChecker()

function refused(fn) {
  try { fn(); return false } catch (err) { return !!err.scoreUnavailable }
}

// ─── Bare-number replies ─────────────────────────────────────────
check('a bare integer parses', parseScore('82'), 82)
check('surrounding whitespace is fine', parseScore('  75\n'), 75)
check('a percentage sign is fine', parseScore('64%'), 64)
check('a trailing full stop is fine', parseScore('91.'), 91)
check('a decimal is rounded', parseScore('82.6'), 83)
check('above range is clamped', parseScore('140'), 100)
check('below range is clamped', parseScore('-5'), 0)
check('zero is a real score, not a failure', parseScore('0'), 0)

// Prose with a score in it — worth scavenging rather than discarding.
check('prose is scavenged', parseScore("I'd score this candidate 72 out of 100."), 72)
check('a labelled score is scavenged', parseScore('Match: 68'), 68)

// ─── The whole point ─────────────────────────────────────────────
check('an unparseable reply throws', refused(() => parseScore('I am unable to assess this.')), true)
check('an empty reply throws', refused(() => parseScore('')), true)
check('a refusal throws rather than scoring 50', refused(() => parseScore('N/A')), true)
check('the error is marked as unavailable', new ScoreUnavailableError('x').scoreUnavailable, true)
check('the error quotes what came back', /unable/.test((() => {
  try { parseScore('unable to comply') } catch (e) { return e.message }
})()), true)

// A year is not a score. This is the exact shape that made `parseInt` too eager.
check('a bare year is not a score', refused(() => parseScore('2024 was a strong year for this role')), true)

// ─── JSON replies ────────────────────────────────────────────────
const ok = parseScoreWithExplanation({ score: 88, explanation: 'Strong overlap.' }, '{"score":88}')
check('a JSON score parses', ok.score, 88)
check('the explanation comes with it', ok.explanation, 'Strong overlap.')

check('a string score in JSON parses', parseScoreWithExplanation({ score: '73' }, '').score, 73)
check('a missing explanation is empty, not undefined', parseScoreWithExplanation({ score: 40 }, '').explanation, '')

// JSON that failed to parse at all — fall back to reading the raw reply before
// giving up, but never invent a number.
check('broken JSON falls back to the raw text', parseScoreWithExplanation(null, '77').score, 77)
check('the fallback drops the explanation rather than guessing',
  parseScoreWithExplanation(null, '77').explanation, '')
check('broken JSON with no number throws',
  refused(() => parseScoreWithExplanation(null, 'Sorry, I cannot help with that.')), true)
check('JSON with a non-numeric score throws',
  refused(() => parseScoreWithExplanation({ score: 'high', explanation: 'x' }, 'no number here')), true)

done()
