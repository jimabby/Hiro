const seek = require('./scraper/seek')
const indeed = require('./scraper/indeed')
const linkedin = require('./scraper/linkedin')
const ats = require('./scraper/ats')
const aiAdapter = require('./ai/index')
const database = require('./database')
const { randomDelay, stripMarkdown } = require('./scraper/utils')
const { parseClosingDate } = require('./dateParser')
const automationHealth = require('./automationHealth')
const resumeExperiment = require('./resumeExperiment')
const { inspectTailoring, inspectCoverLetter, describeFlags } = require('./fabricationGuard')
const { detectInjection, describeInjection } = require('./ai/untrusted')

// Pick the resume to use for a given job. A rule matches when any of its
// comma-separated keywords appears in the job title or description; the first
// matching rule wins, so ordering in Settings is the precedence. Falls back to
// the running A/B experiment's assignment, then the configured default resume,
// then the master resume.
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

  // No rule claimed this job, so it is eligible for the experiment. Checked
  // AFTER the rules deliberately: a rule is an explicit targeting decision, and
  // overriding it to feed an experiment would change what real employers
  // receive in a way the user never asked for.
  const arm = resumeExperiment.assignArm(job?.job_url, cfg.resumeExperiment)
  if (arm) {
    const assigned = resumes.find(r => r.id === arm)
    if (assigned) return { resume: assigned, ruleKeywords: null, experimentArm: arm }
  }

  return { resume: resumes.find(r => r.id === cfg.defaultResumeId) || null, ruleKeywords: null }
}

