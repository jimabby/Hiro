// Will an applicant tracking system be able to READ this resume?
//
// Keyword Gap answers "does this resume say the right things". This answers the
// question underneath it: does the document survive being parsed at all.
//
// The failure is silent by construction. A two-column layout, or a contact block
// in a Word header, or a resume built from a table, looks immaculate on screen
// and reads perfectly to a human — and comes out of a parser as interleaved
// fragments, or with no phone number, or as three characters of text. The
// application is rejected by a machine before a person sees it, and no feedback
// ever comes back.
//
// Every finding is advisory: this never blocks a submission and never edits a
// document. The tests below are as much about what it must NOT flag as about
// what it must, because a checker that cries wolf on a good resume gets ignored,
// and then it is not protecting anything.

const { stub, service, createChecker } = require('./helpers')

stub({ './config': { load: () => ({}) } })

const check_ = service('resumeParseCheck.js')
const { check, done } = createChecker()

const id = (finding) => finding?.id ?? null

// A realistic single-column resume: prose, bullets, contact details in the body.
const GOOD_RESUME = [
  'JIM SUN',
  'jim@example.com | +61 400 000 000 | Melbourne, VIC',
  '',
  'SUMMARY',
  'Data engineer with eight years building batch and streaming pipelines for retail and finance.',
  '',
  'EXPERIENCE',
  'Senior Data Engineer, Acme Analytics, 2021 to present',
  '- Led the migration of a nightly batch warehouse to an incremental streaming model, cutting end-to-end latency from six hours to under four minutes.',
  '- Rebuilt the ingestion layer in Python and Spark, and took ownership of its on-call rotation.',
  '- Mentored three junior engineers through their first production deployments.',
  '',
  'Data Engineer, Globex, 2018 to 2021',
  '- Designed the dimensional model behind the finance reporting suite, used daily by forty analysts.',
  '- Introduced dbt and a tested transformation layer, which removed a recurring class of silent data errors.',
  '',
  'SKILLS',
  'Python, SQL, Spark, dbt, Airflow, AWS, Snowflake, Kafka, Terraform',
].join('\n')

// ── Extraction size ──────────────────────────────────────────────
check('nothing extracted is an error', check_.checkExtractionSize('').severity, 'error')
check('and names the likely cause', /scanned image/.test(check_.checkExtractionSize('').detail), true)
check('almost nothing extracted is an error', id(check_.checkExtractionSize('Jim Sun')), 'almost-no-text')
check('a thin extraction is a warning only', check_.checkExtractionSize('x'.repeat(800)).severity, 'warning')
check('a full page is fine', check_.checkExtractionSize('x'.repeat(3000)), null)
check('the threshold is where the comment says it is',
  check_.checkExtractionSize('x'.repeat(check_.THIN_CHARS)), null)

// ── Contact details ──────────────────────────────────────────────
// The commonest real cause is a contact block in a Word header or a text box,
// both of which look fine on screen and are routinely dropped on extraction.
check('a resume with no contact details is an error',
  id(check_.checkContactDetails('EXPERIENCE\nDid things at places', null)), 'missing-contact')
check('a missing phone is caught',
  /phone number/.test(check_.checkContactDetails('jim@example.com only', null).title), true)
check('a missing email is caught',
  /email address/.test(check_.checkContactDetails('+61 400 000 000 only', null).title), true)
check('a resume with both is fine', check_.checkContactDetails(GOOD_RESUME, null), null)
check('an international format is recognised',
  check_.checkContactDetails('jim@example.com +1 (415) 555-0100', null), null)

// Present in the raw text but absent from the document body means the contact
// block lives in a header — mammoth drops those the same way many parsers do,
// so this is a direct read of the risk rather than an inference.
check('contact details only in the header are flagged',
  id(check_.checkContactDetails('jim@example.com +61 400 000 000\nEXPERIENCE', {
    kind: 'docx', bodyText: 'EXPERIENCE Did things at places',
  })), 'contact-in-header')
check('and it is a warning, not an error — Hiro can read it, the employer may not',
  check_.checkContactDetails('jim@example.com +61 400 000 000', {
    kind: 'docx', bodyText: 'nothing here',
  }).severity, 'warning')
check('contact details in the body are not flagged',
  check_.checkContactDetails(GOOD_RESUME, { kind: 'docx', bodyText: GOOD_RESUME }), null)

// ── Columns ──────────────────────────────────────────────────────
// A two-column layout flattens into alternating fragments. The bar has to be
// high: a resume is mostly bullets and headings, so short lines alone mean
// nothing.
const COLUMNAR = Array.from({ length: 40 }, (_, i) => (i % 2 ? `Skill ${i}` : `2019-202${i % 10}`)).join('\n')
check('a flattened two-column layout is flagged', id(check_.checkColumns(COLUMNAR)), 'possible-columns')
check('as a warning, because it is a judgement about someone else\'s parser',
  check_.checkColumns(COLUMNAR).severity, 'warning')
check('and it says what to look at', /reads out of order/.test(check_.checkColumns(COLUMNAR).fix), true)

check('an ordinary resume is NOT flagged as columnar', check_.checkColumns(GOOD_RESUME), null)
check('a short document is never flagged', check_.checkColumns('One\nTwo\nThree'), null)

// ── Tables and images ────────────────────────────────────────────
check('tables are flagged', id(check_.checkTables({ kind: 'docx', tables: 2 })), 'tables')
check('no tables is fine', check_.checkTables({ kind: 'docx', tables: 0 }), null)
check('tables are a docx concept only', check_.checkTables({ kind: 'pdf', tables: 3 }), null)

check('images with almost no text are flagged',
  id(check_.checkImageOnly('short', { kind: 'docx', images: 3 })), 'image-heavy')
check('images alongside real text are not',
  check_.checkImageOnly('x'.repeat(3000), { kind: 'docx', images: 3 }), null)

// ── Font encoding ────────────────────────────────────────────────
// The text is present and is gibberish to anything reading it, which is worse
// than absent: it scores as a resume that says nothing relevant.
check('replacement characters are an error',
  check_.checkEncoding(`Jim ${'�'.repeat(20)}`).severity, 'error')
check('and it counts them', /20 characters/.test(check_.checkEncoding(`x${'�'.repeat(20)}`).detail), true)
check('a stray one or two is not worth reporting', check_.checkEncoding('Jim � Sun'), null)

// ── inspect(), the whole pipeline ────────────────────────────────
;(async () => {
  const noFile = await check_.inspect(null, null)
  check('a text-only resume has nothing to check', noFile.unavailable, true)
  check('and says so without alarming anyone',
    /generated by Hiro and parses cleanly/.test(noFile.reason), true)

  const wrongType = await check_.inspect(__filename, 'js')
  check('an unsupported format is reported', wrongType.unavailable, true)
  check('and names the format', /\.js/.test(wrongType.reason), true)

  const missing = await check_.inspect('/definitely/not/here.pdf', 'pdf')
  check('a missing file is reported rather than thrown', missing.unavailable, true)

  check('the supported formats are the two that matter', check_.SUPPORTED.sort(), ['doc', 'docx', 'pdf'])

  done()
})()
