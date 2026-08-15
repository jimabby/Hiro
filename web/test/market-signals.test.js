// Two reports drawn from history the app was already keeping but never read.
//
//   getGhostJobs      — listings an employer keeps reposting. Each repost has a
//                       new URL, so the duplicate check cannot see it and every
//                       reappearance costs another three model calls. The
//                       pattern only exists across scans.
//
//   getSalaryBenchmark — what comparable roles were ADVERTISED at, so an offer
//                       can be placed against something. The Offers page could
//                       say what an offer is but nothing about whether it was
//                       good.
//
// Both are judgements about employers and pay, so the assertions here are as
// much about what they refuse to claim as about what they find: a repost that is
// really one listing seen twice, and a "percentile" drawn from three adverts,
// are both worse than saying nothing.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-signals-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

// insertApplication stamps "now", and a repost pattern is by definition spread
// over months — so the rows have to be genuinely backdated on disk and the
// module re-opened from the modified file, the same approach database.test.js
// uses for the cooldown window.
async function backdate(updates) {
  const SQL = await require('sql.js')()
  const file = path.join(TMP, 'autoapply.db')
  const handle = new SQL.Database(fs.readFileSync(file))
  for (const [jobUrl, days] of updates) {
    handle.run(
      "UPDATE applications SET applied_at = datetime('now', '-' || ? || ' days') WHERE job_url = ?",
      [days, jobUrl]
    )
    handle.run(
      "UPDATE attention_jobs SET found_at = datetime('now', '-' || ? || ' days') WHERE job_url = ?",
      [days, jobUrl]
    )
  }
  fs.writeFileSync(file, Buffer.from(handle.export()))
  handle.close()
  await db.init()
}

async function main() {
  await db.init()

  // ─── Ghost jobs ────────────────────────────────────────────────
  // A genuine serial reposter: same role, four distinct URLs, across four months.
  const ghost = [120, 90, 60, 10]
  ghost.forEach((_d, i) => {
    db.insertApplication({
      job_title: 'Platform Engineer', company: 'Everhiring Ltd', platform: 'Seek',
      job_url: `https://seek/everhiring/${i}`, job_description: '', match_score: 70,
      tailored_resume: '', screening_qa: [], status: 'applied', salary: '$150k',
    })
  })

  // One ordinary listing, applied to once.
  db.insertApplication({
    job_title: 'Platform Engineer', company: 'Normal Corp', platform: 'Seek',
    job_url: 'https://seek/normal/1', job_description: '', match_score: 70,
    tailored_resume: '', screening_qa: [], status: 'applied', salary: '$150k',
  })

  // A role recorded three times under the SAME url — one listing seen thrice,
  // which says nothing about the employer and must not be reported.
  for (let i = 0; i < 3; i++) {
    db.insertAttentionJob({
      job_title: 'Data Analyst', company: 'Sameurl Inc', platform: 'ATS',
      job_url: 'https://boards/sameurl/1', job_description: '', match_score: 60,
      reason: 'manual', talking_points: [],
    })
  }

  await backdate(ghost.map((d, i) => [`https://seek/everhiring/${i}`, d]))

  const ghosts = db.getGhostJobs()
  const found = ghosts.find(g => g.company === 'Everhiring Ltd')
  check('a serial reposter is reported', !!found, true)
  check('it counts distinct postings', found?.postings, 4)
  check('a single-posting role is not reported', ghosts.some(g => g.company === 'Normal Corp'), false)
  check('the same URL recorded repeatedly is not a repost',
    ghosts.some(g => g.company === 'Sameurl Inc'), false)
  check('a short span does not qualify', db.getGhostJobs({ minSpanDays: 365 }).length, 0)
  check('the posting-count floor is respected', db.getGhostJobs({ minPostings: 5 }).length, 0)

  // ─── Salary benchmark ──────────────────────────────────────────
  const ads = [
    ['Senior Backend Engineer', 140000, 160000],
    ['Backend Engineer (Senior)', 130000, 150000],
    ['Senior Backend Developer', 150000, 170000],
    ['Backend Engineer, Senior', 120000, 140000],
    ['Senior Backend Engineer - Remote', 160000, 180000],
    ['Veterinary Nurse', 60000, 70000],
    ['Veterinary Nurse (Senior)', 65000, 75000],
  ]
  ads.forEach(([title, min, max], i) => {
    db.insertApplication({
      job_title: title, company: `Co${i}`, platform: 'Seek',
      job_url: `https://seek/pay/${i}`, job_description: '', match_score: 70,
      tailored_resume: '', screening_qa: [], status: 'applied',
      salary: `$${min} - $${max}`, salary_min: min, salary_max: max,
    })
  })

  const bench = db.getSalaryBenchmark('Senior Backend Engineer')
  check('comparable ads are found', bench.sample, 5)
  check('an unrelated field is excluded', bench.sample < ads.length, true)
  check('the sample is large enough to place a figure', bench.comparable, true)
  check('the median is the middle of the comparable ads', bench.median, 150000)
  check('quartiles bracket the median', bench.p25 <= bench.median && bench.median <= bench.p75, true)

  check('a figure at the median reads as the 50th percentile',
    db.percentileFor(bench, 150000), 50)
  check('a figure below every ad reads as 0', db.percentileFor(bench, 50000), 0)
  check('a figure above every ad reads as 100', db.percentileFor(bench, 500000), 100)
  check('a strong figure lands in the upper half', db.percentileFor(bench, 168000) > 50, true)

  // Refusals.
  const thin = db.getSalaryBenchmark('Veterinary Nurse')
  check('a thin sample is still reported', thin.sample, 2)
  check('but it is not called comparable', thin.comparable, false)
  const unknown = db.getSalaryBenchmark('Underwater Basket Weaver')
  check('an unmatched title finds nothing', unknown.sample, 0)
  check('an unmatched title is not comparable', unknown.comparable, false)
  check('a blank title finds nothing', db.getSalaryBenchmark('').sample, 0)
  // Stopwords alone must not match every advert in the database.
  check('a title of only stopwords finds nothing', db.getSalaryBenchmark('the a of for').sample, 0)
  check('no percentile without a sample', db.percentileFor(unknown, 100000), null)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
