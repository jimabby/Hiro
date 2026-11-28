// scripts/generate-training-data.js, end to end against a fake teacher.
//
// What matters most is that the recorded prompt is exactly what the app sends:
// a fine-tune on prompts the app never sends teaches the wrong thing. So every
// stored example is compared with the request the teacher actually received.

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-training-data-'))
const { createChecker } = require('./helpers')
const gen = require('../scripts/generate-training-data')

const { check, done } = createChecker()
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `hiro-td-${name}-`))
const quiet = () => {}

const RESUME = `Alex Example
alex@example.com | Sydney

EXPERIENCE
Software Engineer, Acme Pty Ltd, 2021-2025
- Built React and Node.js features for a booking platform used by 40k customers
- Improved API response times by 30% by adding Redis caching

SKILLS
Languages: JavaScript, TypeScript, SQL`

const JD = 'We are hiring a Frontend Developer to build React and TypeScript interfaces for our fintech platform. ' +
  'You will work with designers, write tests, care about accessibility and performance, and collaborate on REST APIs.'

const USER_ANSWER = 'At Acme I owned the booking flow rewrite. Checkout was slow, so I profiled it, added Redis caching and cut response times by a third.'

// Replies keyed on the prompt. The interview-questions reply is deliberately
// invalid (an unknown category) so refusal is exercised on a real response.
function replyFor(prompt) {
  if (prompt.startsWith('Tailor the following resume')) return prompt.split('MASTER RESUME:\n')[1]
  if (prompt.includes('cover letter')) return `Dear Hiring Manager,\n\n${'I would like to apply for this role. '.repeat(12)}\n\nSincerely,\n\nAlex Example`
  if (prompt.includes('Return ONLY a number from 0 to 100')) return '72'
  if (prompt.includes('Return JSON only: {"score"')) return '```json\n{ "score": 80, "explanation": "Strong React match." }\n```'
  if (prompt.startsWith('Analyze which key skills')) return '{ "missing": ["fintech"], "present": ["React", "TypeScript"] }'
  if (prompt.includes('talking points')) return '["React", "Node.js", "Caching", "Accessibility", "Testing"]'
  if (prompt.startsWith('Generate 8 likely interview questions')) return JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ question: `Q${i}?`, answer: 'A.', category: 'trivia' })))
  if (prompt.startsWith('Draft an answer')) return 'At Acme I built React features for a booking platform, and when pages were slow I added caching that cut response times.'
  if (prompt.includes('follow-up probe')) return 'Can you walk me through a specific example?'
  if (prompt.includes('screening question')) return 'Yes'
  return ''
}

