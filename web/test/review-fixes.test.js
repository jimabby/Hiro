// The pure logic behind the November review: the backup provider's failure
// rules, OpenRouter's cancelled sign-in, Gemini's version order, company
// block-list matching, the eligibility filter, weekly goals, the skills-gap
// report and the thank-you draft parser. The database halves are in
// weekly-features.test.js.

const fs = require('fs')
const os = require('os')
const path = require('path')
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-review-fixes-'))
process.on('exit', () => { try { fs.rmSync(process.env.HIRO_CONFIG_DIR, { recursive: true, force: true }) } catch {} })

const { service, createChecker } = require('./helpers')
const { check, done } = createChecker()

const { companyKey, blockedCompany, eligibilityBlock } = service('jobFilters')
const ai = service('ai/index')
const { pickGeminiDefault } = service('ai/modelList')
const goals = service('weeklyGoals')
const skills = service('skillsGap')
const { parseDraft, PLACEHOLDER } = service('thankYouNote')
const openrouterAuth = service('openrouterAuth')

;(async () => {
  // ── Backup provider: only an outage moves every call ────────────
  const err = (props, Ctor = Error) => Object.assign(new Ctor('x'), props)
  check('a 5xx is an outage', ai._failureKind(err({ status: 503 })), 'outage')
  check('out of credit is an outage', ai._failureKind(err({ status: 402 })), 'outage')
  check('a refused key is an outage', ai._failureKind(err({ status: 401 })), 'outage')
  check('a network error is an outage', ai._failureKind(err({ code: 'ECONNRESET' })), 'outage')
  check('an unreadable reply is this request only', ai._failureKind(new SyntaxError('Unexpected token')), 'request')
  check('a refusal is this request only', ai._failureKind(err({ refusal: true })), 'request')
  check('a malformed request never falls back', ai._failureKind(err({ status: 400 })), 'none')
  check('the spend cap never falls back', ai._failureKind(err({ name: 'BudgetExceededError' })), 'none')
  check('a bug in Hiro never falls back', ai._failureKind(new TypeError("Cannot read properties of undefined (reading 'x')")), 'none')
  check('fetch failing is still an outage', ai._failureKind(new TypeError('fetch failed')), 'outage')

  const cfg = { aiProvider: 'claude', aiApiKey: 'ka', aiApiKeys: { gemini: 'kg' }, aiFallbackProvider: 'gemini', geminiModel: 'gemini-x' }
  const calls = []
  const invoke = (failWith) => async (adapter) => {
    const who = adapter === service('ai/claude') ? 'claude' : 'gemini'
    calls.push(who)
    if (who === 'claude' && failWith) throw failWith()
    return `from ${who}`
  }
  const opts = { loadCfg: () => cfg, now: () => 1000 }

  ai._resetBackupState()
  check('an unreadable reply is retried on the backup',
    await ai._call('claude', 'ka', '', invoke(() => new SyntaxError('bad json')), opts), 'from gemini')
  calls.length = 0
  await ai._call('claude', 'ka', '', invoke(null), opts)
  check('without benching the main provider', calls, ['claude'])
  check('so documents are still recorded under it', ai.servingProvider(cfg, () => 1000), 'claude')

  ai._resetBackupState()
  calls.length = 0
  let thrown = null
  try { await ai._call('claude', 'ka', '', invoke(() => err({ status: 400, message: 'prompt is too long' })), opts) } catch (e) { thrown = e }
  check('a 400 is reported, not sent to a second provider', [thrown?.status, calls], [400, ['claude']])
  ai._resetBackupState()

  // ── OpenRouter: Deny ends the sign-in at once ────────────────────
  const started = Date.now()
  const denied = await openrouterAuth.signIn({
    timeoutMs: 20000,
    openExternal: async (url) => {
      const callback = new URL(url).searchParams.get('callback_url')
      // What OpenRouter does on Deny: back to the callback with no state.
      setTimeout(() => fetch(callback).catch(() => {}), 10)
    },
  })
  check('a denied sign-in fails', denied.success, false)
  check('saying it was cancelled', /cancelled/i.test(denied.error), true)
  check('straight away, not after the timeout', Date.now() - started < 5000, true)

  const forged = await openrouterAuth.signIn({
    timeoutMs: 1500,
    openExternal: async (url) => {
      const callback = new URL(url).searchParams.get('callback_url')
      setTimeout(() => fetch(`${callback}?code=attacker&state=wrong`).catch(() => {}), 10)
    },
    fetchImpl: async () => { throw new Error('must not exchange a forged code') },
  })
  check('a code with the wrong state is still refused (and waits)', /Timed out/.test(forged.error), true)

  // ── Gemini picks the newest version, part by part ────────────────
  check('3.10 is newer than 3.8',
    pickGeminiDefault([{ id: 'gemini-3.8-flash' }, { id: 'gemini-3.10-flash' }, { id: 'gemini-2.5-flash' }]), 'gemini-3.10-flash')
  check('3 is newer than 2.5', pickGeminiDefault([{ id: 'gemini-2.5-flash' }, { id: 'gemini-3-flash' }]), 'gemini-3-flash')

  // ── Company block list ──────────────────────────────────────────
  check('legal suffixes are ignored', companyKey('Acme Pty Ltd'), 'acme')
  check('so is case and punctuation', companyKey('ACME, Inc.'), 'acme')
  check('a leading "The" is ignored', companyKey('The Acme Group'), 'acme')
  check('& and "and" are the same', companyKey('Smith & Jones'), companyKey('Smith and Jones'))
  check('a name made only of suffixes keeps a word', companyKey('The Company'), 'company')
  check('blocking "Acme" blocks "Acme Pty Ltd"', blockedCompany('Acme Pty Ltd', ['Acme']), 'Acme')
  check('and "Acme Australia"', blockedCompany('Acme Australia', ['acme']), 'acme')
  check('but blocking "Bank" does not block every bank', blockedCompany('Bank of Queensland', ['Bank']), null)
  check('a missing company is never blocked', blockedCompany('', ['Acme']), null)

  // ── Eligibility ──────────────────────────────────────────────────
  const elig = (e) => ({ eligibility: { enabled: true, ...e } })
  const job = { job_title: 'Engineer' }
  check('off by default', eligibilityBlock({}, job, 'Must be an Australian citizen.'), null)
  check('citizens only, for a permanent resident',
    eligibilityBlock(elig({ workStatus: 'permanent' }), job, 'Great team. You must be an Australian citizen to apply.')?.reason, 'citizens only')
  check('the ad\'s own sentence is quoted',
    eligibilityBlock(elig({ workStatus: 'permanent' }), job, 'Great team. You must be an Australian citizen to apply.')?.quote, 'You must be an Australian citizen to apply.')
  check('citizen or PR does not rule out a PR',
    eligibilityBlock(elig({ workStatus: 'permanent' }), job, 'You must be an Australian citizen or permanent resident.'), null)
  check('but does rule out a visa holder',
    eligibilityBlock(elig({ workStatus: 'visa' }), job, 'You must be an Australian citizen or permanent resident.')?.reason, 'citizens or permanent residents only')
  check('a citizen is never ruled out on citizenship',
    eligibilityBlock(elig({ workStatus: 'citizen' }), job, 'Australian citizens only.'), null)
  check('"citizen, PR or valid visa" is open to all',
    eligibilityBlock(elig({ workStatus: 'visa' }), job, 'You must be eligible to work in Australia (citizen, PR or valid visa).'), null)
  check('no sponsorship, for someone who needs it',
    eligibilityBlock(elig({ needsSponsorship: true }), job, 'Unfortunately we are unable to offer visa sponsorship.')?.reason, 'no visa sponsorship')
  check('"sponsorship is not available"',
    eligibilityBlock(elig({ needsSponsorship: true }), job, 'Sponsorship is not available for this role.')?.reason, 'no visa sponsorship')
  check('"who do not require sponsorship" is about the applicant, not a ban',
    eligibilityBlock(elig({ needsSponsorship: true }), job, 'Applicants who do not require sponsorship are welcome, and we can sponsor the right person.'), null)
  check('"sponsorship available" is kept',
    eligibilityBlock(elig({ needsSponsorship: true }), job, 'Visa sponsorship available for the right candidate.'), null)
  check('no sponsorship does not matter to someone who does not need it',
    eligibilityBlock(elig({ workStatus: 'citizen', needsSponsorship: false }), job, 'We cannot sponsor visas.'), null)
  check('a clearance already held, for someone without one',
    eligibilityBlock(elig({ holdsClearance: false }), job, 'You must hold a current NV1 security clearance.')?.reason, 'an existing security clearance is required')
  check('"able to obtain" a clearance is kept',
    eligibilityBlock(elig({ holdsClearance: false }), job, 'Clearance required — must be able to obtain a Baseline clearance.'), null)
  check('a clearance requirement is ignored when unstated',
    eligibilityBlock(elig({ workStatus: 'citizen' }), job, 'You must hold a current NV1 security clearance.'), null)

  // ── Weekly goals ──────────────────────────────────────────────────
  // Thursday 6pm local: 3.75 days of 7 gone.
  const thursday = new Date(2026, 10, 12, 18, 0, 0)
  check('the week starts on Monday', goals.weekStart(thursday).getDay(), 1)
  const p = goals.progress({
    now: thursday,
    cfg: { weeklyGoals: { applications: 10, followUps: 2, contacts: 0 } },
    activity: { applications: 2, followUps: 2, contacts: 5 },
  })
  check('a goal of 0 is not shown', p.goals.map(g => g.key), ['applications', 'followUps'])
  check('2 of 10 by Thursday evening is behind', p.goals[0].state, 'behind')
  check('a met goal is done', p.goals[1].state, 'done')
  check('the nudge names what is behind', /2\/10 applications sent/.test(goals.nudgeText(p)), true)
  const tuesday = goals.progress({ now: new Date(2026, 10, 10, 9, 0, 0), cfg: { weeklyGoals: { applications: 10 } }, activity: { applications: 1 } })
  check('1 of 10 on Tuesday morning is on pace', tuesday.goals[0].state, 'on-track')
  check('nothing behind, no nudge', goals.nudgeText(tuesday), null)
  check('targets are clamped and whole', goals.normaliseTargets({ applications: '7.9', followUps: -3, contacts: 9999 }), { applications: 7, followUps: 0, contacts: 200 })

  // ── Skills gap ────────────────────────────────────────────────────
  const ad = (company, text, score = 60) => ({ company, job_title: 'Engineer', job_description: text, match_score: score })
  const report = skills.analyse({
    cfg: { masterResume: 'Built React apps in TypeScript.', skillTerms: 'Kafka Streams' },
    jobs: [
      ad('A', 'React, TypeScript, AWS and Docker. You will excel and react to change with the rest of the team.', 80),
      ad('B', 'AWS, Kubernetes, React and Node.js services.'),
      ad('C', 'AWS Lambda, Kafka Streams, Terraform.'),
      ad('D', 'Docker and AWS.'),
    ],
    minJobs: 2, minShare: 0.1,
  })
  check('a skill the résumé lacks is listed with its count', report.missing.find(r => r.skill === 'AWS')?.jobs, 4)
  check('a skill the résumé names is covered', report.covered.map(r => r.skill).includes('React'), true)
  check('"you will excel" is not Excel', report.missing.concat(report.covered).some(r => r.skill === 'Excel'), false)
  check('"Node.js" is not JavaScript', report.missing.concat(report.covered).some(r => r.skill === 'JavaScript'), false)
  check('a skill below the minimum is not a trend', report.missing.some(r => r.skill === 'Terraform'), false)
  check('high-scoring ads are counted separately', report.covered.find(r => r.skill === 'React')?.strongMatches, 1)
  check('four ads are too few to call a trend', report.enoughData, false)
  const custom = skills.analyse({ cfg: { skillTerms: 'Kafka Streams' }, jobs: [ad('C', 'Kafka Streams'), ad('E', 'kafka streams too')], minJobs: 2, minShare: 0 })
  check('a user\'s own skill is tracked', custom.missing.find(r => r.skill === 'Kafka Streams')?.jobs, 2)

  // ── Thank-you draft ──────────────────────────────────────────────
  const app = { job_title: 'Engineer' }
  const parsed = parseDraft(`Subject: Thank you for today\n\nHi Sam,\n\nThanks for your time. I enjoyed discussing ${PLACEHOLDER}.\n\nBest,\nAlex`, app)
  check('the subject line is split off', parsed.subject, 'Thank you for today')
  check('and the body kept', parsed.body.startsWith('Hi Sam,'), true)
  const missing = parseDraft('Hi Sam,\n\nThanks for your time today.\n\nBest,\nAlex', app)
  check('a draft without a subject gets a plain one', missing.subject, 'Thank you — Engineer interview')
  check('a draft without the placeholder gets one', missing.body.includes(PLACEHOLDER), true)

  done()
})()
