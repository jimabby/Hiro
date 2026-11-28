#!/usr/bin/env node
// Builds a fine-tuning dataset for a local model, from Hiro's own prompts.
//
// The point is a small model in Ollama that does Hiro's jobs nearly as well as
// a hosted one, so the résumé and the job search never leave the machine (see
// services/ai/local.js). A fine-tune is only as good as how closely its
// training prompts match what the app will send it, so this script writes no
// prompts of its own: it calls the same functions in services/ai/openai.js the
// app calls, and records the request at the OpenAI SDK, one layer below them.
// When a prompt changes in the app, the next dataset changes with it.
//
// Where the examples come from:
//   teacher  — a larger model answers each prompt (DeepSeek by default, whose
//              MIT licence permits training on its output; Anthropic's and
//              OpenAI's terms restrict it, so they are not offered here).
//   user     — answers the user wrote themselves in Hiro (interview answers and
//              screening answers marked source = 'user'). No model is called;
//              the same function runs against a stub that replies with the
//              user's answer, so the prompt is still byte-for-byte the app's.
//
// Inputs:
//   --resume <file>    plain-text résumé (repeatable; at least one)
//   --export <file>    a Hiro data export (Settings → Data → Export). Supplies
//                      job descriptions, screening questions and the user's own
//                      answers. Passphrase, if any, in HIRO_EXPORT_PASSPHRASE.
//   --jobs <path>      more job descriptions: a folder of .txt files, or a
//                      .json / .jsonl file of { title, company, description }
//   The practice question bank (electron/data/questions.json) is always used.
//
// Output (--out, default ./training-data): train.jsonl and eval.jsonl in the
// chat "messages" format Unsloth, LLaMA-Factory and OpenAI fine-tuning read.
// Eval holds out whole jobs and whole questions, so it measures the model on
// inputs it never trained on. Runs resume: examples already written are skipped.
//
// Everything sent to the teacher includes the résumé and the job ads. A
// throwaway Hiro profile is used for the run, so nothing is written to the
// real one.
//
//   TEACHER_API_KEY=sk-... node scripts/generate-training-data.js \
//     --resume ~/resume.txt --export ~/hiro-export.json --limit 20
//
// --dry-run builds every prompt without calling anything and reports counts
// and token estimates. --limit N stops after N teacher calls (try 20 first and
// read the output before paying for the rest).

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { AsyncLocalStorage } = require('async_hooks')

const SERVICES = path.join(__dirname, '..', 'electron', 'services')
const QUESTION_BANK = path.join(__dirname, '..', 'electron', 'data', 'questions.json')

const DEFAULTS = {
  out: 'training-data',
  teacherUrl: 'https://api.deepseek.com',
  teacherModel: 'deepseek-chat',
  concurrency: 3,
  evalFraction: 0.1,
  limit: Infinity,
}

const MIN_JOB_CHARS = 200

// ─── Recording at the SDK ───────────────────────────────────────────────
//
// Each task runs inside its own slot. openai.js awaits
// client.chat.completions.create(...), so wrapping that one method sees the
// exact messages and the raw reply of every call, whichever function made it,
// and withUsage's retries simply overwrite the slot with the attempt that won.
// A slot with `reply` set never reaches the network: that is how dry runs and
// the user's own answers get the app's prompt without a model behind it.

const capture = new AsyncLocalStorage()
let patched = false