function startTeacher() {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      const params = JSON.parse(body)
      received.push(params)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: params.model,
        choices: [{ index: 0, message: { role: 'assistant', content: replyFor(params.messages[0].content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` })
  }))
}

function writeInputs() {
  const dir = tmp('inputs')
  const resume = path.join(dir, 'resume.txt')
  fs.writeFileSync(resume, RESUME)
  const bundle = path.join(dir, 'export.json')
  fs.writeFileSync(bundle, JSON.stringify({
    magic: 'hiro-data-export', version: 1,
    data: {
      applications: [
        { job_title: 'Frontend Developer', company: 'Fintech', job_description: JD },
        // The same ad scraped twice, reflowed: one job, not two.
        { job_title: 'Frontend Developer', company: 'Fintech', job_description: JD.replace(/ /g, '  ') },
        { job_title: 'Stub', company: 'X', job_description: 'Too short to learn from.' },
      ],
      interview_answers: [
        { question: 'Tell me about a time you improved performance.', answer: USER_ANSWER, source: 'user' },
        { question: 'An AI draft nobody edited', answer: 'x'.repeat(100), source: 'ai' },
      ],
      screening_cache: [
        { question: 'Do you have the right to work in Australia?', answer: 'Yes, I am a citizen.', source: 'user' },
        { question: 'Are you comfortable with on-call?', answer: 'Yes', source: 'ai' },
      ],
    },
  }))
  return { resume, bundle }
}

const readJsonl = (file) => fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : []

;(async () => {
  // ── Arguments ─────────────────────────────────────────────────
  const threw = (fn) => { try { fn(); return '' } catch (e) { return e.message } }
  check('a résumé is required', threw(() => gen.parseArgs([])), 'At least one --resume is required.')
  check('a flag missing its value says so', threw(() => gen.parseArgs(['--resume'])), '--resume needs a value')
  check('unknown flags are refused, not ignored', threw(() => gen.parseArgs(['--resume', 'r', '--frobnicate'])), 'Unknown option --frobnicate')
  check('--limit 0 is allowed (user answers only)', gen.parseArgs(['--resume', 'r', '--limit', '0']).limit, 0)

  // ── Small pieces ──────────────────────────────────────────────
  check('bank HTML becomes a plain spoken answer',
    gen.htmlToText('<p>Use <code>try</code> &amp; <code>catch</code>.</p><ul><li><b>Checked</b>: compile time</li></ul>'),
    'Use try & catch.\n\n- Checked: compile time')
  check('a fenced JSON score is stored as the bare JSON the app reads',
    gen.VALIDATORS.scoreMatchWithExplanation('```json\n{"score": 80, "explanation": "ok"}\n```'),
    '{"score":80,"explanation":"ok"}')
  check('a score with words around it is refused', threw(() => gen.VALIDATORS.scoreMatch('Score: 72')), 'not a bare 0-100 score')

  // ── Fabrication: what a weak teacher really did ───────────────
  // llama3.2, asked to tailor this résumé for a .NET job, rewrote the React
  // bullet as "Built C# microservices…". C# is in the skills line, so nothing
  // was invented outright; it was moved onto a job that never used it.
  const tailor = (edit) => threw(() => gen.VALIDATORS.tailorResume(edit(RESUME), { resume: RESUME }))
  check('a technology moved onto a bullet that never mentioned it is refused',
    tailor(r => r.replace('Built React and Node.js features', 'Built C# and .NET microservices')),
    'fabrication (moved-claim: c#; moved-claim: .net)')
  check('reordering a skills line to lead with the job\'s tools is allowed',
    tailor(r => r.replace('JavaScript, TypeScript, SQL', 'SQL, TypeScript, JavaScript')), '')
  check('light rewording of a bullet is allowed',
    tailor(r => r.replace('Improved API response times by 30%', 'Cut API response times by 30%')), '')
  check('adding or merging lines is refused (the DOCX writer maps line to line)',
    tailor(r => r + '\n- Mentored junior developers'), 'changed the number of lines (8 → 9)')
  // What qwen3-30b did with a certifications list: same lines, one moved to the
  // end. It used to be reported as "dropped the figure", which it had not.
  check('trailing spaces (Markdown line breaks) are not kept in the target',
    gen.VALIDATORS.tailorResume(RESUME.split('\n').map(l => `${l}  `).join('\n'), { resume: RESUME }), RESUME)
  check('a line moved out of order is refused as a move',
    tailor(r => r.replace(/(- Built[^\n]*)\n(- Improved[^\n]*)/, '$2\n$1')),
    'moved a line out of order ("- Improved API response times by 30% by adding Redis caching")')
  check('an invented date or metric is refused',
    tailor(r => r.replace('used by 40k customers', 'used by 40k customers since 2019')), 'fabrication (date: 2019; figure: 2019)')
  check('a dropped metric is refused: the real tailoring llama3.2 did cut "40k" and "30%"',
    tailor(r => r.replace(' used by 40k customers', '')), 'dropped the figure "40k"')
  check('an unfilled template is refused',
    threw(() => gen.VALIDATORS.generateCoverLetter(`Dear Hiring Manager,\n\nI want to join [Company Name]. ${'Real sentence. '.repeat(30)}`, { resume: RESUME })),
    'unfilled placeholder [Company Name]')
  check('a screening answer claiming a clearance the résumé lacks is refused',
    threw(() => gen.VALIDATORS.answerScreeningQuestion('Yes, I hold a current security clearance.', { resume: RESUME })),
    'fabrication (credential: clearance)')
  check('a markdown cover letter is refused', threw(() => gen.VALIDATORS.generateCoverLetter('**Dear**\n' + 'x'.repeat(400))), 'markdown')
  check('a draft saying the résumé does not cover it is a valid short answer',
    gen.VALIDATORS.draftInterviewAnswer("Your resume doesn't cover this — think of a team project.", { resume: RESUME }), "Your resume doesn't cover this — think of a team project.")

  const bank = [{ id: 'q1', question: 'What is a closure?', answer: 'A function plus its scope.' }, { id: 'q2', question: 'What is REST?', answer: '' }]
  const tasks = gen.buildTasks({ jobs: [{ id: 'j1', description: JD }], resumes: [{ id: 'r1', text: RESUME }], bank })
  check('the bank gives a draft per question and a follow-up per question with an answer',
    tasks.filter(t => t.meta.question).map(t => t.key).sort(),
    ['draftInterviewAnswer:q1:r1', 'draftInterviewAnswer:q2:r1', 'generateFollowUpQuestion:q1'])
  check('a whole job lands in one split, so eval never sees a job train saw',
    new Set(tasks.filter(t => t.meta.job === 'j1' && !t.meta.question).map(t => t.split)).size, 1)
  const again = gen.buildTasks({ jobs: [{ id: 'j1', description: JD }], resumes: [{ id: 'r1', text: RESUME }], bank })
  check('task keys and splits are stable across runs', again.map(t => `${t.key}/${t.split}`), tasks.map(t => `${t.key}/${t.split}`))

  // ── End to end ────────────────────────────────────────────────
  const teacher = await startTeacher()
  const { resume, bundle } = writeInputs()
  process.env.TEACHER_API_KEY = 'good-key'
  const argsFor = (out, extra = []) => gen.parseArgs(['--resume', resume, '--export', bundle, '--out', out, '--teacher-url', teacher.url, '--no-bank', ...extra])

  const out = tmp('out')
  const first = await gen.run(argsFor(out), quiet)
  const records = [...readJsonl(path.join(out, 'train.jsonl')), ...readJsonl(path.join(out, 'eval.jsonl'))]
  const byOp = (op, origin) => records.filter(r => r.meta.op === op && (!origin || r.meta.origin === origin))

  check('the duplicate and the too-short ad are dropped: 7 job calls + 1 screening call', teacher.received.length, 8)
  check('user answers never reach the teacher',
    teacher.received.some(p => JSON.stringify(p).includes(USER_ANSWER) || JSON.stringify(p).includes('right to work')), false)
  check('the invalid interview-question set is refused, everything else kept (7 teacher + 2 user)', records.length, 9)
  check('the refusal reason is reported', first.reasons['generateInterviewQuestions: unknown category "trivia"'], 1)

  const sent = teacher.received.map(p => JSON.stringify(p.messages))
  check('every teacher example is the exact prompt the app sent',
    records.filter(r => r.meta.origin === 'teacher').every(r => sent.includes(JSON.stringify(r.messages.slice(0, -1)))), true)
  check('every example ends with the assistant turn', records.every(r => r.messages.at(-1).role === 'assistant'), true)

  const mine = byOp('draftInterviewAnswer', 'user')[0]
  check('the user\'s own answer is the target, under the app\'s draft prompt',
    [mine?.messages.at(-1).content, mine?.messages[0].content.startsWith('Draft an answer to an interview question')], [USER_ANSWER, true])
  check('the AI-drafted bank answer is not treated as the user\'s', byOp('draftInterviewAnswer').length, 1)
  check('a screening answer the user wrote is kept as theirs', byOp('answerScreeningQuestion', 'user')[0]?.messages.at(-1).content, 'Yes, I am a citizen.')
  check('an AI screening answer is re-asked of the teacher', byOp('answerScreeningQuestion', 'teacher')[0]?.messages.at(-1).content, 'Yes')
  check('the score explanation is stored without code fences', byOp('scoreMatchWithExplanation')[0]?.messages.at(-1).content, '{"score":80,"explanation":"Strong React match."}')
  check('teacher examples name the teacher', byOp('scoreMatch')[0]?.meta.teacher, 'deepseek-chat')

  await gen.run(argsFor(out), quiet)
  check('a second run asks the teacher nothing already answered', teacher.received.length, 9) // only the refused one again
  check('and writes no duplicates', [...readJsonl(path.join(out, 'train.jsonl')), ...readJsonl(path.join(out, 'eval.jsonl'))].length, 9)

  const limited = tmp('limited')
  const before = teacher.received.length
  const res = await gen.run(argsFor(limited, ['--limit', '2']), quiet)
  check('--limit caps teacher calls', teacher.received.length - before, 2)
  check('and reports what is left', res.skipped, 6)
  check('user answers are written even under --limit 2',
    readJsonl(path.join(limited, 'train.jsonl')).concat(readJsonl(path.join(limited, 'eval.jsonl'))).filter(r => r.meta.origin === 'user').length, 2)

  const dry = tmp('dry')
  const dryBefore = teacher.received.length
  await gen.run(argsFor(dry, ['--dry-run']), quiet)
  check('a dry run calls nothing and writes nothing', [teacher.received.length - dryBefore, fs.readdirSync(dry)], [0, []])

  process.env.TEACHER_API_KEY = 'bad-key'
  let refusal = ''
  try { await gen.run(argsFor(tmp('badkey')), quiet) } catch (e) { refusal = e.message }
  check('a refused key stops the run instead of failing every task', refusal.startsWith('The teacher refused the key (401)'), true)

  delete process.env.TEACHER_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  let missing = ''
  try { await gen.run(argsFor(tmp('nokey')), quiet) } catch (e) { missing = e.message }
  check('no key is a clear error, not 401s', missing.startsWith('Set TEACHER_API_KEY'), true)

  teacher.server.close()
  done()
})()
