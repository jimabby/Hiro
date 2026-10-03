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

  // ── Needs Attention submits the drafts it showed ────────────────
  // The page displays the résumé and cover letter drafted when the job was
  // found. Applying used to write new ones, so what went to the employer was
  // not what the user had read — and both were paid for.
  db.insertAttentionJob({
    ...job('drafted', 'Drafted Co'), platform: 'Seek', job_description: 'Build APIs.', match_score: 90,
    tailored_resume: 'Jane Example\nSoftware Engineer at Acme\nThe version the user read',
    cover_letter: 'Dear Drafted Co, the letter the user read.',
  })
  const drafted = db.getAttentionJobs().find(row => row.company === 'Drafted Co')
  let tailorCalls = 0
  let letterCalls = 0
  ai.tailorResume = async (_p, _k, _j, resume) => { tailorCalls++; return resume }
  const priorLetter = ai.generateCoverLetter
  ai.generateCoverLetter = async () => { letterCalls++; return 'A brand new letter' }
  let sent = null
  seek.apply = async (_url, resume, letter) => { sent = { resume, letter }; return { success: true, screeningQa: [] } }
  await applicator.applyAttentionJob(drafted.id, baseCfg, () => {})
  check('the stored resume is not regenerated', tailorCalls, 0)
  check('the stored cover letter is not regenerated', letterCalls, 0)
  check('the resume the user read is the one sent', sent?.resume.includes('The version the user read'), true)
  check('the letter the user read is the one sent', sent?.letter, 'Dear Drafted Co, the letter the user read.')
  ai.generateCoverLetter = priorLetter

  // ── Only a skipped job can be applied to "anyway" ───────────────
  const already = db.getApplications().find(row => row.company === 'Drafted Co')
  let resubmitted = false
  seek.apply = async () => { resubmitted = true; return { success: true, screeningQa: [] } }
  const refused = await applicator.applySkippedJob(already.id, baseCfg, () => {})
  check('an application already sent is refused', refused.success, false)
  check('and nothing is submitted again', resubmitted, false)

  // ── Excluded keywords cost nothing ──────────────────────────────
  // A listing ruled out by the user's own "never" list must not reach the
  // description fetch, let alone the scorer.
  const senior = { ...job('senior'), job_title: 'Senior Software Engineer' }
  const plain = job('plain-title')
  jobs = [senior, plain]
  let fetched = []
  seek.getJobDescription = async (url) => { fetched.push(url); return 'Build reliable software.' }
  scoreCalls = 0
  ai.scoreMatchWithExplanation = async () => { scoreCalls++; return { score: 90, explanation: 'Strong.' } }
  seek.apply = async () => ({ success: true, screeningQa: [] })
  await applicator.run({ ...baseCfg, dailyLimitSeek: 50, excludeKeywords: 'senior, clearance' }, { log: () => {}, notifyAttention: () => {} })
  check('an excluded title is never fetched', fetched.includes(senior.job_url), false)
  check('an excluded title is never scored', scoreCalls, 1)
  check('an excluded title is not saved', db.hasSeenJobUrl(senior.job_url), false)
  check('other listings still go through', db.hasSeenJobUrl(plain.job_url), true)

  // ── Work-arrangement preference ─────────────────────────────────
  const onsite = job('onsite-role')
  const remote = job('remote-role')
  const silent = job('silent-role')
  jobs = [onsite, remote, silent]
  const descriptions = {
    [onsite.job_url]: 'This is an office-based role, five days in our Sydney office.',
    [remote.job_url]: 'Fully remote within Australia.',
    [silent.job_url]: 'Build reliable software.',
  }
  fetched = []
  seek.getJobDescription = async (url) => { fetched.push(url); return descriptions[url] }
  scoreCalls = 0
  await applicator.run({ ...baseCfg, dailyLimitSeek: 50, workArrangement: 'remote' }, { log: () => {}, notifyAttention: () => {} })
  check('an on-site job is not scored when remote is required', db.hasSeenJobUrl(onsite.job_url), false)
  check('a remote job is scored', db.hasSeenJobUrl(remote.job_url), true)
  check('a job that never says is kept', db.hasSeenJobUrl(silent.job_url), true)
  check('only the two eligible jobs reached the scorer', scoreCalls, 2)
  fetched = []
  jobs = [onsite]
  await applicator.run({ ...baseCfg, dailyLimitSeek: 50, workArrangement: 'remote' }, { log: () => {}, notifyAttention: () => {} })
  check('a job turned away is not fetched again this session', fetched.length, 0)
  seek.getJobDescription = async () => 'Build reliable software.'

  // ── Editing a held draft ────────────────────────────────────────
  ai.tailorResume = async () => 'Jane Example\nSoftware Engineer at Acme\nAWS Certified Solutions Architect'
  jobs = [job('to-edit')]
  await applicator.run({ ...baseCfg, dailyLimitSeek: 50 }, { log: () => {}, notifyAttention: () => {} })
  const heldDraft = db.getApplications().find(row => row.job_url === job('to-edit').job_url)
  check('the invented credential holds the draft', heldDraft.status, 'held')
  const stillFlagged = applicator.editHeldDraft(heldDraft.id, {
    tailoredResume: 'Jane Example\nSoftware Engineer at Acme\nAWS Certified Solutions Architect\nTeam player',
  })
  check('an edit that keeps the claim is saved', stillFlagged.success, true)
  check('and the claim is still flagged', stillFlagged.flags.some(f => f.kind === 'credential'), true)
  const cleared = applicator.editHeldDraft(heldDraft.id, {
    tailoredResume: 'Jane Example\nSoftware Engineer at Acme\nTeam player',
    coverLetter: 'Dear team, a letter I wrote myself.',
  })
  check('an edit that removes the claim clears the flag', cleared.flags.length, 0)
  const edited = db.getApplication(heldDraft.id)
  check('the edited resume is what approval will send', edited.tailored_resume.includes('AWS'), false)
  check('the edited letter is stored', edited.cover_letter, 'Dear team, a letter I wrote myself.')
  check('the draft is still held until approved', edited.status, 'held')
  check('the edit is frozen as its own version', db.getSnapshots(heldDraft.id).some(snap => snap.reason === 'edited'), true)
  const sentRow = db.getApplications().find(row => row.status === 'applied')
  check('a sent application cannot be edited', applicator.editHeldDraft(sentRow.id, { tailoredResume: 'x' }).success, false)
  ai.tailorResume = async (_p, _k, _j, resume) => resume

  // ── Bulk runs can be stopped ────────────────────────────────────
  check('stopping with nothing running says so', applicator.cancelBulk().success, false)
  const bulkIds = []
  for (const id of ['bulk-a', 'bulk-b', 'bulk-c']) {
    db.insertAttentionJob({ ...job(id, `Bulk ${id}`), platform: 'Seek', job_description: 'Build APIs.', match_score: 90 })
    bulkIds.push(db.getAttentionJobs().find(row => row.company === `Bulk ${id}`).id)
  }
  let bulkApplies = 0
  seek.apply = async () => {
    bulkApplies++
    // The user presses Stop while the first submission is in flight.
    if (bulkApplies === 1) check('stopping a running bulk retry is accepted', applicator.cancelBulk().success, true)
    return { success: true, screeningQa: [] }
  }
  const bulk = await applicator.applyAttentionJobs(bulkIds, baseCfg, () => {})
  check('the job in hand is finished', bulkApplies, 1)
  check('the rest are not attempted', bulk.results.length, 1)
  check('the run reports that it stopped early', bulk.stopped, true)

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
