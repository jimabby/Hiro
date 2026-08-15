// The daily cap on drafts held for review.
//
// getTodayCountByPlatform deliberately excludes 'held' and 'skipped', and that
// is correct for the limit it governs — the daily limit bounds what is SENT.
// But it meant that with review-before-submit on and no auto-submit threshold,
// nothing was ever sent, so the limit never engaged: a scan walked every listing
// it had scraped and paid for a score, a tailored résumé and a cover letter on
// each. Turning on the app's safest setting removed its only spending bound.
//
// So there are two ceilings now, one per outcome, and neither may leak into the
// other: drafts must not consume the send allowance, and sends must not consume
// the draft allowance.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-draft-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) } })

const db = service('database')
const { check, done } = createChecker()

let seq = 0
function add(platform, status) {
  db.insertApplication({
    job_title: `Role ${seq}`, company: `Co ${seq}`, platform,
    job_url: `https://x/${seq++}`, job_description: '', match_score: 85,
    tailored_resume: '', screening_qa: [], status,
  })
}

async function main() {
  await db.init()

  check('no drafts to begin with', db.getTodayHeldCountByPlatform('Seek'), 0)

  for (let i = 0; i < 3; i++) add('Seek', 'held')
  check('held drafts are counted', db.getTodayHeldCountByPlatform('Seek'), 3)

  // The two ceilings must stay independent.
  check('drafts do not consume the send allowance', db.getTodayCountByPlatform('Seek'), 0)

  for (let i = 0; i < 2; i++) add('Seek', 'applied')
  check('sent applications count toward the send allowance', db.getTodayCountByPlatform('Seek'), 2)
  check('sent applications do not consume the draft allowance', db.getTodayHeldCountByPlatform('Seek'), 3)

  // A rejected draft is filed as 'skipped', which frees draft headroom — that is
  // the point of the Review page, and a cap that ignored it would wedge the scan.
  add('Seek', 'skipped')
  check('skipped rows count against neither ceiling',
    [db.getTodayCountByPlatform('Seek'), db.getTodayHeldCountByPlatform('Seek')], [2, 3])

  // Per platform, not global.
  add('Indeed', 'held')
  check('the draft count is per platform', db.getTodayHeldCountByPlatform('Indeed'), 1)
  check('one platform does not affect another', db.getTodayHeldCountByPlatform('Seek'), 3)
  check('an unknown platform is zero, not an error', db.getTodayHeldCountByPlatform('Nope'), 0)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