function installRecorder() {
  if (patched) return
  patched = true
  // Resolves to the same copy services/ai/openai.js loads: both live under web/.
  const OpenAI = require('openai')
  const proto = OpenAI.Chat.Completions.prototype
  const original = proto.create
  proto.create = function (params, options) {
    const slot = capture.getStore()
    if (!slot) return original.call(this, params, options)
    slot.messages = params.messages
    slot.maxTokens = params.max_tokens
    if (slot.reply !== undefined) {
      slot.output = slot.reply
      slot.finish = 'stop'
      return Promise.resolve({ choices: [{ message: { content: slot.reply }, finish_reason: 'stop' }], usage: {} })
    }
    return original.call(this, params, options).then(res => {
      slot.output = res.choices?.[0]?.message?.content ?? ''
      slot.finish = res.choices?.[0]?.finish_reason
      slot.called = true
      return res
    })
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────

const sha = (text) => crypto.createHash('sha1').update(String(text)).digest('hex')
const shortId = (text, n = 12) => sha(text).slice(0, n)
const bucket = (text) => parseInt(sha(text).slice(0, 8), 16) / 0xffffffff
const pick = (seed, list) => list[parseInt(sha(seed).slice(0, 8), 16) % list.length]

// The question bank's answers are HTML for the practice cards. A candidate's
// spoken answer is plain text, so that is what the follow-up prompt gets.
function htmlToText(html) {
  return String(html || '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|ul|ol|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Mirrors parseJSON in services/ai/openai.js: what the app can read is what
// counts as valid, and the stored target is the bare JSON the app reads best.
function parseLikeApp(text) {
  const cleaned = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

const hasMarkdown = (t) => /\*\*|__|^#{1,6}\s/m.test(t)
// "[Company Name]", "[Your Name]": a template the teacher did not fill in.
const PLACEHOLDER_RE = /\[[A-Z][^\]\n]{1,40}\]/

// The app's own last-mile check for invented dates, credentials, job titles
// and employers, and for a true fact moved onto a line it does not belong to:
// the same check that holds a real application for review.
const guard = () => require(path.join(SERVICES, 'fabricationGuard'))

function refuseClaims(result) {
  if (!result.safe) refuse(`fabrication (${guard().describeFlags(result.flags)})`)
}

const contentLines = (text) => String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
const isStr = (v) => typeof v === 'string' && v.trim().length > 0
const CATEGORIES = new Set(['behavioral', 'technical', 'situational', 'role-specific'])

// ─── What counts as a good answer, per operation ────────────────────────
//
// Each returns the training target, or throws with the reason it was refused.
// A refused example is dropped, never repaired: a model trained on a teacher's
// near-misses learns the near-misses.

function refuse(reason) { throw new Error(reason) }

const VALIDATORS = {
  tailorResume(raw, ctx) {
    // Two trailing spaces are a Markdown line break, and qwen3 ends every line
    // with them. The DOCX writer strips them; a student should not learn them.
    const t = raw.split(/\r?\n/).map(l => l.trimEnd()).join('\n').trim()
    if (!t) refuse('empty')
    if (hasMarkdown(t)) refuse('markdown')
    if (t.length < ctx.resume.length * 0.5) refuse('much shorter than the résumé')
    // The prompt asks for one output line per input line, in the original order,
    // so the lines can be compared pairwise. (The DOCX writer copes with a moved
    // line, but rebuilds it with a neighbouring paragraph's formatting.)
    const before = contentLines(ctx.resume)
    const after = contentLines(t)
    if (before.length !== after.length) refuse(`changed the number of lines (${before.length} → ${after.length})`)
    // Say so when a line was moved: the pairwise checks below would otherwise
    // report whatever the shifted lines happen to trip first.
    const moved = after.find((line, i) => line !== before[i] && before.includes(line))
    if (moved) refuse(`moved a line out of order ("${moved.length > 60 ? `${moved.slice(0, 57)}…` : moved}")`)
    // Stricter than the app, because this is what a model learns to do: a
    // dropped metric weakens the résumé even though it invents nothing.
    after.forEach((line, i) => {
      const now = guard().figuresIn(line)
      const dropped = [...guard().figuresIn(before[i])].filter(f => !now.has(f))
      if (dropped.length) refuse(`dropped the figure "${dropped.join('", "')}"`)
    })
    refuseClaims(guard().inspectTailoring(ctx.resume, t))
    return t
  },
  generateCoverLetter(raw, ctx) {
    const t = raw.trim()
    if (t.length < 300) refuse('too short')
    if (hasMarkdown(t)) refuse('markdown')
    if (PLACEHOLDER_RE.test(t)) refuse(`unfilled placeholder ${t.match(PLACEHOLDER_RE)[0]}`)
    refuseClaims(guard().inspectCoverLetter(ctx.resume, t, { company: ctx.company, jobTitle: ctx.title }))
    return t
  },
  scoreMatch(raw) {
    const m = /^\s*(\d{1,3})\s*$/.exec(raw)
    if (!m || Number(m[1]) > 100) refuse('not a bare 0-100 score')
    return String(Number(m[1]))
  },
  scoreMatchWithExplanation(raw) {
    const v = parseLikeApp(raw)
    if (!Number.isInteger(v?.score) || v.score < 0 || v.score > 100) refuse('bad score')
    if (!isStr(v.explanation)) refuse('no explanation')
    return JSON.stringify({ score: v.score, explanation: v.explanation.trim() })
  },
  analyzeKeywordGap(raw) {
    const v = parseLikeApp(raw)
    const ok = (a) => Array.isArray(a) && a.every(isStr)
    if (!ok(v?.missing) || !ok(v?.present)) refuse('not { missing, present } string arrays')
    if (v.missing.length + v.present.length === 0) refuse('both lists empty')
    return JSON.stringify({ missing: v.missing, present: v.present })
  },
  generateTalkingPoints(raw) {
    const v = parseLikeApp(raw)
    if (!Array.isArray(v) || v.length < 3 || !v.every(isStr)) refuse('not an array of 3+ strings')
    return JSON.stringify(v)
  },
  generateInterviewQuestions(raw, ctx) {
    const v = parseLikeApp(raw)
    if (!Array.isArray(v) || v.length < 5) refuse('fewer than 5 questions')
    for (const q of v) {
      if (!isStr(q?.question) || !isStr(q?.answer)) refuse('a question without question/answer')
      if (!CATEGORIES.has(q.category)) refuse(`unknown category "${q.category}"`)
      refuseClaims(guard().inspectClaims(ctx.resume, q.answer))
    }
    return JSON.stringify(v.map(({ question, answer, category }) => ({ question, answer, category })))
  },
  answerScreeningQuestion(raw, ctx) {
    const t = raw.trim()
    if (!t) refuse('empty')
    if (t.length > 800) refuse('too long for a screening answer')
    refuseClaims(guard().inspectScreeningAnswer(ctx.resume, t))
    return t
  },
  draftInterviewAnswer(raw, ctx) {
    const t = raw.trim()
    if (!t) refuse('empty')
    if (hasMarkdown(t)) refuse('markdown')
    // The prompt's own way of declining. Its "X — Y" shape reads to the guard
    // as "title — employer", and it claims nothing, so it is not checked.
    if (t.startsWith("Your resume doesn't cover this")) return t
    if (t.length < 80) refuse('too short')
    refuseClaims(guard().inspectClaims(ctx.resume, t))
    return t
  },
  generateFollowUpQuestion(raw) {
    const t = raw.trim()
    if (!t) refuse('empty')
    if (t.length > 400) refuse('too long for one question')
    return t
  },
}

// ─── Inputs ─────────────────────────────────────────────────────────────

function readResumes(files) {
  return files.map(file => {
    const ext = path.extname(file).toLowerCase()
    if (!['.txt', '.md', ''].includes(ext)) {
      throw new Error(`${file}: only plain-text résumés are read. Save it as .txt (Hiro's Settings shows the text it uses).`)
    }
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text.length < 200) throw new Error(`${file}: that is too short to be a résumé.`)
    return { id: shortId(text, 8), text }
  })
}

function readBundle(file, passphrase) {
  const { readBundle: read } = require(path.join(SERVICES, 'dataTransfer'))
  const result = read(fs.readFileSync(file, 'utf8'), passphrase || '')
  if (!result.ok) {
    const hint = result.needsPassphrase ? ' Set HIRO_EXPORT_PASSPHRASE.' : ''
    throw new Error(`${file}: ${result.reason}${hint}`)
  }
  return result.bundle.data || {}
}

function jobsFromPath(p) {
  const stat = fs.statSync(p)
  if (stat.isDirectory()) {
    return fs.readdirSync(p).filter(f => /\.(txt|md)$/i.test(f)).sort().map(f => ({
      title: path.basename(f, path.extname(f)), company: '', description: fs.readFileSync(path.join(p, f), 'utf8'),
    }))
  }
  const text = fs.readFileSync(p, 'utf8')
  const rows = /\.jsonl$/i.test(p)
    ? text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
    : JSON.parse(text)
  if (!Array.isArray(rows)) throw new Error(`${p}: expected an array of jobs`)
  return rows.map(r => ({ title: r.title || r.job_title || '', company: r.company || '', description: r.description || r.job_description || '' }))
}

function collectJobs(bundleData, jobPaths) {
  const raw = [
    ...(bundleData.applications || []),
    ...(bundleData.attention_jobs || []),
  ].map(r => ({ title: r.job_title || '', company: r.company || '', description: r.job_description || '' }))
  for (const p of jobPaths) raw.push(...jobsFromPath(p))

  const seen = new Set()
  const jobs = []
  for (const j of raw) {
    const description = String(j.description || '').trim()
    if (description.length < MIN_JOB_CHARS) continue
    const id = shortId(description.replace(/\s+/g, ' ').toLowerCase())
    if (seen.has(id)) continue
    seen.add(id)
    jobs.push({ id, title: j.title, company: j.company, description })
  }
  return jobs
}

function loadQuestionBank() {
  const bank = JSON.parse(fs.readFileSync(QUESTION_BANK, 'utf8'))
  return (bank.questions || []).filter(q => isStr(q.question)).map(q => ({
    id: q.id, question: q.question.trim(), answer: htmlToText(q.answer),
  }))
}

// ─── The task list ──────────────────────────────────────────────────────

const JOB_OPS = [
  'tailorResume', 'generateCoverLetter', 'scoreMatch', 'scoreMatchWithExplanation',
  'analyzeKeywordGap', 'generateTalkingPoints', 'generateInterviewQuestions',
]
const TONES = ['', 'casual', 'confident']

function buildTasks({ jobs, resumes, screening = [], userAnswers = [], bank = [], evalFraction = DEFAULTS.evalFraction }) {
  const tasks = []
  const split = (unit) => (bucket(unit) < evalFraction ? 'eval' : 'train')
  const ai = () => require(path.join(SERVICES, 'ai', 'openai'))
  const primary = resumes[0]

  for (const job of jobs) {
    for (const r of resumes) {
      for (const op of JOB_OPS) {
        const tone = op === 'generateCoverLetter' ? pick(`${job.id}:${r.id}`, TONES) : undefined
        tasks.push({
          key: `${op}:${job.id}:${r.id}`, op, origin: 'teacher', split: split(`job:${job.id}`),
          ctx: { resume: r.text, company: job.company, title: job.title },
          meta: { job: job.id, resume: r.id, ...(tone ? { tone } : {}) },
          call: (key, flavour) => op === 'generateCoverLetter'
            ? ai().generateCoverLetter(job.description, r.text, key, flavour, tone || undefined)
            : ai()[op](job.description, r.text, key, flavour),
        })
      }
    }
  }

  // Screening questions are asked of a job, so each is paired with one. Which
  // one is fixed by the question, so a re-run builds the same prompt.
  for (const s of screening) {
    const job = jobs.length ? pick(`screening:${s.question}`, jobs) : null
    const r = pick(`screening-resume:${s.question}`, resumes)
    const base = {
      op: 'answerScreeningQuestion', split: split(`screening:${s.question}`), ctx: { resume: r.text },
      call: (key, flavour) => ai().answerScreeningQuestion(s.question, job ? job.description : '', r.text, key, flavour),
    }
    if (s.userAnswer) {
      tasks.push({ ...base, key: `answerScreeningQuestion:user:${shortId(s.question)}:${r.id}`, origin: 'user', reply: s.userAnswer, meta: { resume: r.id } })
    } else {
      tasks.push({ ...base, key: `answerScreeningQuestion:${shortId(s.question)}:${r.id}`, origin: 'teacher', meta: { job: job?.id, resume: r.id } })
    }
  }

  // The bank: an answer drafted from each résumé, and a follow-up probe on the
  // bank's own model answer. Half the drafts carry a job, as they do in the app
  // when practising for a specific application.
  for (const q of bank) {
    const unit = split(`bank:${q.id}`)
    for (const r of resumes) {
      const job = jobs.length && bucket(`with-job:${q.id}:${r.id}`) < 0.5 ? pick(`bank-job:${q.id}:${r.id}`, jobs) : null
      tasks.push({
        key: `draftInterviewAnswer:${q.id}:${r.id}`, op: 'draftInterviewAnswer', origin: 'teacher', split: unit,
        ctx: { resume: r.text }, meta: { question: q.id, resume: r.id, job: job?.id },
        call: (key, flavour) => ai().draftInterviewAnswer({ question: q.question, masterResume: r.text, jobDescription: job ? job.description : '' }, key, flavour),
      })
    }
    if (q.answer) {
      const job = jobs.length ? pick(`followup-job:${q.id}`, jobs) : null
      tasks.push({
        key: `generateFollowUpQuestion:${q.id}`, op: 'generateFollowUpQuestion', origin: 'teacher', split: unit,
        ctx: {}, meta: { question: q.id, job: job?.id },
        call: (key, flavour) => ai().generateFollowUpQuestion(q.question, q.answer, job ? job.description : '', key, flavour),
      })
    }
  }

  // The user's own interview answers: the best data there is, in their voice.
  for (const a of userAnswers) {
    tasks.push({
      key: `draftInterviewAnswer:user:${shortId(a.question)}`, op: 'draftInterviewAnswer', origin: 'user',
      split: split(`user-answer:${a.question}`), reply: a.answer, ctx: { resume: primary.text }, meta: { resume: primary.id },
      call: (key, flavour) => ai().draftInterviewAnswer({ question: a.question, masterResume: primary.text }, key, flavour),
    })
  }

  return tasks
}

function userData(bundleData) {
  const mine = (rows) => (rows || []).filter(r => r.source === 'user' && isStr(r.question) && isStr(r.answer))
  return {
    userAnswers: mine(bundleData.interview_answers)
      .filter(r => r.answer.trim().length >= 40)
      .map(r => ({ question: r.question.trim(), answer: r.answer.trim() })),
    screening: (bundleData.screening_cache || [])
      .filter(r => isStr(r.question))
      .map(r => ({ question: r.question.trim(), userAnswer: r.source === 'user' && isStr(r.answer) ? r.answer.trim() : '' })),
  }
}

// ─── Running ────────────────────────────────────────────────────────────

function readDoneKeys(outDir) {
  const done = new Set()
  for (const name of ['train.jsonl', 'eval.jsonl']) {
    const file = path.join(outDir, name)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { done.add(JSON.parse(line).meta.key) } catch { /* a torn last line from a killed run */ }
    }
  }
  return done
}

const estimateTokens = (messages) => Math.ceil(messages.reduce((n, m) => n + String(m.content).length, 0) / 4)

async function runTask(task, { apiKey, flavour, dryRun }) {
  const slot = {}
  if (task.origin === 'user') slot.reply = task.reply
  else if (dryRun) slot.reply = ''
  let error = null
  try {
    await capture.run(slot, () => task.call(apiKey, flavour))
  } catch (err) {
    error = err // the app's own parsing may throw on output the validator also refuses
  }
  // The prompt is recorded before the request goes out, so a request that
  // failed still has messages; it is the missing reply that marks it.
  if (!slot.messages || slot.output === undefined) return { status: 'failed', error }
  if (dryRun && task.origin !== 'user') return { status: 'dry', slot }
  // The user's own words are the ground truth, not a claim to check against
  // the résumé: they may well know something about themselves it leaves out.
  if (task.origin === 'user') return { status: 'ok', target: String(slot.output).trim(), slot }
  if (slot.finish === 'length') return { status: 'rejected', reason: 'cut off at max_tokens', slot }
  try {
    const target = VALIDATORS[task.op](slot.output, task.ctx)
    return { status: 'ok', target, slot }
  } catch (err) {
    return { status: 'rejected', reason: err.message, slot }
  }
}

async function run(opts, log = console.log) {
  const resumes = readResumes(opts.resume)
  const bundleData = opts.export ? readBundle(opts.export, process.env.HIRO_EXPORT_PASSPHRASE) : {}
  const jobs = collectJobs(bundleData, opts.jobs)
  const { userAnswers, screening } = userData(bundleData)
  const bank = opts.noBank ? [] : loadQuestionBank()

  log(`Inputs: ${resumes.length} résumé(s), ${jobs.length} job(s), ${bank.length} bank question(s), ` +
      `${screening.length} screening question(s), ${userAnswers.length} answer(s) of your own`)
  if (!jobs.length) log('No job descriptions — only interview-practice examples can be built. Pass --export or --jobs for the rest.')

  installRecorder()
  const all = buildTasks({ jobs, resumes, screening, userAnswers, bank, evalFraction: opts.evalFraction })
  if (!opts.dryRun) fs.mkdirSync(opts.out, { recursive: true })
  const done = readDoneKeys(opts.out)
  const pending = all.filter(t => !done.has(t.key))
  if (done.size) log(`${done.size} example(s) already in ${opts.out}; skipping them.`)

  const apiKey = opts.dryRun ? 'dry-run' : (process.env.TEACHER_API_KEY || process.env.DEEPSEEK_API_KEY || '')
  if (!apiKey && pending.some(t => t.origin === 'teacher')) {
    throw new Error('Set TEACHER_API_KEY (or DEEPSEEK_API_KEY) to the teacher model\'s key, or use --dry-run.')
  }
  const flavour = {
    baseURL: opts.teacherUrl,
    provider: /deepseek/i.test(opts.teacherUrl) ? 'deepseek' : 'local',
    model: opts.teacherModel,
  }

  // User answers first: they cost nothing and are worth the most.
  pending.sort((a, b) => (a.origin === 'user' ? 0 : 1) - (b.origin === 'user' ? 0 : 1))
  let teacherBudget = opts.limit
  const queue = pending.filter(t => t.origin === 'user' || teacherBudget-- > 0)

  const stats = {}
  const bump = (op, k) => { (stats[op] ||= { ok: 0, rejected: 0, failed: 0, dry: 0 })[k]++ }
  const reasons = {}
  let tokensIn = 0
  let tokensOutCap = 0
  let finished = 0
  let fatal = null

  const write = (task, slot, target) => {
    const record = {
      messages: [...slot.messages, { role: 'assistant', content: target }],
      meta: { key: task.key, op: task.op, origin: task.origin, ...(task.origin === 'teacher' ? { teacher: opts.teacherModel } : {}), ...task.meta },
    }
    fs.appendFileSync(path.join(opts.out, `${task.split}.jsonl`), JSON.stringify(record) + '\n')
  }

  let next = 0
  async function worker() {
    while (next < queue.length && !fatal) {
      const task = queue[next++]
      const result = await runTask(task, { apiKey, flavour, dryRun: opts.dryRun })
      finished++
      bump(task.op, result.status)
      if (result.slot?.messages) {
        tokensIn += estimateTokens(result.slot.messages)
        tokensOutCap += result.slot.maxTokens || 0
      }
      if (result.status === 'ok' && !opts.dryRun) write(task, result.slot, result.target)
      if (result.status === 'rejected') {
        const r = `${task.op}: ${result.reason}`
        reasons[r] = (reasons[r] || 0) + 1
      }
      if (result.status === 'failed') {
        const status = result.error?.status
        // A key the teacher refuses will be refused for every task after it.
        if (status === 401 || status === 403) fatal = result.error
        else log(`  ${task.key} failed: ${result.error?.message || 'no request was made'}`)
      }
      if (!opts.dryRun && (finished % 10 === 0 || finished === queue.length)) {
        log(`  ${finished}/${queue.length}`)
      }
    }
  }
  const workers = Math.max(1, Math.min(opts.concurrency, queue.length))
  await Promise.all(Array.from({ length: workers }, worker))
  if (fatal) throw new Error(`The teacher refused the key (${fatal.status}): ${fatal.message}`)

  log('')
  for (const [op, s] of Object.entries(stats).sort()) {
    log(`  ${op.padEnd(28)} ${opts.dryRun ? `${s.dry + s.ok} prompt(s)` : `${s.ok} kept, ${s.rejected} refused, ${s.failed} failed`}`)
  }
  for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10)) log(`  refused ×${n}  ${r}`)
  const skipped = pending.length - queue.length
  if (skipped > 0) log(`\n${skipped} teacher call(s) left for later (--limit). Run again to continue.`)
  log(`\n≈${Math.round(tokensIn / 1000)}k input tokens, ≤${Math.round(tokensOutCap / 1000)}k output tokens ${opts.dryRun ? 'would be sent' : 'sent'} to ${opts.teacherModel}.`)
  if (!opts.dryRun) log(`Written to ${path.resolve(opts.out)} (train.jsonl, eval.jsonl).`)
  return { stats, reasons, queued: queue.length, skipped }
}

