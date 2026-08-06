// Do the AI providers still return what the adapters parse?
//
// These are the calls a scan cannot proceed without, and their failure modes are
// all quiet. `scoreMatchWithExplanation` parses a number out of the model's reply:
// a provider that starts wrapping JSON in a markdown fence, renames a response
// field, or retires a model returns something the parser reads as a score of 0 or
// 50 — and the scan then files perfectly good jobs as "below threshold". No mock
// can tell you that has happened.
//
// Needs a real key. Set whichever you have and only those providers run:
//
//   HIRO_TEST_CLAUDE_KEY, HIRO_TEST_OPENAI_KEY,
//   HIRO_TEST_DEEPSEEK_KEY, HIRO_TEST_GEMINI_KEY  (+ HIRO_TEST_GEMINI_MODEL)
//
// Each run costs a few cents of real tokens, which is the other reason this is not
// part of `npm test`.

const aiAdapter = require('../../electron/services/ai/index')

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
const note = (msg) => console.log(`      ${msg}`)

const PROVIDERS = [
  { id: 'claude', env: 'HIRO_TEST_CLAUDE_KEY' },
  { id: 'chatgpt', env: 'HIRO_TEST_OPENAI_KEY' },
  { id: 'deepseek', env: 'HIRO_TEST_DEEPSEEK_KEY' },
  { id: 'gemini', env: 'HIRO_TEST_GEMINI_KEY', model: process.env.HIRO_TEST_GEMINI_MODEL || 'gemini-2.5-flash' },
]

// Short, unambiguous fixtures: a strong match and an obvious mismatch. The point
// is not to grade the model, it is to prove the reply still parses into the shape
// the applicator consumes — so the assertions are about type and range, plus one
// very loose ordering check that any working model passes.
const RESUME = 'Jane Test. Eight years as a backend engineer: Node.js, PostgreSQL, Kubernetes, AWS.'
const MATCHING_JOB = 'Senior Backend Engineer. Node.js and PostgreSQL on Kubernetes in AWS. 5+ years required.'
const MISMATCHED_JOB = 'Registered Veterinary Nurse. Small-animal practice. Certificate IV required.'

async function testProvider({ id, env, model }) {
  const key = process.env[env]
  if (!key) {
    console.log(`SKIP  ${id}: ${env} is not set`)
    return
  }
  console.log(`      testing ${id}${model ? ` (${model})` : ''}`)

  // ── The connection test the Settings page runs ──────────────
  try {
    await aiAdapter.testConnection(id, key, model)
    check(`${id}: testConnection succeeds`, true, true)
  } catch (err) {
    check(`${id}: testConnection succeeds`, err.message, true)
    return // nothing below will work either
  }

  // ── Scoring: the call the whole scan turns on ───────────────
  const strong = await aiAdapter.scoreMatchWithExplanation(id, key, MATCHING_JOB, RESUME, model)
  check(`${id}: scoring returns a numeric score`, typeof strong?.score, 'number')
  check(`${id}: the score is a percentage`, strong.score >= 0 && strong.score <= 100, true)
  // The explanation is shown to the user verbatim, so an empty one is a defect
  // even when the number is right.
  check(`${id}: scoring returns an explanation`, (strong?.explanation || '').length > 20, true)
  note(`${id}: strong match scored ${strong.score}`)

  const weak = await aiAdapter.scoreMatchWithExplanation(id, key, MISMATCHED_JOB, RESUME, model)
  check(`${id}: mismatch also returns a numeric score`, typeof weak?.score, 'number')
  note(`${id}: mismatch scored ${weak.score}`)
  // Deliberately loose. A parser that has silently broken returns the same
  // fallback for both, which is what this catches — not a judgement about how
  // well the model discriminates.
  check(`${id}: a backend job scores above a veterinary nursing job`, weak.score < strong.score, true)

  // ── Reply classification, used by the inbox check ───────────
  const reply = await aiAdapter.classifyReply(
    id, key,
    'Interview invitation — Senior Backend Engineer',
    'Hi Jane, we would like to invite you to a first interview next Tuesday at 2pm. Let us know if that works.',
    'Test Co', model
  )
  // The inbox check looks for one of its known labels as a SUBSTRING, so a model
  // that returns prose still works — but it has to contain the right label.
  check(`${id}: an interview invitation classifies as an interview`,
    /interview/i.test(String(reply || '')), true)

  const rejection = await aiAdapter.classifyReply(
    id, key,
    'Your application',
    'Thank you for applying. We have decided to move forward with other candidates.',
    'Test Co', model
  )
  check(`${id}: a rejection classifies as rejected`,
    /reject/i.test(String(rejection || '')), true)

  // ── Document generation ────────────────────────────────────
  const tailored = await aiAdapter.tailorResume(id, key, MATCHING_JOB, RESUME, model)
  check(`${id}: tailoring returns substantial text`, (tailored || '').length > 100, true)
  // The adapter strips markdown because employers' forms show it literally.
  check(`${id}: tailored text carries no markdown bold`, /\*\*/.test(tailored), false)

  const letter = await aiAdapter.generateCoverLetter(id, key, MATCHING_JOB, RESUME, model, 'professional', '')
  check(`${id}: a cover letter is returned`, (letter || '').length > 100, true)
  check(`${id}: the cover letter carries no markdown headings`, /^#{1,6}\s/m.test(letter), false)
}

async function main() {
  const configured = PROVIDERS.filter(p => process.env[p.env])
  if (configured.length === 0) {
    console.log('SKIP  no provider keys set — nothing was verified')
    console.log('      set HIRO_TEST_CLAUDE_KEY (or OPENAI / DEEPSEEK / GEMINI) to run these')
    return
  }
  for (const provider of PROVIDERS) {
    // Sequential on purpose: parallel calls to four providers make rate limits
    // look like contract failures.
    await testProvider(provider)
  }
  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(err => { console.error(err); process.exitCode = 1 })
