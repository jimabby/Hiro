const seek = require('./scraper/seek')
const indeed = require('./scraper/indeed')
const linkedin = require('./scraper/linkedin')
const ats = require('./scraper/ats')
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

// Merge the chosen resume into the config the scrapers read. The resume's
// identity travels along so it can be recorded on the application — without it
// there's no way to tell afterwards which resume was actually sent, and the
// routing rules can't be judged against interview rates.
function withResume(cfg, job, log) {
  const { resume, ruleKeywords } = selectResume(cfg, job)
  if (ruleKeywords && log) log(`  Resume rule matched (${ruleKeywords}) → "${resume.name || resume.id}"`)
  return {
    ...cfg,
    masterResume: resume?.text || cfg.masterResume || '',
    activeResumeOriginalPath: resume?.originalPath,
    activeResumeOriginalExt: resume?.originalExt,
    activeResumeId: resume?.id || cfg.defaultResumeId || null,
    activeResumeName: resume?.name || null,
  }
}

// Best contact address for follow-up, pulled from the ad. Auto follow-up used
// to skip every application because nothing ever set recruiter_email.
function findRecruiterEmail(cfg, job, log) {
  if (!cfg.extractRecruiterEmail) return ''
  try {
    const { extractRecruiterEmail } = require('./contactExtractor')
    const email = extractRecruiterEmail(job.job_description || '', { company: job.company })
    if (email && log) log(`  Contact for follow-up: ${email}`)
    return email
  } catch {
    return ''
  }
}

let cancelled = false

// Only one apply flow (scheduled scan, batch, or manual apply) may run at a
// time: they share the screening-question prompt and browser resources, and a
// manual apply mid-scan would interleave with the scan's own submissions.
let busy = false