// Merge the chosen resume into the config the scrapers read. The resume's
// identity travels along so it can be recorded on the application — without it
// there's no way to tell afterwards which resume was actually sent, and the
// routing rules can't be judged against interview rates.
function withResume(cfg, job, log) {
  const { resume, ruleKeywords, experimentArm } = selectResume(cfg, job)
  if (ruleKeywords && log) log(`  Resume rule matched (${ruleKeywords}) → "${resume.name || resume.id}"`)
  // Said out loud so an experiment is never running invisibly — the whole point
  // is that the user knows two different documents are going out.
  else if (experimentArm && log) log(`  A/B test → "${resume.name || resume.id}"`)
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

  // Per scan, not per process — a desktop app left running for weeks would
  // otherwise spend the budget on day one and never retry again.
  require('./ai/usage').resetRetryBudget(cfg.aiRetryBudgetPerScan ?? 20)

  // Baseline resume — per-job routing rules may override this later, once the
  // job description is available to match against.
  cfg = withResume(cfg, null)

  const scrapers = []
  if (cfg.enableSeek) scrapers.push({ name: 'Seek', scraper: seek, limit: cfg.dailyLimitSeek })
  if (cfg.enableIndeed) scrapers.push({ name: 'Indeed', scraper: indeed, limit: cfg.dailyLimitIndeed })
  if (cfg.enableLinkedIn) scrapers.push({ name: 'LinkedIn', scraper: linkedin, limit: cfg.dailyLimitLinkedIn })
  // Company career boards (Greenhouse / Lever / Ashby / Workable / Recruitee /
  // SmartRecruiters). These serve structured
  // JSON with no bot defenses, so they're far steadier than the aggregators —
  // but they can't be auto-submitted, so everything found goes to Needs
  // Attention with its documents already drafted.
  if (cfg.enableAtsBoards && (cfg.atsBoards || []).length > 0) {
    scrapers.push({ name: 'ATS', scraper: ats, limit: cfg.dailyLimitAts })
  }

  // Jobs this run has taken all the way to a decision, which is what the batch
  // limit governs.
  //
  // Counting only successes meant a batch of 3 where every apply failed never
  // reached its limit, so it walked the entire scrape set — paying for scoring,
  // tailoring and a cover letter on every listing — instead of stopping after
  // three. That was fixed by counting attempted submissions instead.
  //
  // But counting SUBMISSIONS still missed every path that costs exactly the same
  // and never submits: a draft held for review, a career-board match routed to
  // Needs Attention, a document the fabrication guard stopped. With review mode
  // on, nothing is ever submitted — so nothing ever incremented this, and a
  // smart-schedule batch of 3 quietly drafted its way through the entire scrape
  // set in one sitting, which is the identical failure by another route.
  //
  // So this counts a job once it has consumed the drafting spend (the tailoring
  // and cover-letter calls), however that job ends. Jobs discarded below the
  // match threshold are deliberately not counted: they cost one scoring call and
  // stop, and bounding those would make the batch limit a cap on scanning rather
  // than on work.
  let batchAttempts = 0
  // Submissions that actually went through. This is the number worth reporting.
  let batchCount = 0
  let heldCount = 0
  let foundCount = 0
  let dryWouldApply = 0
  // Every score a dry run produced, so the caller can recommend a threshold
  // from the real distribution rather than guesswork.
  const dryScores = []
  // Platforms that refused to serve results this run (CAPTCHA, rate limit,
  // expired login). Reported in the summary so the caller can tell "blocked"
  // apart from "nothing found".
  const blocked = []
  // Platforms this run deliberately skipped because automation health paused
  // them. Kept apart from `blocked`: a pause is Hiro's own decision working as
  // designed, and folding it into the failure channel reported a healthy system
  // as a broken one — a "Scan did not complete" push and a red banner for a
  // back-off the app chose itself.
  const paused = []
  // Jobs the model couldn't score this run. They are deliberately NOT saved —
  // the next scan retries them — but the count is surfaced so a scan that
  // quietly achieved nothing because the API was down doesn't look like a scan
  // that found nothing worth applying to.
  let scoringFailures = 0
  let budgetStopped = false
  const batchLimit = cfg.batchLimit || Infinity // smart scheduling passes a finite limit
  // Per-platform ceiling on drafts held for review in a day. 0 disables it,
  // which restores the old unbounded behaviour for anyone who wants it.
  const draftLimit = Number.isFinite(Number(cfg.dailyDraftLimit)) ? Number(cfg.dailyDraftLimit) : 20
  // `cancelled` rides on every summary, not just the ones produced by a cancel
  // check. run() honours cancel() by RETURNING rather than throwing, so without
  // this the caller cannot tell an aborted run from a finished one — and
  // scheduler's finally, seeing no error, recorded the abort as a clean success,
  // stamped lastScanAt, and announced "Scan complete" over a scan the user had
  // just stopped. Read at the moment the summary is built, so a cancel that
  // lands mid-unwind is still reflected.
  const summary = () => (cfg.dryRun
    ? { dryRun: true, cancelled, scores: dryScores, wouldApply: dryWouldApply, threshold: cfg.matchThreshold, blocked, paused, scoringFailures, budgetStopped }
    : { dryRun: false, cancelled, found: foundCount, applied: batchCount, held: heldCount, blocked, paused, scoringFailures, budgetStopped })

  for (const { name, scraper, limit } of scrapers) {
    if (cancelled || batchAttempts >= batchLimit) { if (cancelled) log('Scan cancelled.'); return summary() }

    const cooldown = automationHealth.getCooldown(name)
    if (cooldown.active) {
      log(`${name}: paused by automation health until ${cooldown.until}. Skipping this run.`)
      paused.push({ platform: name, until: cooldown.until, reason: cooldown.reason })
      continue
    }

    log(`Scanning ${name}...`)

    // Dry run ignores daily limits so every found job gets scored for tuning.
    const todayCount = name === 'ATS'
      ? database.getTodayAttentionCountByPlatform(name)
      : database.getTodayCountByPlatform(name)
    if (!cfg.dryRun && todayCount >= limit) {
      log(`${name}: daily limit reached (${todayCount}/${limit}). Skipping.`)
      continue
    }

    let jobs
    try {
      // `log` lets a scraper narrate work the caller cannot otherwise see —
      // the ATS adapter uses it to say when it is reading descriptions one at a
      // time, and when it has stopped short of a very long board.
      // `onBoard` is only meaningful for the ATS adapter, which watches several
      // employers behind one platform name. Passing it unconditionally is
      // harmless — every other scraper ignores the option — and it is what
      // gives each board its own health record, since a single dead board is
      // invisible in the aggregate signal recorded below.
      jobs = await scraper.scrape(cfg, {
        log,
        onBoard: (board) => automationHealth.recordBoard(board),
      })
      // ATS boards return the description with the listing; hand it forward so
      // getJobDescription is a lookup rather than a second network round trip.
      scraper.primeDescriptions?.(jobs)
      log(`${name}: found ${jobs.length} jobs across ${cfg.scrapePages || 1} page(s)`)
      foundCount += jobs.length
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
        automationHealth.recordScrape(name, { blocked: true })
      } else {
        log(`${name}: scrape error — ${err.message}`)
        automationHealth.recordScrape(name, { error: err.message })
      }
      continue
    }

    // A zero-result scrape that was not blocked and did not error is the exact
    // shape of a scraper whose selectors have moved. One is meaningless; a run
    // of them is the only warning this failure mode ever gives.
    //
    // The selector report narrows that from "something broke" to which selector
    // broke, and catches the partial break the streak heuristic cannot see —
    // cards found but one field unreadable, so every listing is discarded and
    // the scan reports a healthy-looking zero.
    automationHealth.recordScrape(name, {
      found: jobs.length,
      selectors: scraper.getSelectorReport?.() || null,
    })

    const blacklist = (cfg.blacklistedCompanies || []).map(c => String(c).toLowerCase())
    // Defensive on both sides: a listing with no company name (a malformed card,
    // or a career board that omits it) used to throw here and take the whole
    // platform's results down with it.
    const filtered = jobs.filter(j => j?.job_url && !blacklist.includes(String(j.company || '').toLowerCase()))

    for (const job of filtered) {
      if (cancelled || batchAttempts >= batchLimit) { if (cancelled) log('Scan cancelled.'); return summary() }

      // Some structured board adapters omit the redundant platform field. It
      // is still required for attribution and, for ATS, for the draft-based
      // daily limit below.
      job.platform = job.platform || name

      const currentCount = name === 'ATS'
        ? database.getTodayAttentionCountByPlatform(name)
        : database.getTodayCountByPlatform(name)
      if (!cfg.dryRun && currentCount >= limit) break

      // The daily limit above counts submissions, so in review mode — where
      // nothing is ever submitted — it never fires. Without this, turning on
      // "review before submit" silently removed the only bound on how much a
      // scan could spend. Checked here, before the description fetch and the
      // three model calls, because a cap enforced after the spend is not a cap.
      if (!cfg.dryRun && draftLimit > 0 && database.getTodayHeldCountByPlatform(name) >= draftLimit) {
        log(`${name}: daily draft limit reached (${draftLimit} held for review). Approve or reject some on the Review page.`)
        break
      }

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

      // A role the user marked as one that keeps being reposted. Checked here —
      // before the description fetch and the three model calls — because the
      // entire point is not to pay for it again. Company-and-title exact, so
      // other roles at the same employer are unaffected.
      if (database.isRoleSuppressed(job.company, job.job_title)) {
        log(`  Skipping "${job.job_title}" at ${job.company} — you marked this role as repeatedly reposted`)
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

      // Have we already paid for this exact advert under a different URL?
      //
      // Everything above this point matches on identity the URL or the title
      // carries, and an employer reposting a listing changes both — the URL
      // always, the title often ("Data Engineer" comes back as "Data Engineer
      // (Senior)"). So the checks all miss, and the scan buys a score, a
      // tailored resume and a cover letter for an advert it has seen before.
      //
      // Checked HERE because this is the last free moment: the description has
      // just been fetched and nothing has been sent to a model yet. The match is
      // exact rather than fuzzy — see jobFingerprint.js for why skipping a real
      // job is the expensive mistake and being scored twice is the cheap one.
      const seenBefore = database.findJobByContent(job.company, jobDescription)
      if (seenBefore) {
        log(`  Same advert as "${seenBefore.job_title}"${seenBefore.seen_at ? ` from ${String(seenBefore.seen_at).slice(0, 10)}` : ''} — reposted under a new URL, skipping`)
        continue
      }

      // A role the user suppressed, coming back under a new title. The
      // title-based check above cannot see this one by construction.
      const suppressedRepost = database.isContentSuppressed(job.company, jobDescription)
      if (suppressedRepost) {
        log(`  Skipping "${job.job_title}" at ${job.company} — same advert as "${suppressedRepost.job_title}", which you marked as repeatedly reposted`)
        continue
      }

      // Application deadline, if the ad states one. Best-effort: null just
      // means "unknown", and the user can set it by hand later.
      job.closing_date = parseClosingDate(jobDescription)
      if (job.closing_date) log(`  Closes ${job.closing_date}`)

      // Is this ad talking to the model rather than to a candidate?
      //
      // Everything downstream of here takes the description as input: the score
      // that decides whether to submit, the resume, the cover letter, and the
      // screening answers that get typed into the employer's form. The prompts
      // fence it (see ai/untrusted.js), but fencing is a mitigation, not a
      // proof, and this is the one place where being wrong is unrecoverable.
      //
      // So an ad carrying model-directed instructions does not get to be
      // submitted unattended. It is not discarded — the listing may well be a
      // real job whose description was scraped along with somebody else's
      // injected boilerplate — it just stops being eligible for the automatic
      // path and goes to a human with the reason attached.
      const injection = detectInjection(jobDescription)
      if (!injection.clean) {
        log(`  Listing contains model-directed instructions — ${describeInjection(injection.hits)}`)
      }

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
          campaign_id: cfg.campaignId, campaign_name: cfg.campaignName,
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

      // Prompts are guidance, not enforcement. Any newly introduced durable
      // employment fact forces human review even when blanket review mode is
      // disabled or the score clears the auto-submit threshold.
      //
      // Three independent reasons to stop, folded into one gate because they all
      // resolve the same way — a human looks before an employer does:
      //
      //   the resume gained a fact the base did not have (diffed)
      //   the cover letter asserts a credential, date or employer the resume
      //     does not support (checked whole, since it has no base to diff)
      //   the listing itself carried instructions aimed at the model
      //
      // The third is not evidence that anything went wrong — it is the reason
      // not to find out the hard way. See ai/untrusted.js.
      const fabrication = inspectTailoring(jobCfg.masterResume, tailoredResume)
      const letterClaims = inspectCoverLetter(jobCfg.masterResume, coverLetter, {
        company: job.company, jobTitle: job.job_title,
      })
      const reasons = []
      if (!fabrication.safe) reasons.push(`resume — ${describeFlags(fabrication.flags)}`)
      if (!letterClaims.safe) reasons.push(`cover letter — ${describeFlags(letterClaims.flags)}`)
      if (!injection.clean) reasons.push(`listing contains model-directed instructions (${describeInjection(injection.hits)})`)

      if (reasons.length > 0) {
        const detail = reasons.join('; ')
        if (scraper.supportsAutoApply === false) {
          job.reason = `Needs review before manual submission: ${detail}`
          job.job_description = jobDescription || job.job_description || ''
          job.tailored_resume = tailoredResume
          job.cover_letter = coverLetter
          job.recruiter_email = recruiterEmail
          batchAttempts++
          await addAttentionJob(job, jobCfg, log, notifyAttention)
          await randomDelay(1500, 4000)
          continue
        }
        database.insertApplication({
          campaign_id: cfg.campaignId, campaign_name: cfg.campaignName,
          job_title: job.job_title, company: job.company, platform: name,
          salary: job.salary || '', job_url: job.job_url,
          job_description: jobDescription, match_score: matchScore,
          match_explanation: `${matchExplanation || ''}${matchExplanation ? '\n\n' : ''}Held for review: ${detail}`,
          base_resume: jobCfg.masterResume || '', provider: jobCfg.aiProvider || '',
          model: jobCfg.geminiModel || '', tailored_resume: tailoredResume,
          cover_letter: coverLetter, screening_qa: [], status: 'held',
          closing_date: job.closing_date, resume_id: jobCfg.activeResumeId,
          resume_name: jobCfg.activeResumeName, recruiter_email: recruiterEmail,
          // Every flag from every check, so the Review page can show what was
          // objected to rather than only that something was.
          fabrication_flags: [
            ...fabrication.flags,
            ...letterClaims.flags.map(f => ({ ...f, kind: `cover-letter ${f.kind}` })),
            ...injection.hits.map(h => ({ kind: 'listing-injection', value: h.name, line: h.excerpt })),
          ],
        })
        heldCount++
        batchAttempts++
        log(`  HELD for review — ${detail}`)
        await randomDelay(1500, 4000)
        continue
      }

      // Company career boards have no automatable submit step. Route them to
      // Needs Attention with the documents drafted rather than calling apply()
      // and reporting a failure that was never going to be a success.
      if (scraper.supportsAutoApply === false) {
        job.reason = 'Company career board — submit on the site; your tailored documents are ready'
        // The description was already fetched above and is what the Needs
        // Attention page shows. Nothing set it on the job object, so every ATS
        // match reached the insert with job_description undefined — see the note
        // in database.insertAttentionJob.
        job.job_description = jobDescription || job.job_description || ''
        job.tailored_resume = tailoredResume
        job.cover_letter = coverLetter
        job.recruiter_email = recruiterEmail
        batchAttempts++
        await addAttentionJob(job, jobCfg, log, notifyAttention)
        await randomDelay(1500, 4000)
        continue
      }

      // Review mode: everything is drafted, nothing is sent. The documents are
      // stored on the row, so approving on the Review page submits without
      // spending another AI call.
      if (shouldHoldForReview(cfg, matchScore)) {
        database.insertApplication({
          campaign_id: cfg.campaignId, campaign_name: cfg.campaignName,
          job_title: job.job_title,
          company: job.company,
          platform: name,
          salary: job.salary || '',
          job_url: job.job_url,
          job_description: jobDescription,
          match_score: matchScore,
          match_explanation: matchExplanation,
          // The master resume as it stood at this moment, so the tailoring diff
          // survives the master being edited afterwards.
          base_resume: jobCfg.masterResume || '',
          // Which model produced these documents, so two versions of the same
          // job can be judged against each other rather than just compared.
          provider: jobCfg.aiProvider || '',
          model: jobCfg.geminiModel || '',
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
        batchAttempts++
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

      // Apply. Counted here, before the outcome is known — the batch limit
      // exists to bound how much work a batch does, and a failed submission
      // cost exactly as much scraping and AI spend as a successful one. The
      // non-submitting outcomes above are counted for the same reason.
      batchAttempts++
      await randomDelay(3000, 8000)
      let result
      try {
        result = await scraper.apply(job.job_url, tailoredResume, coverLetter, { ...jobCfg, jobDescription })
        log(`  Apply result: ${result.success ? 'SUCCESS' : 'FAILED — ' + result.reason}`)
      } catch (err) {
        result = { success: false, reason: err.message }
      }
      // Declining at the submission check is a decision, not a malfunction, and
      // must not count against the platform's health.
      if (!result.cancelledByUser) {
        automationHealth.recordApply(name, { success: result.success, reason: result.reason })
      }

      if (result.success) {
        database.insertApplication({
          campaign_id: cfg.campaignId, campaign_name: cfg.campaignName,
          job_title: job.job_title,
          company: job.company,
          platform: name,
          salary: job.salary || '',
          job_url: job.job_url,
          job_description: jobDescription,
          match_score: matchScore,
          match_explanation: matchExplanation,
          // The master resume as it stood at this moment, so the tailoring diff
          // survives the master being edited afterwards.
          base_resume: jobCfg.masterResume || '',
          // Which model produced these documents, so two versions of the same
          // job can be judged against each other rather than just compared.
          provider: jobCfg.aiProvider || '',
          model: jobCfg.geminiModel || '',
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
    campaign_id: cfg.campaignId || job.campaign_id || null,
    campaign_name: cfg.campaignName || job.campaign_name || null,
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

  // The same three checks the scan path applies, for the same reason: this
  // submits to a real employer, and a manual retry from Needs Attention is not
  // a lesser event than a scheduled one.
  const fabrication = inspectTailoring(cfg.masterResume, tailoredResume)
  const letterClaims = inspectCoverLetter(cfg.masterResume, coverLetter, {
    company: job.company, jobTitle: job.job_title,
  })
  const injection = detectInjection(job.job_description || '')
  const reasons = []
  if (!fabrication.safe) reasons.push(`resume — ${describeFlags(fabrication.flags)}`)
  if (!letterClaims.safe) reasons.push(`cover letter — ${describeFlags(letterClaims.flags)}`)
  if (!injection.clean) reasons.push(`listing contains model-directed instructions (${describeInjection(injection.hits)})`)
  if (reasons.length > 0) {
    const detail = reasons.join('; ')
    log(`Submission stopped for review — ${detail}`)
    return {
      success: false,
      heldForFabrication: true,
      fabricationFlags: [
        ...fabrication.flags,
        ...letterClaims.flags.map(f => ({ ...f, kind: `cover-letter ${f.kind}` })),
        ...injection.hits.map(h => ({ kind: 'listing-injection', value: h.name, line: h.excerpt })),
      ],
      reason: `Needs review before sending: ${detail}`,
      tailoredResume,
      coverLetter,
    }
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

  if (result.heldForFabrication) {
    database.insertApplication({
      ...job, base_resume: cfg.masterResume || '', tailored_resume: result.tailoredResume,
      cover_letter: result.coverLetter, screening_qa: [], status: 'held',
      resume_id: cfg.activeResumeId, resume_name: cfg.activeResumeName,
      provider: cfg.aiProvider || '', model: cfg.geminiModel || '',
      fabrication_flags: result.fabricationFlags,
      match_explanation: `${job.match_explanation || ''}${job.match_explanation ? '\n\n' : ''}Fabrication guard: ${describeFlags(result.fabricationFlags)}`,
    })
    database.dismissAttentionJob(jobId)
    log('Moved to Review; nothing was submitted.')
    return result
  }

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
      base_resume: cfg.masterResume || '',
      resume_id: cfg.activeResumeId,
      resume_name: cfg.activeResumeName,
      provider: cfg.aiProvider || '',
      model: cfg.geminiModel || '',
      campaign_id: job.campaign_id, campaign_name: job.campaign_name,
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

  if (result.heldForFabrication) {
    database.holdApplicationDraft(jobId, {
      baseResume: cfg.masterResume || '', tailoredResume: result.tailoredResume,
      coverLetter: result.coverLetter, resumeId: cfg.activeResumeId,
      resumeName: cfg.activeResumeName, provider: cfg.aiProvider || '',
      model: cfg.geminiModel || '', flags: result.fabricationFlags,
    })
    log('Moved to Review; nothing was submitted.')
    return result
  }

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
  } else if (result.cancelledByUser) {
    // Declining at the submission check is not a failure. The draft stays
    // held and unchanged so it can be approved later — marking it failed
    // would push it to Needs Attention and invite a blind retry of the very
    // thing the user just refused.
    log('Cancelled at the submission check — the draft is still held.')
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
  // Drafts the user declined at the submission check are reported apart from
  // real failures: nothing went wrong, and they are still held.
  const declined = results.filter(r => r.cancelledByUser).length
  log(`Approval run finished: ${succeeded} of ${results.length} submitted${declined ? `, ${declined} declined and still held` : ''}.`)
  return { success: true, succeeded, declined, failed: results.length - succeeded - declined, results }
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
