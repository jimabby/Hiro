// End-to-end scan-loop coverage: limits, dedupe, budget stops, fabrication
// holds, and manual retry attribution all cross service boundaries.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-applicator-loop-'))
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
const ai = service('ai/index')
const applicator = service('applicator')
const { check, done } = createChecker()

const baseCfg = {
  aiProvider: 'test', aiApiKey: 'key', masterResume: 'Jane Example\nSoftware Engineer at Acme',
  resumes: [{ id: 'general', name: 'General', text: 'Jane Example\nSoftware Engineer at Acme' }],
  defaultResumeId: 'general', matchThreshold: 70, companyCooldownDays: 0,
  enableSeek: true, enableIndeed: false, enableLinkedIn: false, enableAtsBoards: false,
  dailyLimitSeek: 1, extractRecruiterEmail: false,
}

const job = (id, company = `Company ${id}`) => ({
  job_title: 'Software Engineer', company, salary: '',
  job_url: `https://example.test/jobs/${id}`,
})

async function main() {
  await db.init()
  let jobs = [job('one'), job('two')]
  let scoreCalls = 0
  let applyCalls = 0
  seek.scrape = async () => jobs
  seek.getJobDescription = async () => 'Build reliable software.'
  seek.apply = async () => { applyCalls++; return { success: true, screeningQa: [] } }
  ai.scoreMatchWithExplanation = async () => { scoreCalls++; return { score: 90, explanation: 'Strong.' } }
  ai.tailorResume = async (_p, _k, _j, resume) => resume
  ai.generateCoverLetter = async () => 'Hello'

  await applicator.run(baseCfg, { log: () => {}, notifyAttention: () => {} })
  check('daily limit allows only one submission', applyCalls, 1)
  check('daily limit stops before scoring the second job', scoreCalls, 1)

  await applicator.run({ ...baseCfg, dailyLimitSeek: 10 }, { log: () => {}, notifyAttention: () => {} })
  check('dedupe prevents rescoring the already-seen job', scoreCalls, 2)
  check('the unseen job is still processed', applyCalls, 2)

  jobs = [job('budget')]
  ai.scoreMatchWithExplanation = async () => { const err = new Error('Budget reached'); err.budgetExceeded = true; throw err }
  const stopped = await applicator.run({ ...baseCfg, dailyLimitSeek: 10 }, { log: () => {}, notifyAttention: () => {} })
  check('budget exhaustion stops the scan', stopped.budgetStopped, true)
  check('budget-stopped job remains unseen for retry', db.hasSeenJobUrl(job('budget').job_url), false)

  jobs = [job('fabricated')]
  ai.scoreMatchWithExplanation = async () => ({ score: 95, explanation: 'Strong.' })
  ai.tailorResume = async () => 'Jane Example\nSoftware Engineer at Acme\nAWS Certified Solutions Architect'
  await applicator.run({ ...baseCfg, dailyLimitSeek: 10 }, { log: () => {}, notifyAttention: () => {} })
  const held = db.getApplications().find(row => row.job_url === job('fabricated').job_url)
  check('fabricated credential forces a held row', held.status, 'held')
  check('fabrication flag is persisted', JSON.parse(held.fabrication_flags)[0].kind, 'credential')
  check('fabricated resume was never submitted', applyCalls, 2)

  db.insertAttentionJob({ ...job('manual', 'Manual Co'), platform: 'Seek', job_description: 'Build APIs.', match_score: 88 })
  const attention = db.getAttentionJobs().find(row => row.company === 'Manual Co')
  ai.tailorResume = async (_p, _k, _j, resume) => resume
  const confirmSubmit = async () => true
  let receivedConfirm = null
  seek.apply = async (_url, _resume, _letter, cfg) => {
    receivedConfirm = cfg.confirmSubmit
    return { success: true, screeningQa: [] }
  }
  await applicator.applyAttentionJob(attention.id, { ...baseCfg, confirmSubmit }, () => {})
  const manual = db.getApplications().find(row => row.company === 'Manual Co')
  check('manual retry records resume id', manual.resume_id, 'general')
  check('manual retry records resume name', manual.resume_name, 'General')
  const manualSnapshot = db.getSnapshot(db.getSnapshots(manual.id)[0].id)
  check('manual retry snapshot keeps the base resume', manualSnapshot.base_resume.includes('Jane Example'), true)
  check('manual retry forwards the confirmation callback', receivedConfirm === confirmSubmit, true)

  // ── A pause is not a block ──────────────────────────────────────
  // Both mean missing results, but only one is a fault. Reporting a cooldown
  // through `blocked` put a self-imposed back-off down the failure channel: a
  // "Scan did not complete" push and a red banner for the system working.
  const health = service('automationHealth')
  health.startCooldown('Seek', 'blocked')
  jobs = [job('paused')]
  let scrapedWhilePaused = false
  seek.scrape = async () => { scrapedWhilePaused = true; return jobs }
  const pausedRun = await applicator.run({ ...baseCfg, dailyLimitSeek: 10 }, { log: () => {}, notifyAttention: () => {} })
  check('a cooled-down platform is not scraped', scrapedWhilePaused, false)
  check('the pause is reported', pausedRun.paused.length, 1)
  check('the pause names the platform', pausedRun.paused[0].platform, 'Seek')
  check('the pause carries its reason', pausedRun.paused[0].reason, 'blocked')
  check('a pause is NOT reported as a block', pausedRun.blocked.length, 0)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
