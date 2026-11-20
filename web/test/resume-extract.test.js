// Reading a résumé the user attached to Ask Hiro (or imported in Settings):
// PDF, Word and plain text come back as clean text, from bytes alone, and
// anything else is refused with a reason rather than read as garbage.

const fs = require('fs')
const { createChecker } = require('./helpers')
const { extractResumeText, extensionOf, wordCount, SUPPORTED } = require('../electron/services/resumeExtract')
const { buildResumePDF, buildResumeDocx } = require('../electron/services/scraper/utils')

const { check, done } = createChecker()
const RESUME = 'Jane Doe\njane_doe@mail.com | +61 412 345 678\n\nEXPERIENCE\nData Engineer at Acme  Jan 2020 - Present\n- Built pipelines in Python\n\nSKILLS\nLanguages: Python, SQL'

async function refused(promise) {
  try { await promise; return '' } catch (err) { return err.message }
}

async function main() {
  check('the supported kinds', SUPPORTED, ['pdf', 'docx', 'txt', 'md'])
  check('the extension is read case-insensitively', extensionOf('My CV.PDF'), 'pdf')
  check('no extension is no extension', extensionOf('resume'), '')
  check('words are counted', wordCount('one two\nthree'), 3)

  // ─── Plain text ────────────────────────────────────────────────
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Jane Doe\r\n\r\n\r\n\r\nEXPERIENCE   Acme')])
  const txt = await extractResumeText(bom, 'txt')
  check('a byte-order mark is dropped', txt.text.startsWith('Jane Doe'), true)
  check('Windows line endings and runs of blank lines are tidied', txt.text, 'Jane Doe\n\nEXPERIENCE Acme')
  check('Markdown is read as text', (await extractResumeText(Buffer.from('# Jane'), 'md')).text, '# Jane')

  // ─── Word ──────────────────────────────────────────────────────
  const docxPath = await buildResumeDocx(RESUME)
  const docx = await extractResumeText(fs.readFileSync(docxPath), 'docx')
  fs.unlinkSync(docxPath)
  check('a Word résumé is read from its bytes', docx.text.includes('Built pipelines in Python') && docx.text.includes('Jane Doe'), true)

  // ─── PDF ───────────────────────────────────────────────────────
  const pdfPath = await buildResumePDF(RESUME, 'Jane Doe', {}, 'minimal')
  const pdf = await extractResumeText(fs.readFileSync(pdfPath), 'pdf')
  fs.unlinkSync(pdfPath)
  check('a PDF résumé is read from its bytes', /Built pipelines/.test(pdf.text) && /Acme/.test(pdf.text), true)

  // ─── Refusals ──────────────────────────────────────────────────
  check('an empty file is refused', /empty/.test(await refused(extractResumeText(Buffer.alloc(0), 'txt'))), true)
  check('an old .doc says how to fix it', /\.docx/.test(await refused(extractResumeText(Buffer.from('x'), 'doc'))), true)
  check('an unsupported kind is refused', /PDF, Word/.test(await refused(extractResumeText(Buffer.from('x'), 'exe'))), true)
  check('a file over 10 MB is refused before it is parsed',
    /10 MB/.test(await refused(extractResumeText(Buffer.alloc(10 * 1024 * 1024 + 1), 'txt'))), true)
  check('a corrupt Word file is an error, not text', (await refused(extractResumeText(Buffer.from('not a zip'), 'docx'))).length > 0, true)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
