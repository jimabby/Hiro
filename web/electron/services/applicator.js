const seek = require('./scraper/seek')
const indeed = require('./scraper/indeed')
const linkedin = require('./scraper/linkedin')
const aiAdapter = require('./ai/index')
const database = require('./database')
const { randomDelay, stripMarkdown } = require('./scraper/utils')
const { parseClosingDate } = require('./dateParser')

// Pick the resume to use for a given job. A rule matches when any of its
// comma-separated keywords appears in the job title or description; the first
// matching rule wins, so ordering in Settings is the precedence. Falls back to
// the configured default resume, then the master resume.
function selectResume(cfg, job) {
  const resumes = Array.isArray(cfg.resumes) ? cfg.resumes : []
  const rules = Array.isArray(cfg.resumeRules) ? cfg.resumeRules : []
  const haystack = `${job?.job_title || ''}\n${job?.job_description || ''}`.toLowerCase()

  for (const rule of rules) {
    if (!rule?.resumeId || !rule?.keywords) continue
    const keywords = String(rule.keywords).split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    if (keywords.length === 0) continue
    if (!keywords.some(k => haystack.includes(k))) continue
    const match = resumes.find(r => r.id === rule.resumeId)
    if (match) return { resume: match, ruleKeywords: keywords.join(', ') }
  }
  return { resume: resumes.find(r => r.id === cfg.defaultResumeId) || null, ruleKeywords: null }
}

// Merge the chosen resume into the config the scrapers read.
function withResume(cfg, job, log) {
  const { resume, ruleKeywords } = selectResume(cfg, job)
  if (ruleKeywords && log) log(`  Resume rule matched (${ruleKeywords}) → "${resume.name || resume.id}"`)
  return {
    ...cfg,
    masterResume: resume?.text || cfg.masterResume || '',
    activeResumeOriginalPath: resume?.originalPath,
    activeResumeOriginalExt: resume?.originalExt,
  }
}

let cancelled = false

// Only one apply flow (scheduled scan, batch, or manual apply) may run at a
// time: they share the screening-question prompt and browser resources, and a
// manual apply mid-scan would interleave with the scan's own submissions.
let busy = false

function isBusy() {
  return busy
}

function cancel() {
  cancelled = true
}

async function run(cfg, callbacks) {
  if (busy) throw new Error('Another scan or apply is already in progress')
  busy = true
  try {
    return await doRun(cfg, callbacks)
  } finally {
    busy = false
  }
}

