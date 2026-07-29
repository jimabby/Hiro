// The daily apply limit must count only applications that were actually SENT.
//
// getTodayCountByPlatform had no status filter, so rows saved as 'skipped'
// (scored below the match threshold) consumed the limit. With the default
// threshold of 80 and a limit of 10, a scan whose first ten jobs scored badly
// broke out of the loop having applied to nothing at all.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-daily-limit-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()

const insert = (status, i, platform = 'Seek') => db.insertApplication({
  job_title: `Role ${i}`, company: `Co ${i}`, platform,
  job_url: `https://example.com/${platform}/${i}`,
  job_description: '', match_score: 50, tailored_resume: '', screening_qa: [], status,
})

;(async () => {
  await db.init()

  for (let i = 0; i < 5; i++) insert('skipped', i)
  check('skipped rows do not consume the daily limit', db.getTodayCountByPlatform('Seek'), 0)

  for (let i = 5; i < 8; i++) insert('held', i)
  check('held rows do not consume it either', db.getTodayCountByPlatform('Seek'), 0)

  for (let i = 8; i < 11; i++) insert('applied', i)
  check('submitted rows do consume it', db.getTodayCountByPlatform('Seek'), 3)

  // A reply that moves the row forward must not release the slot — it was
  // still an application sent today.
  const applied = db.getApplications({ status: 'applied' })
  db.updateApplicationStatus(applied[0].id, 'interview')
  check('an interview still counts against the limit', db.getTodayCountByPlatform('Seek'), 3)

  insert('applied', 20, 'Indeed')
  check('limits are per platform', db.getTodayCountByPlatform('Seek'), 3)
  check('other platform counted separately', db.getTodayCountByPlatform('Indeed'), 1)

  // ── Rates must exclude anything never sent ──────────────────────
  const stats = db.getStats()
  // 3 Seek 'applied' (one now interview) + 1 Indeed = 4 sent; 1 reached interview.
  check('response denominator excludes skipped and held', stats.interviewRate, 25)
  check('held jobs are reported separately', stats.heldCount, 3)

  done()
})()
