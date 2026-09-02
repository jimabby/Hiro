// The smart-schedule batch limit, and the outcomes it has to count.
//
// The batch limit exists to bound how much work one batch does. It started life
// counting successful submissions, which meant a batch of 3 where every apply
// failed never reached its limit and walked the entire scrape set instead — so
// it was changed to count ATTEMPTED submissions.
//
// That still missed every path that costs exactly the same and never submits: a
// draft held for review, a career-board match routed to Needs Attention, a
// document the fabrication guard stopped. With review-before-submit on — the
// app's safest setting — nothing is ever submitted, so nothing ever incremented
// the counter, and a smart-schedule batch of 3 quietly drafted its way through
// the whole scrape set in one sitting. The identical failure by another route.
//
// So the rule this suite pins: a job counts once it has consumed the drafting
// spend, however it ends. A job discarded below the match threshold does not —
// it costs one scoring call and stops, and bounding those would turn the batch
// limit into a cap on scanning rather than on work.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-batch-limit-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { automationCooldowns: {} }
stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => ({ ...config }),
    update: patch => {
      config = typeof patch === 'function' ? patch({ ...config }) : { ...config, ...patch }
      return config
    },
  },
  './logger': { append: () => {} },
  './scraper/utils': { randomDelay: async () => {}, stripMarkdown: value => String(value || '') },
})

const db = service('database')
const seek = service('scraper/seek')
const ats = service('scraper/ats')
const ai = service('ai/index')
const applicator = service('applicator')
const { check, done } = createChecker()

const RESUME = 'Jane Example\nSoftware Engineer at Acme\nBuilt data pipelines'

const baseCfg = {
  aiProvider: 'test', aiApiKey: 'key', masterResume: RESUME,
  resumes: [{ id: 'general', name: 'General', text: RESUME }],
  defaultResumeId: 'general', matchThreshold: 70, companyCooldownDays: 0,
  enableSeek: true, enableIndeed: false, enableLinkedIn: false, enableAtsBoards: false,
  // High enough that the DAILY limits never fire — this suite is about the
  // per-batch bound, and a daily limit stopping the run first would make the
  // test pass for the wrong reason.
  dailyLimitSeek: 1000, dailyLimitAts: 1000, dailyDraftLimit: 0,
  extractRecruiterEmail: false,
}

let seq = 0
const job = () => {
  seq += 1
  return {
    job_title: `Software Engineer ${seq}`,
    company: `Company ${seq}`,
    salary: '',
    job_url: `https://example.test/jobs/${seq}`,
  }
}

function tenJobs() {
  return Array.from({ length: 10 }, () => job())
}

async function main() {
  await db.init()

  let tailorCalls = 0
  seek.getJobDescription = async () => 'Build reliable software with data pipelines.'
  seek.apply = async () => ({ success: true, screeningQa: [] })
  ai.scoreMatchWithExplanation = async () => ({ score: 90, explanation: 'Strong.' })
  ai.tailorResume = async (_p, _k, _j, resume) => { tailorCalls++; return resume }
  ai.generateCoverLetter = async () => 'Hello'
  ai.generateTalkingPoints = async () => []

  // ── Submissions ────────────────────────────────────────────────
  // The behaviour that already worked, kept honest.
  seek.scrape = async () => tenJobs()
  tailorCalls = 0
  let result = await applicator.run(
    { ...baseCfg, batchLimit: 3, reviewBeforeSubmit: false },
    { log: () => {}, notifyAttention: () => {} })
  check('a batch of 3 submits 3', result.applied, 3)
  check('and drafts documents for exactly those 3', tailorCalls, 3)

  // ── Held for review ────────────────────────────────────────────
  // The case that was unbounded. Nothing is submitted, so under the old rule
  // nothing counted and the batch ran to the end of the scrape set.
  seek.scrape = async () => tenJobs()
  tailorCalls = 0
  result = await applicator.run(
    // No auto-submit threshold, so every scored job is held.
    { ...baseCfg, batchLimit: 3, reviewBeforeSubmit: true, autoSubmitThreshold: null },
    { log: () => {}, notifyAttention: () => {} })
  check('a batch of 3 in review mode holds 3', result.held, 3)
  check('and stops there rather than drafting all ten', tailorCalls, 3)
  check('having submitted nothing', result.applied, 0)

  // ── Career boards, which have no submit step at all ────────────
  seek.scrape = async () => []
  ats.scrape = async () => tenJobs()
  ats.getJobDescription = async () => 'Build reliable software with data pipelines.'
  ats.primeDescriptions = () => {}
  tailorCalls = 0
  result = await applicator.run(
    {
      ...baseCfg, batchLimit: 3, reviewBeforeSubmit: false,
      enableSeek: false, enableAtsBoards: true,
      atsBoards: [{ id: 'b1', provider: 'greenhouse', slug: 'acme', label: 'Acme' }],
    },
    { log: () => {}, notifyAttention: () => {} })
  check('a career-board batch of 3 drafts 3', tailorCalls, 3)

  // ── Below the threshold does NOT count ─────────────────────────
  // These cost one scoring call and stop. Counting them would make the batch
  // limit a cap on how much can be SCANNED, which is a different setting and
  // one the user did not ask for.
  ai.scoreMatchWithExplanation = async () => ({ score: 10, explanation: 'Weak.' })
  seek.scrape = async () => tenJobs()
  ats.scrape = async () => []
  tailorCalls = 0
  result = await applicator.run(
    { ...baseCfg, batchLimit: 3, reviewBeforeSubmit: false, enableSeek: true, enableAtsBoards: false },
    { log: () => {}, notifyAttention: () => {} })
  check('low-scoring jobs are all considered', result.found, 10)
  check('and none of them cost a tailoring call', tailorCalls, 0)
  check('and none of them are submitted', result.applied, 0)

  // ── No batch limit means no bound ──────────────────────────────
  // A full scheduled scan is not a batch, and must not acquire one by accident.
  ai.scoreMatchWithExplanation = async () => ({ score: 90, explanation: 'Strong.' })
  seek.scrape = async () => tenJobs()
  tailorCalls = 0
  result = await applicator.run(
    { ...baseCfg, reviewBeforeSubmit: true, autoSubmitThreshold: null },
    { log: () => {}, notifyAttention: () => {} })
  check('a scan with no batch limit drafts everything it found', result.held, 10)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