// Whether a scored job has to wait for approval instead of going straight to
// the employer. Pure and exported so the rule can be tested without driving a
// browser — this is the last gate before something irreversible happens.
//
// Every uncertain case holds. A missing or malformed threshold, or a job that
// never got a score, is not evidence of high confidence, and the cost of the
// two mistakes is nowhere near symmetric: holding a good application wastes a
// click, auto-sending a bad one cannot be taken back.
function shouldHoldForReview(cfg, matchScore) {
  if (!cfg.reviewBeforeSubmit) return false
  const gate = cfg.autoSubmitThreshold
  if (typeof gate !== 'number' || !Number.isFinite(gate)) return true
  if (typeof matchScore !== 'number' || !Number.isFinite(matchScore)) return true
  return matchScore < gate
}

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
  // Company career boards (Greenhouse / Lever / Ashby). These serve structured
  // JSON with no bot defenses, so they're far steadier than the aggregators —
  // but they can't be auto-submitted, so everything found goes to Needs
  // Attention with its documents already drafted.
  if (cfg.enableAtsBoards && (cfg.atsBoards || []).length > 0) {
    scrapers.push({ name: 'ATS', scraper: ats, limit: cfg.dailyLimitAts })
  }

  let batchCount = 0
  let heldCount = 0
  let dryWouldApply = 0
  // Every score a dry run produced, so the caller can recommend a threshold
  // from the real distribution rather than guesswork.
  const dryScores = []
  // Platforms that refused to serve results this run (CAPTCHA, rate limit,
  // expired login). Reported in the summary so the caller can tell "blocked"
  // apart from "nothing found".
  const blocked = []
  // Jobs the model couldn't score this run. They are deliberately NOT saved —
  // the next scan retries them — but the count is surfaced so a scan that
  // quietly achieved nothing because the API was down doesn't look like a scan
  // that found nothing worth applying to.
  let scoringFailures = 0
  let budgetStopped = false
  const batchLimit = cfg.batchLimit || Infinity // smart scheduling passes a finite limit
  const summary = () => (cfg.dryRun
    ? { dryRun: true, scores: dryScores, wouldApply: dryWouldApply, threshold: cfg.matchThreshold, blocked, scoringFailures, budgetStopped }
    : { dryRun: false, applied: batchCount, held: heldCount, blocked, scoringFailures, budgetStopped })

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
      // ATS boards return the description with the listing; hand it forward so
      // getJobDescription is a lookup rather than a second network round trip.
      scraper.primeDescriptions?.(jobs)
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

    const blacklist = (cfg.blacklistedCompanies || []).map(c => String(c).toLowerCase())
    // Defensive on both sides: a listing with no company name (a malformed card,
    // or a career board that omits it) used to throw here and take the whole
    // platform's results down with it.
    const filtered = jobs.filter(j => j?.job_url && !blacklist.includes(String(j.company || '').toLowerCase()))

    for (const job of filtered) {
      if (cancelled || batchCount >= batchLimit) { if (cancelled) log('Scan cancelled.'); return summary() }

      const currentCount = database.getTodayCountByPlatform(name)
      if (!cfg.dryRun && currentCount >= limit) break

      // Skip already-seen jobs. Checks BOTH tables: a job whose apply failed
      // sits in attention_jobs with no applications row, so checking only
      // applications meant every scan re-scored, re-tailored and re-submitted
      // it, and added another duplicate Needs Attention entry each time.
      if (database.hasSeenJobUrl(job.job_url)) continue

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

      // Score match.
      //
      // A failure here used to leave matchScore at its initialiser of 50, which
      // was then written to the database as though the model had really said
      // 50 — and because the row existed, the job was never looked at again. A
      // single rate limit permanently discarded a job and poisoned the score
      // histogram the threshold advice is derived from. Now a scoring failure
      // leaves the job untouched so the next scan retries it.
      let matchScore = null
      let matchExplanation = ''
      try {
        const matchResult = await aiAdapter.scoreMatchWithExplanation(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription || job.job_title, jobCfg.masterResume, jobCfg.geminiModel)
        matchScore = matchResult.score
        matchExplanation = matchResult.explanation
        log(`  Match score: ${matchScore}%`)
      } catch (err) {
        // The budget cap is a deliberate stop, not a failure — no point
        // grinding through the rest of the queue to fail identically.
        if (err.budgetExceeded) {
          log(`  ${err.message}`)
          log('Scan stopped: AI budget reached. Nothing was discarded — unscored jobs will be picked up on the next scan.')
          budgetStopped = true
          return summary()
        }
        log(`  Scoring failed (${err.message}) — leaving this job for the next scan rather than recording a guessed score.`)
        scoringFailures++
        await randomDelay(1000, 2500)
        continue
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
          resume_id: jobCfg.activeResumeId,
          resume_name: jobCfg.activeResumeName,
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

      // Tailor resume. Unlike scoring, a failure here is recoverable — the
      // untailored master resume is a real resume, just a less targeted one —
      // so it's logged and the flow continues rather than dropping the job.
      let tailoredResume = jobCfg.masterResume
      try {
        tailoredResume = stripMarkdown(await aiAdapter.tailorResume(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription, jobCfg.masterResume, jobCfg.geminiModel))
        log(`  Resume tailored`)
      } catch (err) {
        if (err.budgetExceeded) { log(`  ${err.message}`); budgetStopped = true; return summary() }
        log(`  Resume tailoring error: ${err.message} — sending the untailored resume`)
      }

      // Generate cover letter
      let coverLetter = ''
      try {
        coverLetter = stripMarkdown(await aiAdapter.generateCoverLetter(jobCfg.aiProvider, jobCfg.aiApiKey, jobDescription, jobCfg.masterResume, jobCfg.geminiModel, jobCfg.coverLetterTone, jobCfg.coverLetterTemplate))
        log(`  Cover letter generated`)
      } catch (err) {
        if (err.budgetExceeded) { log(`  ${err.message}`); budgetStopped = true; return summary() }
        log(`  Cover letter error: ${err.message}`)
      }

      if (cancelled) { log('Scan cancelled.'); return summary() }

      const recruiterEmail = findRecruiterEmail(jobCfg, { ...job, job_description: jobDescription }, log)

      // Company career boards have no automatable submit step. Route them to
      // Needs Attention with the documents drafted rather than calling apply()
      // and reporting a failure that was never going to be a success.
      if (scraper.supportsAutoApply === false) {
        job.reason = 'Company career board — submit on the site; your tailored documents are ready'
        job.tailored_resume = tailoredResume
        job.cover_letter = coverLetter
        job.recruiter_email = recruiterEmail
        await addAttentionJob(job, jobCfg, log, notifyAttention)
        await randomDelay(1500, 4000)
        continue
      }

      // Review mode: everything is drafted, nothing is sent. The documents are
      // stored on the row, so approving on the Review page submits without
      // spending another AI call.
      if (shouldHoldForReview(cfg, matchScore)) {
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
          status: 'held',
          closing_date: job.closing_date,
          resume_id: jobCfg.activeResumeId,
          resume_name: jobCfg.activeResumeName,
          recruiter_email: recruiterEmail,
        })
        heldCount++
        log(`  Held for review (${matchScore}%) — nothing submitted`)
        await randomDelay(1500, 4000)
        continue
      }

      // Say so when review was on and this job cleared the gate anyway —
      // otherwise a submission with review enabled looks like the setting
      // silently failed.
      if (cfg.reviewBeforeSubmit) {
        log(`  Auto-submitting (${matchScore}% ≥ ${cfg.autoSubmitThreshold}% auto-submit threshold)`)
      }

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
          resume_id: jobCfg.activeResumeId,
          resume_name: jobCfg.activeResumeName,
          recruiter_email: recruiterEmail,
        })
        log(`  Saved to history`)
        batchCount++
      } else {
        job.reason = result.reason
        // Carry the drafted documents across so a manual retry from Needs
        // Attention doesn't have to pay for them a second time.
        job.tailored_resume = tailoredResume
        job.cover_letter = coverLetter
        job.recruiter_email = recruiterEmail
        await addAttentionJob(job, jobCfg, log, notifyAttention)
      }

      await randomDelay(cfg.batchLimit ? 8000 : 5000, cfg.batchLimit ? 20000 : 12000)
    }
  }

  if (cfg.dryRun) {
    log(`Dry run summary: ${dryWouldApply} job${dryWouldApply === 1 ? '' : 's'} would have been applied to at the ${cfg.matchThreshold}% threshold.`)
  }
  if (heldCount > 0) {
    log(`Review mode: ${heldCount} application${heldCount === 1 ? '' : 's'} drafted and held. Nothing was submitted — approve them on the Review page.`)
  }
  if (scoringFailures > 0) {
    log(`${scoringFailures} job${scoringFailures === 1 ? '' : 's'} could not be scored (AI unavailable) and ${scoringFailures === 1 ? 'was' : 'were'} left unsaved — the next scan will retry ${scoringFailures === 1 ? 'it' : 'them'}.`)
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

// ─── Review mode: approve a held draft ───────────────────────────
// Submits an application that review mode parked. The resume and cover letter
// were written when the job was found and are stored on the row, so approving
// costs no AI calls — it goes straight to the platform's submit flow.

async function approveHeldApplication(id, cfg, log) {
  if (busy) return { success: false, reason: 'A scan or another apply is currently running — wait for it to finish and try again.' }
  busy = true
  try {
    return await doApproveHeld(id, cfg, log)
  } finally {
    busy = false
  }
}

async function doApproveHeld(id, cfg, log) {
  const job = database.getApplication(id)
  if (!job) return { success: false, reason: 'Application not found' }
  if (job.status !== 'held') return { success: false, reason: `This application is already "${job.status}" — nothing to approve.` }

  const platformMap = { Seek: seek, Indeed: indeed, LinkedIn: linkedin, ATS: ats }
  const scraper = platformMap[job.platform]
  if (!scraper) return { success: false, reason: `No scraper for platform: ${job.platform}` }
  if (scraper.supportsAutoApply === false) {
    return { success: false, reason: 'This is a company career board — open the posting and submit there. Your documents are on the row.' }
  }

  const jobCfg = resolveActiveResume(cfg, job, log)
  log(`Submitting held application: ${job.job_title} at ${job.company}`)

  let result
  try {
    result = await scraper.apply(job.job_url, job.tailored_resume, job.cover_letter, { ...jobCfg, jobDescription: job.job_description })
    log(`Apply result: ${result.success ? 'SUCCESS' : 'FAILED — ' + result.reason}`)
  } catch (err) {
    result = { success: false, reason: err.message }
    log(`Apply error: ${err.message}`)
  }

  if (result.success) {
    database.markHeldApplied(id, result.screeningQa)
    log('Submitted and moved to Applied.')
  }
  return result
}

// Approve several held drafts in one pass, spacing submissions the way a scan
// does — a burst of rapid applies is exactly what these sites flag.
async function approveHeldApplications(ids, cfg, log) {
  if (busy) return { success: false, reason: 'A scan or another apply is currently running — wait for it to finish and try again.' }
  busy = true
  cancelled = false
  const results = []
  try {
    for (let i = 0; i < ids.length; i++) {
      if (cancelled) { log(`Approval run cancelled — ${results.length} of ${ids.length} processed.`); break }
      log(`— Approving ${i + 1} of ${ids.length} —`)
      let result
      try {
        result = await doApproveHeld(ids[i], cfg, log)
      } catch (err) {
        result = { success: false, reason: err.message }
        log(`Approval error: ${err.message}`)
      }
      results.push({ id: ids[i], ...result })
      if (i < ids.length - 1 && !cancelled) await randomDelay(5000, 12000)
    }
  } finally {
    busy = false
  }
  const succeeded = results.filter(r => r.success).length
  log(`Approval run finished: ${succeeded} of ${results.length} submitted.`)
  return { success: true, succeeded, failed: results.length - succeeded, results }
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
  approveHeldApplication, approveHeldApplications,
  selectResume, shouldHoldForReview, // exported for tests
}
