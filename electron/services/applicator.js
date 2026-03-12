const seek = require('./scraper/seek')
const indeed = require('./scraper/indeed')
const linkedin = require('./scraper/linkedin')
const aiAdapter = require('./ai/index')
const database = require('./database')
const { randomDelay } = require('./scraper/utils')

let cancelled = false

function cancel() {
  cancelled = true
}

async function run(cfg, { log, notifyAttention }) {
  cancelled = false

  const scrapers = []
  if (cfg.enableSeek) scrapers.push({ name: 'Seek', scraper: seek, limit: cfg.dailyLimitSeek })
  if (cfg.enableIndeed) scrapers.push({ name: 'Indeed', scraper: indeed, limit: cfg.dailyLimitIndeed })
  if (cfg.enableLinkedIn) scrapers.push({ name: 'LinkedIn', scraper: linkedin, limit: cfg.dailyLimitLinkedIn })

  for (const { name, scraper, limit } of scrapers) {
    if (cancelled) { log('Scan cancelled.'); return }

    log(`Scanning ${name}...`)

    const todayCount = database.getTodayCountByPlatform(name)
    if (todayCount >= limit) {
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
      if (cancelled) { log('Scan cancelled.'); return }

      const currentCount = database.getTodayCountByPlatform(name)
      if (currentCount >= limit) break

      // Skip already-seen jobs (applied or skipped)
      const existing = database.getApplications({ platform: name })
        .find(a => a.job_url === job.job_url)
      if (existing) continue

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
      try {
        matchScore = await aiAdapter.scoreMatch(cfg.aiProvider, cfg.aiApiKey, jobDescription || job.job_title, cfg.masterResume, cfg.geminiModel)
        log(`  Match score: ${matchScore}%`)
      } catch (err) {
        log(`  Scoring error: ${err.message}`)
      }

      job.match_score = matchScore

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
        tailoredResume = await aiAdapter.tailorResume(cfg.aiProvider, cfg.aiApiKey, jobDescription, cfg.masterResume, cfg.geminiModel)
        log(`  Resume tailored`)
      } catch (err) {
        log(`  Resume tailoring error: ${err.message}`)
      }

      if (cancelled) { log('Scan cancelled.'); return }

      // Apply
      await randomDelay(3000, 8000)
      let result
      try {
        result = await scraper.apply(job.job_url, tailoredResume, [], cfg)
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
          tailored_resume: tailoredResume,
          screening_qa: [],
          status: 'applied',
        })
        log(`  Saved to history`)
      } else {
        job.reason = result.reason
        await addAttentionJob(job, cfg, log, notifyAttention)
      }

      await randomDelay(5000, 12000)
    }
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

module.exports = { run, cancel }
