// The applicator's ATS path, end to end against a real database.
//
// This suite exists because of a bug the packaged smoke test found and no unit
// test could: nothing set `job_description` on an ATS job, so insertAttentionJob
// bound `undefined`, and sql.js refused it — by throwing a bare STRING. The
// applicator's catch logged `err.message`, which for a string is undefined, so
// the failure surfaced as "Scan error: undefined" and every single career-board
// match was silently dropped.
//
// ats-boards.test.js covers the parsing; this covers what happens to a parsed job
// afterwards. The two halves were each tested and the seam between them was not.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-ats-apply-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({
  './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) },
  './logger': { append: () => {} },
})

const db = service('database')
const ats = service('scraper/ats')
const ai = service('ai/index')
const applicator = service('applicator')
const { check, done } = createChecker()

// Shaped exactly as ats.scrape() returns them: a `_description` and no
// `job_description`, which is the detail the bug turned on.
const JOBS = [
  {
    job_title: 'Senior Platform Engineer',
    company: 'Career Board Co',
    salary: '$180,000 - $210,000',
    job_url: 'https://boards.example/jobs/1',
    _description: 'Node.js, Postgres and a large Kubernetes estate.',
    _provider: 'Greenhouse',
  },
  {
    job_title: 'Staff Infrastructure Engineer',
    company: 'Career Board Co',
    salary: '',
    job_url: 'https://boards.example/jobs/2',
    _description: 'Terraform and AWS.',
    _provider: 'Greenhouse',
  },
]

const CFG = {
  setupComplete: true,
  aiProvider: 'claude',
  aiApiKey: 'not-a-real-key',
  masterResume: 'Jane Test',
  matchThreshold: 50,
  enableSeek: false,
  enableIndeed: false,
  enableLinkedIn: false,
  enableAtsBoards: true,
  atsBoards: [{ provider: 'greenhouse', slug: 'careerboardco', label: 'Career Board Co' }],
  dailyLimitAts: 10,
}

const logs = []
const notified = []

async function main() {
  await db.init()

  // The two external boundaries, replaced at the module level — the same seam the
  // packaged smoke test uses, so the pipeline between them is entirely real.
  ats.scrape = async () => { ats.primeDescriptions(JOBS); return JOBS.map(j => ({ ...j })) }
  ai.scoreMatchWithExplanation = async () => ({ score: 91, explanation: 'Strong overlap.' })
  ai.tailorResume = async () => 'Tailored resume text'
  ai.generateCoverLetter = async () => 'Cover letter text'
  ai.generateTalkingPoints = async () => '- Ran a 200-node Kubernetes estate'

  const result = await applicator.run(CFG, {
    log: (m) => logs.push(m),
    notifyAttention: (j) => notified.push(j),
  })

  // The regression itself: the run must not have errored, and the rows must exist.
  check('the scan reports no scoring failures', result.scoringFailures, 0)
  check('nothing was auto-submitted — career boards cannot be', result.applied, 0)
  check('every matched job was filed under Needs Attention', db.getAttentionJobs().length, 2)
  check('and the user was told about each one', notified.length, 2)
  check('no error was logged',
    logs.filter(l => /error/i.test(l)), [])

  const row = db.getAttentionJobs().find(j => j.job_title === 'Senior Platform Engineer')
  check('the job was scored', row.match_score, 91)
  // The field that was undefined. It is also what the Needs Attention page shows,
  // so an empty one is a visible failure, not just a schema detail.
  check('the description came across', row.job_description, 'Node.js, Postgres and a large Kubernetes estate.')
  check('talking points were drafted', /Kubernetes/.test(row.talking_points), true)
  check('the salary range was normalised', [row.salary_min, row.salary_max], [180000, 210000])
  check('the reason explains why it needs a manual application',
    /submit on the site/i.test(row.reason), true)

  // ── The write is defensive on its own ────────────────────────
  // A caller that omits an optional field must not take the whole scan down with
  // it. Bound directly rather than through the applicator, because the point is
  // that the guard is at the write.
  let threw = null
  try {
    db.insertAttentionJob({
      job_title: 'Minimal Role',
      company: 'Sparse Ltd',
      platform: 'ATS',
      job_url: 'https://boards.example/jobs/3',
      // No job_description, no match_score, no salary, no talking_points.
    })
  } catch (err) {
    threw = err
  }
  check('a sparse attention job does not throw', threw, null)
  const sparse = db.getAttentionJobs().find(j => j.company === 'Sparse Ltd')
  check('and lands with an empty description rather than nothing', sparse.job_description, '')
  check('with a null score rather than a bound undefined', sparse.match_score, null)

  // ── Duplicates ───────────────────────────────────────────────
  // The same board re-scanned must not list the same job twice.
  ats.scrape = async () => { ats.primeDescriptions(JOBS); return JOBS.map(j => ({ ...j })) }
  await applicator.run(CFG, { log: (m) => logs.push(m), notifyAttention: () => {} })
  check('a re-scan does not duplicate rows',
    db.getAttentionJobs().filter(j => j.job_url === 'https://boards.example/jobs/1').length, 1)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
