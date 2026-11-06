// Tailored text written back into the candidate's own DOCX: lines are aligned
// to paragraphs by content, not position, and only the changed characters are
// rewritten, so bold labels, hyperlinks and title<TAB>date lines survive.
// Also the PDF-path repairs: page footers dropped, wrapped lines rejoined.

const { createChecker } = require('./helpers')
const { applyTailoring } = require('../electron/services/docxTailor')
const { unwrapExtractedLines } = require('../electron/services/scraper/utils')

const { check, done } = createChecker()

const para = (body, style = 'Normal') => `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs></w:pPr>${body}</w:p>`
const run = (text, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const tab = '<w:r><w:tab/></w:r>'
const doc = paras => `<?xml version="1.0"?><w:document><w:body>${paras.join('')}<w:sectPr/></w:body></w:document>`

const XML = doc([
  para(run('Jane Doe', true), 'Title'),
  para(run('Languages: ', true) + run('Python, SQL')),
  para(run('Engineer', true) + tab + run('2020 - Present'), 'Heading2'),
  para(run('•') + tab + run('Built pipelines'), 'Bullet'),
  para(run('•') + tab + run('Ran on-call'), 'Bullet'),
  para(run('Cert A') + tab + run('2023')),
  para(run('Cert B') + tab + run('2024')),
])
const BASE = 'Jane Doe\nLanguages: Python, SQL\nEngineer\t2020 - Present\n•\tBuilt pipelines\n•\tRan on-call\nCert A\t2023\nCert B\t2024'

const paras = xml => xml.match(/<w:p(?=[\s>])[\s\S]*?<\/w:p>/g)
const textOf = p => [...p.matchAll(/<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map(m => m[1] ?? '\t').join('')
const runsOf = p => (p.match(/<w:r(?=[\s>])[\s\S]*?<\/w:r>/g) || []).map(r => `${/<w:b\/>/.test(r) ? 'B:' : ''}${textOf(r)}`)

check('unchanged text leaves the XML byte-for-byte', applyTailoring(XML, BASE), XML)

{
  const out = applyTailoring(XML, BASE.replace('Python, SQL', 'SQL, Python, dbt'))
  check('a reworded skills line keeps its bold label and plain value', runsOf(paras(out)[1]), ['B:Languages: ', 'SQL, Python, dbt'])
}

{
  const out = paras(applyTailoring(XML, BASE.replace('•\tBuilt pipelines', '•\tBuilt pipelines\n•\tAdded alerting')))
  check('an added bullet is inserted, not shifted into the next paragraph', out.map(textOf), [
    'Jane Doe', 'Languages: Python, SQL', 'Engineer\t2020 - Present',
    '•\tBuilt pipelines', '•\tAdded alerting', '•\tRan on-call', 'Cert A\t2023', 'Cert B\t2024',
  ])
  check('the added bullet carries its neighbour\'s style', /w:val="Bullet"/.test(out[4]), true)
  check('every certification keeps its own year', textOf(out[7]), 'Cert B\t2024')
}

{
  const out = paras(applyTailoring(XML, BASE.replace('\n•\tRan on-call', '')))
  check('a dropped bullet removes its paragraph', out.map(textOf).includes('•\tRan on-call'), false)
  check('and nothing after it moves', textOf(out[out.length - 1]), 'Cert B\t2024')
}

{
  const out = paras(applyTailoring(XML, BASE.replace('Engineer\t2020', 'Senior Engineer   2020')))
  check('a tab the model turned into spaces is put back', runsOf(out[2]), ['B:Senior Engineer', '\t', '2020 - Present'])
}

check('XML special characters are escaped', /R&amp;D/.test(applyTailoring(XML, BASE.replace('Ran on-call', 'Ran R&D on-call'))), true)

{
  const lines = unwrapExtractedLines([
    'Jane Doe | 1', 'Jane Doe', 'Skills', 'Languages: Python, SQL, and a long list of other things that runs to the margin',
    'Tools: Git', 'Experience', 'Engineer Jan 2020 - Present',
    '• Built pipelines that moved data between the warehouse and',
    'the reporting layer.', '• Ran on-call', '-- 1 of 2 --', 'Professional Experience',
  ])
  check('PDF footers are dropped and wrapped lines rejoined', lines, [
    'Jane Doe', 'Skills', 'Languages: Python, SQL, and a long list of other things that runs to the margin',
    'Tools: Git', 'Experience', 'Engineer Jan 2020 - Present',
    '• Built pipelines that moved data between the warehouse and the reporting layer.', '• Ran on-call',
    'Professional Experience',
  ])
}

{
  const { stripUnprintable, toWinAnsi } = require('../electron/services/textClean')
  check('accented names survive import clean-up', stripUnprintable('José Núñez, Zürich\u0007\uFFFD'), 'José Núñez, Zürich')
  check('a Symbol-font bullet becomes a bullet', stripUnprintable('\uF0B7\tLed'), '•\tLed')
  check('the PDF keeps Latin-1 and drops what Helvetica cannot draw', toWinAnsi('Zoë 李 €5'), 'Zoë  €5')
  const out = applyTailoring(doc([para(run('José Núñez', true)), para(run('Built it'))]), 'José Núñez\nBuilt it well')
  check('an accented name in the DOCX is matched, not rewritten', /José Núñez/.test(out) && /Built it well/.test(out), true)
}

// ── Text boxes ───────────────────────────────────────────────────
// A two-column template's sidebar is a text box: paragraphs INSIDE a paragraph,
// stored twice (mc:Choice for Word, mc:Fallback for older readers and for
// mammoth, the importer). The paragraph regex could not nest, so dropping the
// line holding the box left a dangling </w:p> — a file Word will not open,
// uploaded to the employer.
{
  const box = lines => `<w:txbxContent>${lines.map(l => para(run(l))).join('')}</w:txbxContent>`
  const boxed = (sidebar) => doc([
    `<w:p>${run('Jane Doe')}<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx>${box(sidebar)}</wps:txbx></w:drawing></mc:Choice>`
      + `<mc:Fallback><w:pict><v:textbox>${box(sidebar)}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    para(run('Experience')),
    para(run('Did things')),
  ])
  const SIDEBAR = ['Skills', 'Python', 'SQL']
  const XMLB = boxed(SIDEBAR)
  // The importer's reading: the paragraph, then its text box, the legacy copy skipped.
  const BASEB = 'Jane Doe\nSkills\nPython\nSQL\nExperience\nDid things'
  const balanced = x => (x.match(/<w:p(?=[\s>])/g) || []).length === (x.match(/<\/w:p>/g) || []).length
  const boxes = x => [...x.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)].map(m => paras(m[1]).map(textOf))

  check('a résumé with a text box is left byte-for-byte when nothing changed', applyTailoring(XMLB, BASEB), XMLB)

  let out = applyTailoring(XMLB, BASEB.replace('Python', 'Python, dbt'))
  check('a sidebar line is edited in place', boxes(out)[0], ['Skills', 'Python, dbt', 'SQL'])
  check('and the legacy copy matches it', boxes(out)[1], boxes(out)[0])
  check('the paragraphs still balance', balanced(out), true)

  out = applyTailoring(XMLB, BASEB.replace('Jane Doe\n', ''))
  check('dropping the line that holds the box keeps the box', boxes(out)[0], SIDEBAR)
  check('and leaves a file Word can open', balanced(out), true)

  out = applyTailoring(XMLB, 'Jane Doe\nExperience\nDid things')
  check('a text box emptied by the model keeps one paragraph', boxes(out)[0].length, 1)
  check('with no text in it', boxes(out)[0][0], '')

  out = applyTailoring(XMLB, BASEB.replace('SQL', 'SQL\nAirflow'))
  check('a line added to the sidebar goes inside the text box', boxes(out)[0], ['Skills', 'Python', 'SQL', 'Airflow'])
  check('and into the legacy copy', boxes(out)[1], ['Skills', 'Python', 'SQL', 'Airflow'])
  check('not into the body', paras(out.replace(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g, '')).map(textOf).includes('Airflow'), false)
}

// ── Table cells ──────────────────────────────────────────────────
// A cell must hold at least one paragraph, or Word reports the file corrupt.
{
  const cell = text => `<w:tc>${para(run(text))}</w:tc>`
  const XMLT = doc([`<w:tbl><w:tr>${cell('Engineer')}${cell('2020')}</w:tr></w:tbl>`, para(run('Built it'))])
  const out = applyTailoring(XMLT, 'Engineer\nBuilt it')
  check('a dropped line in a one-paragraph cell empties the cell rather than deleting it', /<w:tc><w:p/.test(out.split('</w:tc>')[1] + '</w:tc>'), true)
  check('every cell still has a paragraph', (out.match(/<w:tc>/g) || []).length, (out.match(/<w:tc><w:p/g) || []).length)
}

// A file the regexes misread must never be written.
{
  let threw = false
  try { applyTailoring('<w:document><w:body><w:p>' + run('A') + '</w:body></w:document>', 'B') } catch { threw = true }
  check('an unbalanced document is refused, so the PDF fallback is used', threw, true)
}

done()
