const seek = require('./scraper/seek')
const indeed = require('./scraper/indeed')
const linkedin = require('./scraper/linkedin')
const aiAdapter = require('./ai/index')
const database = require('./database')
const { randomDelay, stripMarkdown } = require('./scraper/utils')

let cancelled = false

function cancel() {
  cancelled = true
}

async function run(cfg, { log, notifyAttention }) {
  cancelled = false

  const activeResumeObj = (cfg.resumes || []).find(r => r.id === cfg.defaultResumeId)
  const activeResume = activeResumeObj?.text || cfg.masterResume || ''
  cfg = { ...cfg, masterResume: activeResume, activeResumeOriginalPath: activeResumeObj?.originalPath, activeResumeOriginalExt: activeResumeObj?.originalExt }

  const scrapers = []
  if (cfg.enableSeek) scrapers.push({ name: 'Seek', scraper: seek, limit: cfg.dailyLimitSeek })
  if (cfg.enableIndeed) scrapers.push({ name: 'Indeed', scraper: indeed, limit: cfg.dailyLimitIndeed })
  if (cfg.enableLinkedIn) scrapers.push({ name: 'LinkedIn', scraper: linkedin, limit: cfg.dailyLimitLinkedIn })

  let batchCount = 0
  let dryWouldApply = 0
  const batchLimit = cfg.batchLimit || Infinity // smart scheduling passes a finite limit

  for (const { name, scraper, limit } of scrapers) {
    if (cancelled || batchCount >= batchLimit) { if (cancelled) log('Scan cancelled.'); return }

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
      log(`${name}: found ${jobs.length} jobs`)
    } catch (err) {
      log(`${name}: scrape error — ${err.message}`)
      continue
    }

    const blacklist = (cfg.blacklistedCompanies || []).map(c => c.toLowerCase())
    const filtered = jobs.filter(j => !blacklist.includes(j.company.toLowerCase()))

    for (const job of filtered) {
      if (cancelled || batchCount >= batchLimit) { if (cancelled) log('Scan cancelled.'); return }

      const currentCount = database.getTodayCountByPlatform(name)
      if (!cfg.dryRun && currentCount >= limit) break

      // Skip already-seen jobs (applied or skipped)
      if (database.hasJobUrl(job.job_url)) continue

      // Skip companies we've already successfully applied to
      if (database.hasAppliedToCompany(job.company)) {
        log(`  Skipping ${job.company} — already applied`)
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

      if (cancelled) { log('Scan cancelled.'); return }

      // Score match
      let matchScore = 50
      let matchExplanation = ''
      try {
        const matchResult = await aiAdapter.scoreMatchWithExplanation(cfg.aiProvider, cfg.aiApiKey, jobDescription || job.job_title, cfg.masterResume, cfg.geminiModel)
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
        log(`  DRY RUN — ${pass ? 'WOULD APPLY' : 'would skip'}: score ${matchScore}% (threshold ${cfg.matchThreshold}%)`)
        if (pass) {
          dryWouldApply++
          try {
            await aiAdapter.tailorResume(cfg.aiProvider, cfg.aiApiKey, jobDescription, cfg.masterResume, cfg.geminiModel)
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
        })

        // Also add to Needs Attention if score is close to threshold
        if (matchScore >= cfg.matchThreshold - 20) {
          await addAttentionJob(job, cfg, log, notifyAttention)
        } else {
          log(`  Saved as skipped (score: ${matchScore}%)`)
        }

        await randomDelay(2000, 5000)
        continue
      }

      if (cancelled) { log('Scan cancelled.'); return }

      // Tailor resume
      let tailoredResume = cfg.masterResume
      try {
        tailoredResume = stripMarkdown(await aiAdapter.tailorResume(cfg.aiProvider, cfg.aiApiKey, jobDescription, cfg.masterResume, cfg.geminiModel))
        log(`  Resume tailored`)
      } catch (err) {
        log(`  Resume tailoring error: ${err.message}`)
      }

      // Generate cover letter
      let coverLetter = ''
      try {
        coverLetter = stripMarkdown(await aiAdapter.generateCoverLetter(cfg.aiProvider, cfg.aiApiKey, jobDescription, cfg.masterResume, cfg.geminiModel, cfg.coverLetterTone, cfg.coverLetterTemplate))
        log(`  Cover letter generated`)
      } catch (err) {
        log(`  Cover letter error: ${err.message}`)
      }

      if (cancelled) { log('Scan cancelled.'); return }

      // Apply
      await randomDelay(3000, 8000)
      let result
      try {
        result = await scraper.apply(job.job_url, tailoredResume, coverLetter, { ...cfg, jobDescription })
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
          screening_qa: [],
          status: 'applied',
        })
        log(`  Saved to history`)
        batchCount++
      } else {
        job.reason = result.reason
        await addAttentionJob(job, cfg, log, notifyAttention)
      }

      await randomDelay(cfg.batchLimit ? 8000 : 5000, cfg.batchLimit ? 20000 : 12000)
    }
  }

  if (cfg.dryRun) {
    log(`Dry run summary: ${dryWouldApply} job${dryWouldApply === 1 ? '' : 's'} would have been applied to at the ${cfg.matchThreshold}% threshold.`)
  }
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

function resolveActiveResume(cfg) {
  const activeResumeObj = (cfg.resumes || []).find(r => r.id === cfg.defaultResumeId)
  const activeResume = activeResumeObj?.text || cfg.masterResume || ''
  return { ...cfg, masterResume: activeResume, activeResumeOriginalPath: activeResumeObj?.originalPath, activeResumeOriginalExt: activeResumeObj?.originalExt }
}

async function applyAttentionJob(jobId, cfg, log) {
  const job = database.getAttentionJob(jobId)
  if (!job) return { success: false, reason: 'Job not found' }

  cfg = resolveActiveResume(cfg)

  if (database.hasAppliedToCompany(job.company)) {
    return { success: false, reason: `Already applied to ${job.company} — skipping to avoid duplicate` }
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
      screening_qa: [],
      status: 'applied',
    })
    database.dismissAttentionJob(jobId)
    log('Saved to history and removed from Needs Attention')
  }

  return result
}

async function applySkippedJob(jobId, cfg, log) {
  const job = database.getApplication(jobId)
  if (!job) return { success: false, reason: 'Job not found' }

  cfg = resolveActiveResume(cfg)

  const result = await tailorAndApply(job, cfg, log)

  if (result.success) {
    database.updateApplicationAfterApply(jobId, result.tailoredResume, result.coverLetter)
    log('Status updated to Applied')
  }

  return result
}

module.exports = { run, cancel, applyAttentionJob, applySkippedJob }
