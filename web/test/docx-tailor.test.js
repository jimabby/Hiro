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

done()
