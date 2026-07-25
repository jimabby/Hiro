// Resume routing: which base resume a job gets. Silent when wrong — a
// misrouted job still applies successfully, just with the wrong resume, so
// nothing surfaces the mistake. Precedence and fallback are the whole contract.

const { stub, service, createChecker } = require('./helpers')

// applicator pulls in the scrapers (and through them Playwright) at module
// load; stub them out so this stays a pure unit test.
const noopScraper = { scrape: async () => [], getJobDescription: async () => '', apply: async () => ({ success: true }) }
stub({
  './scraper/seek': noopScraper,
  './scraper/indeed': noopScraper,
  './scraper/linkedin': noopScraper,
  './ai/index': {},
  './database': {},
  './scraper/utils': { randomDelay: async () => {}, stripMarkdown: (s) => s },
})

const { selectResume } = service('applicator')
const { check, done } = createChecker()

const RESUMES = [
  { id: 'general', name: 'General', text: 'general resume' },
  { id: 'data', name: 'Data', text: 'data resume' },
  { id: 'frontend', name: 'Frontend', text: 'frontend resume' },
]

const cfg = (rules, defaultResumeId = 'general') => ({
  resumes: RESUMES, resumeRules: rules, defaultResumeId, masterResume: 'master',
})

const pick = (rules, job, defaultResumeId) =>
  selectResume(cfg(rules, defaultResumeId), job).resume?.id ?? null

// ── Matching ──────────────────────────────────────────────────────
check('matches on job title',
  pick([{ id: '1', keywords: 'data', resumeId: 'data' }], { job_title: 'Data Engineer', job_description: '' }),
  'data')

check('matches on description when title does not mention it',
  pick([{ id: '1', keywords: 'kubernetes', resumeId: 'data' }],
    { job_title: 'Platform Engineer', job_description: 'You will run Kubernetes clusters.' }),
  'data')

check('matching is case-insensitive',
  pick([{ id: '1', keywords: 'REACT', resumeId: 'frontend' }], { job_title: 'react developer', job_description: '' }),
  'frontend')

check('any keyword in the list can match',
  pick([{ id: '1', keywords: 'sql, analytics, etl', resumeId: 'data' }],
    { job_title: 'Analytics Lead', job_description: '' }),
  'data')

check('keywords are trimmed',
  pick([{ id: '1', keywords: '  data  ,  ', resumeId: 'data' }], { job_title: 'Data Analyst', job_description: '' }),
  'data')

// ── Precedence ────────────────────────────────────────────────────
check('first matching rule wins',
  pick([
    { id: '1', keywords: 'engineer', resumeId: 'frontend' },
    { id: '2', keywords: 'data', resumeId: 'data' },
  ], { job_title: 'Data Engineer', job_description: '' }),
  'frontend')

check('later rule applies when the earlier one does not match',
  pick([
    { id: '1', keywords: 'designer', resumeId: 'frontend' },
    { id: '2', keywords: 'data', resumeId: 'data' },
  ], { job_title: 'Data Engineer', job_description: '' }),
  'data')

// ── Fallback ──────────────────────────────────────────────────────
check('no rules falls back to default',
  pick([], { job_title: 'Data Engineer', job_description: '' }), 'general')

check('no match falls back to default',
  pick([{ id: '1', keywords: 'nursing', resumeId: 'data' }], { job_title: 'Data Engineer', job_description: '' }),
  'general')

check('rule pointing at a deleted resume falls back rather than breaking',
  pick([{ id: '1', keywords: 'data', resumeId: 'deleted-id' }], { job_title: 'Data Engineer', job_description: '' }),
  'general')

check('rule with empty keywords is ignored',
  pick([{ id: '1', keywords: '', resumeId: 'data' }], { job_title: 'Data Engineer', job_description: '' }),
  'general')

check('rule with no resumeId is ignored',
  pick([{ id: '1', keywords: 'data' }], { job_title: 'Data Engineer', job_description: '' }),
  'general')

check('null job (pre-scan baseline) uses default',
  pick([{ id: '1', keywords: 'data', resumeId: 'data' }], null), 'general')

// ── Resume text actually resolves ─────────────────────────────────
check('selected resume carries its text',
  selectResume(cfg([{ id: '1', keywords: 'data', resumeId: 'data' }]), { job_title: 'Data Engineer' }).resume.text,
  'data resume')

check('reports which keywords matched, for the activity log',
  selectResume(cfg([{ id: '1', keywords: 'sql, data', resumeId: 'data' }]), { job_title: 'Data Engineer' }).ruleKeywords,
  'sql, data')

check('no rule match reports no keywords',
  selectResume(cfg([]), { job_title: 'Data Engineer' }).ruleKeywords, null)

done()