async function doRun(cfg, { log, notifyAttention }) {
  cancelled = false

  // Baseline resume — per-job routing rules may override this later, once the
  // job description is available to match against.
  cfg = withResume(cfg, null)

  const scrapers = []
  if (cfg.enableSeek) scrapers.push({ name: 'Seek', scraper: seek, limit: cfg.dailyLimitSeek })
  if (cfg.enableIndeed) scrapers.push({ name: 'Indeed', scraper: indeed, limit: cfg.dailyLimitIndeed })
  if (cfg.enableLinkedIn) scrapers.push({ name: 'LinkedIn', scraper: linkedin, limit: cfg.dailyLimitLinkedIn })

  let batchCount = 0
  let dryWouldApply = 0
  // Every score a dry run produced, so the caller can recommend a threshold
  // from the real distribution rather than guesswork.
  const dryScores = []
  // Platforms that refused to serve results this run (CAPTCHA, rate limit,
  // expired login). Reported in the summary so the caller can tell "blocked"
  // apart from "nothing found".
  const blocked = []
  const batchLimit = cfg.batchLimit || Infinity // smart scheduling passes a finite limit
  const summary = () => (cfg.dryRun
    ? { dryRun: true, scores: dryScores, wouldApply: dryWouldApply, threshold: cfg.matchThreshold, blocked }
    : { dryRun: false, applied: batchCount, blocked })

  for (const { name, scraper, limit } of scrapers) {
    if (cancelled || batchCount >= batchLimit) { if (cancelled) log('Scan cancelled.'); return summary() }

    log(`Scanning ${name}...`)

    // Dry run ignores daily limits so every found job gets scored for tuning.
    const todayCount = database.getTodayCountByPlatform(name)
    if (!cfg.dryRun && todayCount >= limit) {
      log(`${name}: daily limit reached (${todayCount}/${limit}). Skipping.`)
      continue
    }

    let jobs
    try {
      jobs = await scraper.scrape(cfg)
      log(`${name}: found ${jobs.length} jobs across ${cfg.scrapePages || 1} page(s)`)
      // A successful scrape that finds nothing is worth saying out loud — it's
      // the signal that the search is too narrow or has been exhausted.
      if (jobs.length === 0) {
        log(`${name}: no listings matched. Widen the keywords or location if this persists.`)
      }
    } catch (err) {
      if (err.blocked) {
        // Distinct from an empty result set, and distinct from a selector
        // change: the site actively refused us. Surface it so the user knows to
        // back off or re-authenticate rather than assuming there are no jobs.
        blocked.push({ platform: name, kind: err.kind, message: err.message })
        log(`${name}: BLOCKED — ${err.message}`)
      } else {
        log(`${name}: scrape error — ${err.message}`)
      }
      continue
    }

    const blacklist = (cfg.blacklistedCompanies || []).map(c => c.toLowerCase())
    const filtered = jobs.filter(j => !blacklist.includes(j.company.toLowerCase()))

    for (const job of filtered) {
      if (cancelled || batchCount >= batchLimit) { if (cancelled) log('Scan cancelled.'); return summary() }

      const currentCount = database.getTodayCountByPlatform(name)
      if (!cfg.dryRun && currentCount >= limit) break

      // Skip already-seen jobs (applied or skipped)
      if (database.hasJobUrl(job.job_url)) continue

      // Skip companies applied to inside the cooldown window. This is a
      // rate-limit on spamming one employer, not a permanent ban — see
      // findRecentApplicationToCompany.
      const recent = database.findRecentApplicationToCompany(job.company, cfg.companyCooldownDays)
      if (recent) {
        log(`  Skipping ${job.company} — applied to "${recent.job_title}" within the last ${cfg.companyCooldownDays} days`)
        continue
      }

      const crossPlatformDuplicate = database.findDuplicateAcrossPlatforms(job.job_title, job.company, name)
      if (crossPlatformDuplicate) {
        log(`  Duplicate: already applied via ${crossPlatformDuplicate.platform} — skipping`)
        continue
      }

      log(`Processing: ${job.job_title} at ${job.company}`)

      // Get full job description
      let jobDescription = ''
      try {
        jobDescription = await scraper.getJobDescription(job.job_url)
        await randomDelay(1000, 2000)
      } catch (err) {
        log(`  Could not fetch job description: ${err.message}`)
      }

      job.job_description = jobDescription
      // Application deadline, if the ad states one. Best-effort: null just
      // means "unknown", and the user can set it by hand later.
      job.closing_date = parseClosingDate(jobDescription)
      if (job.closing_date) log(`  Closes ${job.closing_date}`)

      // Now that the description is known, routing rules can pick a resume
      // tailored to this specific job.
      const jobCfg = withResume(cfg, job, log)

      if (cancelled) { log('Scan cancelled.'); return summary() }

      // Score match
      let matchScore = 50
      let matchExplanation = ''
      try {
        const matchResult = await aiAdapter.scoreMatchWithExplanation(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription || job.job_title, jobCfg.masterResume, jobCfg.geminiModel)
        matchScore = matchResult.score
        matchExplanation = matchResult.explanation
        log(`  Match score: ${matchScore}%`)
      } catch (err) {
        log(`  Scoring error: ${err.message}`)
      }

      job.match_score = matchScore
      job.match_explanation = matchExplanation

      // Dry run: report the score and whether it would apply, optionally verify
      // tailoring, then move on without submitting or writing to the database.
      if (cfg.dryRun) {
        const pass = matchScore >= cfg.matchThreshold
        dryScores.push({ score: matchScore, job_title: job.job_title, company: job.company, platform: name })
        log(`  DRY RUN — ${pass ? 'WOULD APPLY' : 'would skip'}: score ${matchScore}% (threshold ${cfg.matchThreshold}%)`)
        if (pass) {
          dryWouldApply++
          try {
            await aiAdapter.tailorResume(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription, jobCfg.masterResume, jobCfg.geminiModel)
            log('    resume tailored OK (not submitted)')
          } catch (err) {
            log(`    tailoring error: ${err.message}`)
          }
        }
        await randomDelay(800, 2000)
        continue
      }

      // Below threshold — save as skipped so user can still view it
      if (matchScore < cfg.matchThreshold) {
        database.insertApplication({
          job_title: job.job_title,
          company: job.company,
          platform: name,
          salary: job.salary || '',
          job_url: job.job_url,
          job_description: jobDescription,
          match_score: matchScore,
          match_explanation: matchExplanation,
          tailored_resume: '',
          screening_qa: [],
          status: 'skipped',
          closing_date: job.closing_date,
        })

        // Also add to Needs Attention if score is close to threshold
        if (matchScore >= cfg.matchThreshold - 20) {
          await addAttentionJob(job, jobCfg, log, notifyAttention)
        } else {
          log(`  Saved as skipped (score: ${matchScore}%)`)
        }

        await randomDelay(2000, 5000)
        continue
      }

      if (cancelled) { log('Scan cancelled.'); return summary() }

      // Tailor resume
      let tailoredResume = jobCfg.masterResume
      try {
        tailoredResume = stripMarkdown(await aiAdapter.tailorResume(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription, jobCfg.masterResume, jobCfg.geminiModel))
        log(`  Resume tailored`)
      } catch (err) {
        log(`  Resume tailoring error: ${err.message}`)
      }

      // Generate cover letter
      let coverLetter = ''
      try {
        coverLetter = stripMarkdown(await aiAdapter.generateCoverLetter(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription, jobCfg.masterResume, jobCfg.geminiModel, jobCfg.coverLetterTone, jobCfg.coverLetterTemplate))
        log(`  Cover letter generated`)
      } catch (err) {
        log(`  Cover letter error: ${err.message}`)
      }

      if (cancelled) { log('Scan cancelled.'); return summary() }

      // Apply
      await randomDelay(3000, 8000)
      let result
      try {
        result = await scraper.apply(job.job_url, tailoredResume, coverLetter, { ...jobCfg, jobDescription })
        log(`  Apply result: ${result.success ? 'SUCCESS' : 'FAILED — ' + result.reason}`)
      } catch (err) {
        result = { success: false, reason: err.message }
      }

      if (result.success) {
        database.insertApplication({
          job_title: job.job_title,
          company: job.company,
          platform: name,
          salary: job.salary || '',
          job_url: job.job_url,
          job_description: jobDescription,
          match_score: matchScore,
          match_explanation: matchExplanation,
          tailored_resume: tailoredResume,
          cover_letter: coverLetter,
          // What the scraper actually answered on the application form.
          screening_qa: result.screeningQa || [],
          status: 'applied',
          closing_date: job.closing_date,
        })
        log(`  Saved to history`)
        batchCount++
      } else {
        job.reason = result.reason
        await addAttentionJob(job, jobCfg, log, notifyAttention)
      }

      await randomDelay(cfg.batchLimit ? 8000 : 5000, cfg.batchLimit ? 20000 : 12000)
    }
  }

  if (cfg.dryRun) {
    log(`Dry run summary: ${dryWouldApply} job${dryWouldApply === 1 ? '' : 's'} would have been applied to at the ${cfg.matchThreshold}% threshold.`)
  }
  if (blocked.length > 0) {
    log(`Blocked on ${blocked.length} platform(s): ${blocked.map(b => b.platform).join(', ')}. Results from those are missing, not empty.`)
  }
  return summary()
}

