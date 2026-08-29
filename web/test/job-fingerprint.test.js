// Recognising the same advert again under a different URL.
//
// The existing duplicate checks all key on something a repost changes: the URL
// always, the title usually. So an employer taking a listing down and putting
// the identical text back up next month as "Data Engineer (Senior)" was scored,
// tailored and cover-lettered all over again — three model calls for an advert
// already paid for.
//
// The bias here is the point and is tested for directly: this only ever claims
// "identical", never "similar", because the two mistakes are not equal. Being
// scored twice costs a few cents. Skipping a real job costs the job.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-fingerprint-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
stub({ './config': { CONFIG_DIR: TMP, load: () => ({}), update: () => ({}) }, './logger': { append: () => {} } })

const fp = service('jobFingerprint')
const db = service('database')
const { check, done } = createChecker()

// Long enough to clear the minimum — a three-line advert is mostly boilerplate
// and cannot distinguish two roles at the same employer.
const AD = `We are looking for a Senior Data Engineer to join our platform team in Sydney.
You will build and maintain batch and streaming pipelines, own the warehouse models,
and work closely with analysts to make the numbers trustworthy. We use Python, dbt,
Airflow and Snowflake. Five years of experience with production data systems is expected,
along with strong SQL and a habit of writing things down. We offer flexible hours,
a learning budget, and a team that reviews each other's work properly.`

;(async () => {
  // ── Normalisation: what may differ without being a different ad ──
  const base = fp.fingerprint('Acme', AD)
  check('a long advert is fingerprinted', typeof base, 'string')

  check('reformatted whitespace is the same advert',
    fp.fingerprint('Acme', AD.replace(/\n/g, '\r\n').replace(/ /g, '  ')), base)
  check('a change of case is the same advert',
    fp.fingerprint('Acme', AD.toUpperCase()), base)
  check('smart quotes and bullets are the same advert',
    fp.fingerprint('Acme', AD.replace(/'/g, '’').replace(/\./g, ' • ')), base)
  check('the company name is matched loosely',
    fp.fingerprint('  acme  ', AD), base)
  // A repost always carries a new reference number and new tracking links, so
  // leaving either in would defeat the entire check.
  check('a new reference number is the same advert',
    fp.fingerprint('Acme', `${AD}\nRef: ABC-99812`), fp.fingerprint('Acme', `${AD}\nRef: ZZZ-11111`))
  check('different tracking links are the same advert',
    fp.fingerprint('Acme', `${AD}\nApply: https://x.test/a?utm=1`),
    fp.fingerprint('Acme', `${AD}\nApply: https://x.test/b?utm=2`))

  // ── What must NOT collide ────────────────────────────────────────
  check('a different employer is a different advert',
    fp.fingerprint('Globex', AD) === base, false)
  check('a genuinely rewritten advert is a different advert',
    fp.fingerprint('Acme', AD.replace('Snowflake', 'BigQuery')) === base, false)
  check('an added requirement is a different advert',
    fp.fingerprint('Acme', `${AD}\nKubernetes experience is required.`) === base, false)

  // ── Too little to go on ──────────────────────────────────────────
  // Short adverts are mostly boilerplate two different roles can share, which is
  // exactly the false positive that would hide a real job.
  check('a short advert is not fingerprinted', fp.fingerprint('Acme', 'Data Engineer. Apply within.'), null)
  check('an empty advert is not fingerprinted', fp.fingerprint('Acme', ''), null)
  check('a missing advert is not fingerprinted', fp.fingerprint('Acme', null), null)

  // ── Through the database ─────────────────────────────────────────
  await db.init()
  db.insertApplication({
    job_title: 'Senior Data Engineer', company: 'Acme', platform: 'Seek',
    job_url: 'https://seek.test/1', job_description: AD, match_score: 88,
    tailored_resume: 'r', status: 'applied',
  })

  const repost = db.findJobByContent('Acme', AD)
  check('the same advert is recognised later', !!repost, true)
  // Naming what it repeats is what makes the log line actionable.
  check('and names the listing it repeats', repost.job_title, 'Senior Data Engineer')
  check('and when it was seen', typeof repost.seen_at, 'string')
  check('and which table it came from', repost.source, 'application')

  // The title changed and the URL changed — every other check misses this.
  check('a renamed repost is still recognised',
    !!db.findJobByContent('Acme', `${AD}   `), true)
  check('an unrelated advert is not a repost',
    db.findJobByContent('Acme', AD.replace('Snowflake', 'BigQuery')), null)
  check('the same text at another company is not a repost',
    db.findJobByContent('Globex', AD), null)

  // A listing that only ever reached Needs Attention still counts as seen — a
  // failed apply is not a reason to pay for the advert twice.
  const OTHER = AD.replace('Sydney', 'Melbourne')
  db.insertAttentionJob({
    job_title: 'Data Platform Engineer', company: 'Acme', platform: 'Seek',
    job_url: 'https://seek.test/2', job_description: OTHER, reason: 'apply failed',
  })
  const fromAttention = db.findJobByContent('Acme', OTHER)
  check('an advert seen only in Needs Attention counts', !!fromAttention, true)
  check('and says so', fromAttention.source, 'attention')

  // ── Suppression follows the advert, not the title ────────────────
  // "This role keeps being reposted" is a statement about the listing, and the
  // repost that comes back renamed is precisely the one the title key misses.
  db.suppressRole({ company: 'Acme', jobTitle: 'Senior Data Engineer', reason: 'Ghost job' })
  const suppressed = db.isContentSuppressed('Acme', AD)
  check('a suppressed advert is recognised by its text', !!suppressed, true)
  check('and names the role it was suppressed as', suppressed.job_title, 'Senior Data Engineer')
  check('suppression does not leak to a different advert',
    db.isContentSuppressed('Acme', AD.replace('Snowflake', 'BigQuery')), null)
  check('nor to another employer', db.isContentSuppressed('Globex', AD), null)
  // The original title check is untouched.
  check('the exact title is still suppressed', db.isRoleSuppressed('Acme', 'Senior Data Engineer'), true)
  check('and other roles there are not', db.isRoleSuppressed('Acme', 'Office Manager'), false)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
