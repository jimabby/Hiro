// The weekly question-bank review (scripts/review-question-bank.js) and the
// bank validator, with the Claude API replaced: which cards are picked, what a
// verdict does to the file, and that an unsafe rewrite is never written.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-review-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
const FILE = path.join(TMP, 'questions.json')
const SUMMARY = path.join(TMP, 'summary.md')
process.env.QUESTION_BANK_FILE = FILE
process.env.ANTHROPIC_API_KEY = 'test-key'

const q = (id, updatedAt, extra = {}) => ({ id, topic: 'Node.js', category: 'Concept', question: `Question ${id}?`, answer: '<p>Old answer.</p>', difficulty: 'easy', tags: [], versions: [], updatedAt, ...extra })
fs.writeFileSync(FILE, JSON.stringify({ schema: 1, updatedAt: '2026-01-01', questions: [
  q('node-001', '2025-01-01'),
  q('node-002', '2024-06-01'),
  q('node-003', '2026-01-01'),
  q('node-004', '2023-01-01', { reviewedAt: '2026-01-01' }),
] }, null, 2))

// Verdicts by card: one current, one outdated with a good rewrite, one wrong
// with a rewrite that smuggles in markup.
const replies = {
  'node-002': { verdict: 'outdated', reason: 'Node 22 changed the default.', correctedAnswer: '<p>New answer with <code>fs/promises</code>.</p>', versions: ['Node 22'] },
  'node-001': { verdict: 'current', reason: 'Fine.', correctedAnswer: '', versions: [] },
  'node-003': { verdict: 'wrong', reason: 'Wrong.', correctedAnswer: '<p onclick="x()">Bad</p><script>alert(1)</script>', versions: [] },
}
const requests = []
class FakeAnthropic {
  constructor() {
    this.beta = { messages: { create: async (params) => {
      requests.push(params)
      const id = /Question (node-\d+)\?/.exec(params.messages[0].content)[1]
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(replies[id]) }] }
    } } }
  }
}
FakeAnthropic.APIError = class extends Error {}
FakeAnthropic.AuthenticationError = class extends FakeAnthropic.APIError {}

const review = require('../scripts/review-question-bank')
const { check, done } = createChecker()

;(async () => {
  const picked = review.pick(JSON.parse(fs.readFileSync(FILE, 'utf8')).questions, 3).map(p => p.q.id)
  check('the least recently checked cards come first', picked, ['node-002', 'node-001', 'node-003'])
  check('safe answers', [review.safeAnswer('<p>Hi <b>there</b></p>'), review.safeAnswer('<p onclick="x">Hi</p>'), review.safeAnswer('<img src=x>'), review.safeAnswer('')], [true, false, false, false])

  process.argv.push('--count', '3', '--summary', SUMMARY)
  await review.main({ Anthropic: FakeAnthropic })
  const after = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const by = Object.fromEntries(after.questions.map(x => [x.id, x]))
  const today = new Date().toISOString().slice(0, 10)

  check('one request per picked card', requests.length, 3)
  check('it asks the current Opus model', requests[0].model, 'claude-opus-5-5')
  check('for structured JSON at high effort', [requests[0].output_config.effort, requests[0].output_config.format.type], ['high', 'json_schema'])
  check('with the server-side fallback on', [requests[0].betas, requests[0].fallbacks], [['server-side-fallback-2026-07-01'], 'default'])
  check('an outdated answer is rewritten', by['node-002'].answer, '<p>New answer with <code>fs/promises</code>.</p>')
  check('and dated, with its versions', [by['node-002'].updatedAt, by['node-002'].versions], [today, ['Node 22']])
  check('a current answer is only marked reviewed', [by['node-001'].answer, by['node-001'].updatedAt, by['node-001'].reviewedAt], ['<p>Old answer.</p>', '2025-01-01', today])
  check('an unsafe rewrite is never written', by['node-003'].answer, '<p>Old answer.</p>')
  check('a card not picked is untouched', by['node-004'], q('node-004', '2023-01-01', { reviewedAt: '2026-01-01' }))
  check('the file date moves forward', after.updatedAt, today)
  const summary = fs.readFileSync(SUMMARY, 'utf8')
  check('the summary lists the rewrite for a person to check', /node-002\*\* \(outdated\)/.test(summary), true)
  check('and the skipped card, with why', /node-003: judged wrong, but the suggested answer did not pass validation/.test(summary), true)

  // The validator, on the reviewed file and on broken ones.
  const validator = path.join(__dirname, '..', 'scripts', 'check-question-bank.js')
  const runs = (file) => { try { execFileSync(process.execPath, [validator, file], { stdio: 'pipe' }); return 0 } catch (err) { return err.status } }
  check('the reviewed bank still validates', runs(FILE), 0)
  const bad = path.join(TMP, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ schema: 1, updatedAt: '2026-01-01', questions: [q('a-1', '2026-01-01', { answer: '<p style="x">Hi</p>' })] }))
  check('attributes in an answer fail validation', runs(bad), 1)
  fs.writeFileSync(bad, JSON.stringify({ schema: 1, updatedAt: '2026-01-01', questions: [q('a-1', '2026-01-01'), q('a-1', '2026-01-01')] }))
  check('duplicate ids fail validation', runs(bad), 1)
  fs.writeFileSync(bad, JSON.stringify({ schema: 1, updatedAt: '2025-01-01', questions: [q('a-1', '2026-01-01')] }))
  check('a file date older than its newest question fails', runs(bad), 1)
  check('the shipped bank validates', runs(path.join(__dirname, '..', 'electron', 'data', 'questions.json')), 0)

  done()
})().catch(err => { console.error(err); process.exit(1) })
