// Résumé PDF layouts: every template builds, uses only PDF standard fonts, and
// an unknown or missing choice falls back to the original layout.

const fs = require('fs')
const { createChecker } = require('./helpers')
const { buildResumePDF, RESUME_TEMPLATES } = require('../electron/services/scraper/utils')

const { check, done } = createChecker()
const RESUME = 'Jane Doe\njane_doe@mail.com | +61 412 345 678\n\nEXPERIENCE\nAcme  Jan 2020 - Present\n- Built pipelines\n\nSKILLS\nLanguages: Python, SQL'
const STANDARD = /^(Helvetica|Times|Courier)/

async function main() {
  check('four layouts are offered', Object.keys(RESUME_TEMPLATES), ['classic', 'modern', 'compact', 'traditional'])
  check('every layout uses standard fonts only', Object.values(RESUME_TEMPLATES).every(t => Object.values(t.fonts).every(f => STANDARD.test(f))), true)

  const fontsIn = async (id) => {
    const p = await buildResumePDF(RESUME, 'Jane Doe', {}, id)
    const pdf = fs.readFileSync(p, 'latin1')
    fs.unlinkSync(p)
    return { valid: pdf.startsWith('%PDF'), times: pdf.includes('/Times-Roman'), helvetica: pdf.includes('/Helvetica') }
  }
  for (const id of Object.keys(RESUME_TEMPLATES)) check(`${id} builds a PDF`, (await fontsIn(id)).valid, true)
  check('traditional is set in Times', (await fontsIn('traditional')).times, true)
  check('classic is set in Helvetica', (await fontsIn('classic')).helvetica, true)
  const fallback = await fontsIn('no-such-template')
  check('an unknown layout falls back to classic', fallback.valid && fallback.helvetica && !fallback.times, true)
  const missing = await fontsIn(undefined)
  check('no choice is classic', missing.helvetica && !missing.times, true)
  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
