// Recognising the same job advert again under a different URL.
//
// The duplicate checks that already exist are all about identity the URL or the
// title carries: hasSeenJobUrl (this exact posting), findDuplicateAcrossPlatforms
// (same title and company somewhere else), isRoleSuppressed (a role the user
// said keeps coming back). Every one of them misses the ordinary case where an
// employer takes a listing down and puts the identical text back up next month
// under a new URL and a slightly different title — "Data Engineer" becomes
// "Data Engineer (Senior)" and nothing matches, so the scan pays for a score, a
// tailored resume and a cover letter it has already paid for.
//
// The fingerprint is deliberately EXACT rather than fuzzy, and that asymmetry is
// the whole design. The two mistakes are not equally bad:
//
//   a miss   — the job is scored again. Costs a few cents and some tokens.
//   a match  — the job is skipped, silently, and never applied to.
//
// So this only ever claims "identical", never "similar". Whitespace, casing,
// punctuation and tracking URLs are normalised away because those change for
// reasons that have nothing to do with the job; the words themselves are not
// touched. A genuinely rewritten advert is a genuinely different advert and gets
// scored on its merits.

const crypto = require('crypto')

// Below this there is not enough text to be sure two ads are the same one. A
// three-line advert is mostly boilerplate, and two different roles at the same
// employer can easily share it — which is exactly the false positive that would
// hide a real job.
const MIN_NORMALISED_LENGTH = 200

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    // Links carry campaign and session parameters that differ between postings
    // of the same ad, so they say nothing about whether the text is the same.
    .replace(/https?:\/\/\S+/g, ' ')
    // Reference numbers are per-posting by definition — a repost always has a
    // new one, and leaving them in would defeat the entire check.
    .replace(/\b(?:ref|reference|job ?id|requisition|req)\b[^a-z0-9]{0,3}[a-z0-9-]{3,}/g, ' ')
    // Everything that is not a letter or digit becomes one space. Bullet
    // characters, smart quotes, non-breaking spaces and line-ending differences
    // all change between postings without changing a word.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// A stable id for one advert's text at one employer, or null when there is not
// enough to go on.
//
// The company is folded in so that two employers using the same agency
// boilerplate are never mistaken for each other — the hash answers "have we
// seen THIS ad from THIS company", which is the only question worth acting on.
function fingerprint(company, description) {
  const body = normalise(description)
  if (body.length < MIN_NORMALISED_LENGTH) return null
  const who = String(company || '').trim().toLowerCase()
  return crypto.createHash('sha256').update(`${who}${body}`).digest('hex')
}

module.exports = { fingerprint, normalise, MIN_NORMALISED_LENGTH }