// ─── CLI ────────────────────────────────────────────────────────────────

const USAGE = `Usage: node scripts/generate-training-data.js --resume <file> [options]

  --resume <file>         plain-text résumé (repeatable)
  --export <file>         Hiro data export; passphrase in HIRO_EXPORT_PASSPHRASE
  --jobs <path>           folder of .txt job ads, or .json/.jsonl (repeatable)
  --out <dir>             output folder (default: ${DEFAULTS.out})
  --teacher-url <url>     OpenAI-compatible endpoint (default: ${DEFAULTS.teacherUrl})
  --teacher-model <id>    (default: ${DEFAULTS.teacherModel})
  --concurrency <n>       parallel teacher calls (default: ${DEFAULTS.concurrency})
  --eval-fraction <f>     share of jobs/questions held out (default: ${DEFAULTS.evalFraction})
  --limit <n>             stop after n teacher calls this run
  --no-bank               leave out the practice question bank
  --dry-run               build every prompt, call nothing, report counts

Key for the teacher: TEACHER_API_KEY (or DEEPSEEK_API_KEY).`

function parseArgs(argv) {
  const opts = { ...DEFAULTS, resume: [], jobs: [], export: '', dryRun: false, noBank: false }
  const number = (flag, v, min) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min) throw new Error(`${flag} needs a number ≥ ${min}`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--resume': opts.resume.push(value()); break
      case '--jobs': opts.jobs.push(value()); break
      case '--export': opts.export = value(); break
      case '--out': opts.out = value(); break
      case '--teacher-url': opts.teacherUrl = value().replace(/\/+$/, ''); break
      case '--teacher-model': opts.teacherModel = value(); break
      case '--concurrency': opts.concurrency = Math.floor(number(flag, value(), 1)); break
      case '--eval-fraction': opts.evalFraction = number(flag, value(), 0); break
      case '--limit': opts.limit = Math.floor(number(flag, value(), 0)); break
      case '--no-bank': opts.noBank = true; break
      case '--dry-run': opts.dryRun = true; break
      case '-h': case '--help': opts.help = true; break
      default: throw new Error(`Unknown option ${flag}`)
    }
  }
  if (opts.evalFraction >= 1) throw new Error('--eval-fraction must be below 1')
  if (!opts.help && !opts.resume.length) throw new Error('At least one --resume is required.')
  return opts
}

async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) { console.log(USAGE); return 0 }

  // A throwaway profile, before any service loads: the run's usage rows, logs
  // and config must not land in the user's real one.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-training-'))
  process.env.HIRO_CONFIG_DIR = profile
  try {
    await run(opts)
    return 0
  } catch (err) {
    console.error(err.message)
    return 1
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code })
}

module.exports = { main, run, parseArgs, buildTasks, collectJobs, userData, htmlToText, VALIDATORS, installRecorder }