async function addAttentionJob(job, cfg, log, notifyAttention) {
  let talkingPoints = []
  try {
    talkingPoints = await aiAdapter.generateTalkingPoints(
      cfg.aiProvider, cfg.aiApiKey,
      job.job_description || job.job_title,
      cfg.masterResume,
      cfg.geminiModel
    )
  } catch { /* non-critical */ }

  const attentionJob = {
    ...job,
    talking_points: talkingPoints,
    reason: job.reason || 'Requires manual application',
    closing_date: job.closing_date || null,
  }

  database.insertAttentionJob(attentionJob)
  log(`  Added to Needs Attention: ${job.job_title}`)
  notifyAttention(attentionJob)
}

// Shared helper: tailor resume, generate cover letter, submit application
async function tailorAndApply(job, cfg, log) {
  const platformMap = { Seek: seek, Indeed: indeed, LinkedIn: linkedin }
  const scraper = platformMap[job.platform]
  if (!scraper) return { success: false, reason: `No scraper for platform: ${job.platform}` }

  log(`Tailoring resume for ${job.job_title} at ${job.company}...`)
  let tailoredResume = cfg.masterResume
  try {
    tailoredResume = stripMarkdown(await aiAdapter.tailorResume(cfg.aiProvider, cfg.aiApiKey, job.job_description || job.job_title, cfg.masterResume, cfg.geminiModel))
    log('Resume tailored')
  } catch (err) {
    log(`Resume tailoring error: ${err.message}`)
  }

  log('Generating cover letter...')
  let coverLetter = ''
  try {
    coverLetter = stripMarkdown(await aiAdapter.generateCoverLetter(cfg.aiProvider, cfg.aiApiKey, job.job_description || job.job_title, cfg.masterResume, cfg.geminiModel, cfg.coverLetterTone, cfg.coverLetterTemplate))
    log('Cover letter generated')
  } catch (err) {
    log(`Cover letter error: ${err.message}`)
  }

  log('Applying...')
  let result
  try {
    result = await scraper.apply(job.job_url, tailoredResume, coverLetter, { ...cfg, jobDescription: job.job_description })
    log(`Apply result: ${result.success ? 'SUCCESS' : 'FAILED — ' + result.reason}`)
  } catch (err) {
    result = { success: false, reason: err.message }
    log(`Apply error: ${err.message}`)
  }

  return { ...result, tailoredResume, coverLetter }
}

