#!/usr/bin/env node
// Weekly AI review of the practice question bank.
//
// Picks the questions checked least recently, asks Claude whether each answer
// is still accurate and current, and rewrites only the ones it judges outdated
// or wrong. Nothing reaches users from here: the workflow opens a pull request
// with the changes and a summary, and a person merges it (or not). Installed
// apps fetch the bank from main, so merging is the moment it goes live.
//
// Usage: ANTHROPIC_API_KEY=... node web/scripts/review-question-bank.js [--count 15] [--summary review-summary.md]
// Without a key it explains and exits 0, so the scheduled workflow does not
// fail on a repository that has not set the secret.

const fs = require('fs')
const path = require('path')
const core = require('../electron/services/practiceCore')

const FILE = process.env.QUESTION_BANK_FILE || path.join(__dirname, '..', 'electron', 'data', 'questions.json')
const MODEL = 'claude-opus-5-5'
const ALLOWED_TAGS = new Set(['p', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'code', 'pre', 'br'])

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const today = new Date().toISOString().slice(0, 10)

const SYSTEM = `You review interview flashcards for junior software developers. Each card has a question and a model answer written in a small HTML subset.
Judge whether the answer is accurate and current as of today (${today}), for the technology versions in use today.
- "current": accurate and not misleading. Minor style issues do not count.
- "outdated": was right once but a newer version changed it (a removed API, a new default, a newer recommended approach).
- "wrong": factually incorrect or seriously misleading.
For "outdated" or "wrong", write a corrected answer in the same style: short, plain language, at junior level, about the same length.
Use only these HTML tags, with no attributes: <p>, <ul>, <ol>, <li>, <b>, <i>, <code>, <pre>. Escape < and > inside code as &lt; and &gt;.
Keep anything in the original that is still right. Do not add marketing language or opinions.
Set "versions" to the technology versions the answer depends on (for example "Java 21", ".NET 9", "Node 22"), or an empty list.
Be conservative: if you are not confident something changed, answer "current".`

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['current', 'outdated', 'wrong'] },
    reason: { type: 'string' },
    correctedAnswer: { type: 'string' },
    versions: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reason', 'correctedAnswer', 'versions'],
  additionalProperties: false,
}

function safeAnswer(html) {
  if (!html || !html.trim()) return false
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    if (!ALLOWED_TAGS.has(m[1].toLowerCase()) || m[2].trim()) return false
  }
  return core.answerBlocks(html).length > 0
}

// Oldest check first; a question never reviewed counts from when it was written.
function pick(questions, n) {
  return questions
    .map((q, i) => ({ q, i, at: q.reviewedAt || q.updatedAt || '0000-00-00' }))
    .sort((a, b) => (a.at === b.at ? (b.q.versions?.length || 0) - (a.q.versions?.length || 0) : a.at < b.at ? -1 : 1))
    .slice(0, n)
}

async function review(client, q) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Claude Opus 5.5 always thinks; effort sets how hard. Accuracy matters
    // more than speed here, so high rather than the default medium.
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    // A safety classifier can decline; the server then re-runs the request on
    // a fallback model it chooses, within the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: ${q.topic}\nCategory: ${q.category || 'unknown'}\nVersions noted: ${(q.versions || []).join(', ') || 'none'}\nLast updated: ${q.updatedAt || 'unknown'}\n\nQuestion: ${q.question}\n\nAnswer:\n${q.answer}`,
    }],
  })
  if (response.stop_reason === 'refusal') return { skipped: 'the model declined to review this card' }
  if (response.stop_reason === 'max_tokens') return { skipped: 'the review was cut off' }
  const text = response.content.find(b => b.type === 'text')?.text
  if (!text) return { skipped: 'no answer came back' }
  try { return { result: JSON.parse(text) } } catch { return { skipped: 'the reply was not valid JSON' } }
}

async function main({ Anthropic: SDK } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY is not set: skipping the question review. Add it as a repository secret to turn the weekly check on.')
    return
  }
  const COUNT = Math.min(50, Math.max(1, Number(arg('--count', process.env.REVIEW_COUNT || 15)) || 15))
  const SUMMARY = arg('--summary', '')
  const Anthropic = SDK || require('@anthropic-ai/sdk')
  const client = new Anthropic()
  const bank = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const chosen = pick(bank.questions, COUNT)
  const changed = []
  const skipped = []
  let current = 0

  for (const { q, i } of chosen) {
    let outcome
    try {
      outcome = await review(client, q)
    } catch (err) {
      // Most-specific first: a bad key will fail every card, so stop.
      if (err instanceof Anthropic.AuthenticationError) throw err
      outcome = { skipped: err instanceof Anthropic.APIError ? `API error ${err.status}` : String(err.message || err) }
    }
    if (outcome.skipped) { skipped.push({ q, why: outcome.skipped }); continue }
    const r = outcome.result
    const versions = (r.versions || []).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().slice(0, 40)).slice(0, 10)
    if (r.verdict === 'current') {
      bank.questions[i] = { ...q, reviewedAt: today }
      current++
      continue
    }
    if (!safeAnswer(r.correctedAnswer) || r.correctedAnswer.length > 8000) {
      skipped.push({ q, why: `judged ${r.verdict}, but the suggested answer did not pass validation` })
      continue
    }
    bank.questions[i] = { ...q, answer: r.correctedAnswer, versions: versions.length ? versions : (q.versions || []), updatedAt: today, reviewedAt: today }
    changed.push({ q, verdict: r.verdict, reason: String(r.reason || '').slice(0, 600) })
    console.log(`  ${r.verdict}: ${q.id} — ${q.question}`)
  }

  bank.updatedAt = today
  fs.writeFileSync(FILE, JSON.stringify(bank, null, 2) + '\n')

  const lines = [
    `Weekly AI review of ${chosen.length} practice questions (${MODEL}).`,
    '',
    `- ${current} still current (marked reviewed today)`,
    `- ${changed.length} rewritten`,
    `- ${skipped.length} skipped`,
    '',
  ]
  if (changed.length) {
    lines.push('### Rewritten — please check each one before merging', '')
    for (const c of changed) lines.push(`- **${c.q.id}** (${c.verdict}): ${c.q.question}`, `  - ${c.reason}`)
    lines.push('')
  }
  if (skipped.length) {
    lines.push('### Skipped', '')
    for (const s of skipped) lines.push(`- ${s.q.id}: ${s.why}`)
    lines.push('')
  }
  lines.push('AI answers can be wrong too. Merging this pull request publishes the changes to every installed copy of Hiro.')
  if (SUMMARY) fs.writeFileSync(SUMMARY, lines.join('\n') + '\n')
  console.log(`Reviewed ${chosen.length}: ${current} current, ${changed.length} rewritten, ${skipped.length} skipped.`)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `rewritten=${changed.length}\n`)
}

if (require.main === module) {
  main().catch(err => { console.error(err.message || err); process.exit(1) })
}

module.exports = { main, pick, safeAnswer, SCHEMA, MODEL }