// Manual applies get the same keyword routing as scanned ones — the job is
// already known here, so rules can match against its title and description.
function resolveActiveResume(cfg, job, log) {
  return withResume(cfg, job, log)
}

async function applyAttentionJob(jobId, cfg, log) {
  if (busy) return { success: false, reason: 'A scan or another apply is currently running — wait for it to finish and try again.' }
  busy = true
  try {
    return await doApplyAttentionJob(jobId, cfg, log)
  } finally {
    busy = false
  }
}

async function doApplyAttentionJob(jobId, cfg, log) {
  const job = database.getAttentionJob(jobId)
  if (!job) return { success: false, reason: 'Job not found' }

  cfg = resolveActiveResume(cfg, job, log)

  const recent = database.findRecentApplicationToCompany(job.company, cfg.companyCooldownDays)
  if (recent) {
    return {
      success: false,
      reason: `Applied to "${recent.job_title}" at ${job.company} within the last ${cfg.companyCooldownDays} days — skipping to avoid duplicate. Lower the company cooldown in Settings to override.`,
    }
  }

  const result = await tailorAndApply(job, cfg, log)

  if (result.success) {
    database.insertApplication({
      job_title: job.job_title,
      company: job.company,
      platform: job.platform,
      salary: job.salary || '',
      job_url: job.job_url,
      job_description: job.job_description,
      match_score: job.match_score,
      match_explanation: job.match_explanation || '',
      tailored_resume: result.tailoredResume,
      cover_letter: result.coverLetter,
      screening_qa: result.screeningQa || [],
      status: 'applied',
      closing_date: job.closing_date || null,
    })
    database.dismissAttentionJob(jobId)
    log('Saved to history and removed from Needs Attention')
  }

  return result
}

async function applySkippedJob(jobId, cfg, log) {
  if (busy) return { success: false, reason: 'A scan or another apply is currently running — wait for it to finish and try again.' }
  busy = true
  try {
    return await doApplySkippedJob(jobId, cfg, log)
  } finally {
    busy = false
  }
}

async function doApplySkippedJob(jobId, cfg, log) {
  const job = database.getApplication(jobId)
  if (!job) return { success: false, reason: 'Job not found' }

  cfg = resolveActiveResume(cfg, job, log)

  const result = await tailorAndApply(job, cfg, log)

  if (result.success) {
    database.updateApplicationAfterApply(jobId, result.tailoredResume, result.coverLetter, result.screeningQa)
    log('Status updated to Applied')
  }

  return result
}

// Retry several Needs Attention jobs in one pass. Holds `busy` for the whole
// run rather than per job, so a scheduled scan can't slip in between them and
// interleave submissions. Honours cancel() between jobs.
async function applyAttentionJobs(jobIds, cfg, log) {
  if (busy) return { success: false, reason: 'A scan or another apply is currently running — wait for it to finish and try again.' }
  busy = true
  cancelled = false
  const results = []
  try {
    for (let i = 0; i < jobIds.length; i++) {
      if (cancelled) {
        log(`Bulk retry cancelled — ${results.length} of ${jobIds.length} processed.`)
        break
      }
      log(`— Retry ${i + 1} of ${jobIds.length} —`)
      let result
      try {
        result = await doApplyAttentionJob(jobIds[i], cfg, log)
      } catch (err) {
        result = { success: false, reason: err.message }
        log(`Retry error: ${err.message}`)
      }
      results.push({ id: jobIds[i], ...result })
      // Space submissions out the same way a scan does — a burst of rapid
      // applies is exactly the pattern these sites flag.
      if (i < jobIds.length - 1 && !cancelled) await randomDelay(5000, 12000)
    }
  } finally {
    busy = false
  }
  const succeeded = results.filter(r => r.success).length
  log(`Bulk retry finished: ${succeeded} of ${results.length} applied.`)
  return { success: true, succeeded, failed: results.length - succeeded, results }
}

module.exports = {
  run, cancel, isBusy, applyAttentionJob, applyAttentionJobs, applySkippedJob,
  selectResume, // exported for tests
}
