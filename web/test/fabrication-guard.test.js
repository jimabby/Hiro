const { service, createChecker } = require('./helpers')

const guard = service('fabricationGuard.js')
const { check, done } = createChecker()

const base = `Jane Example
Software Engineer at Acme Pty Ltd
January 2020 - March 2023
Bachelor of Computer Science
Built payment services.`

check('ordinary rewriting is allowed', guard.inspectTailoring(base, `${base}\nImproved service reliability.`).safe, true)

const date = guard.inspectTailoring(base, `${base}\nApril 2024 - Present`)
check('a newly invented date is blocked', date.safe, false)
check('date is identified', date.flags.some(f => f.kind === 'date'), true)

const credential = guard.inspectTailoring(base, `${base}\nAWS Certified Solutions Architect`)
check('a newly invented credential is blocked', credential.flags.some(f => f.kind === 'credential'), true)

const employment = guard.inspectTailoring(base, `${base}\nEngineering Manager at Globex Corporation`)
check('a newly invented title is blocked', employment.flags.some(f => f.kind === 'job-title'), true)
check('a newly invented employer is blocked', employment.flags.some(f => f.kind === 'employer'), true)

check('facts already present in the base are not flagged', guard.inspectTailoring(base, `${base}\nSoftware Engineer at Acme Pty Ltd`).safe, true)
check('empty inputs are safe', guard.inspectTailoring('', '').safe, true)

// ── Edited lines: true facts moved to where they are not true ──────────
// Each case is what qwen2.5:7b actually did to a real résumé. Every claim it
// made existed somewhere in the base, so none of the checks above fired.
const real = [
  'Full Stack Developer | Mar 2026 - Present',
  'Northgate | Sydney | Full-time Contract',
  '- Built the Staff Hub using Angular, .NET and PostgreSQL.',
  'Workflow Automation Developer | Jan 2026 - Aug 2026',
  'Bluegum Fittings | Sydney | Part-time Contract',
  '- Designed a workflow system covering the job lifecycle from booking through to invoicing.',
  '- Redesigned the website, improving performance by 30%.',
  'Languages: JavaScript, TypeScript, Python, C#',
].join(String.fromCharCode(10))
const edit = (from, to) => guard.inspectTailoring(real, real.replace(from, to))

const retitled = edit('Workflow Automation Developer | Jan', 'Full Stack Developer | Jan')
check('a title copied from another job onto this one is flagged', retitled.flags.map(f => f.kind), ['heading'])
check('which the whole-résumé checks alone missed (the title is in the base)',
  guard.inspectTailoring(real, real.replace('Workflow Automation Developer | Jan', 'Full Stack Developer | Jan')).safe, false)

const moved = edit('through to invoicing.', 'through to invoicing using React and Node.js.')
check('technologies appended to a job that never used them are flagged',
  moved.flags.filter(f => f.kind === 'moved-claim').map(f => f.value), ['react', 'node.js'])
check('a metric added to a line is flagged',
  edit('from booking through', 'from booking, for 40 technicians, through').flags.map(f => [f.kind, f.value]), [['figure', '40']])
check('the employer line is copied exactly',
  edit('Bluegum Fittings | Sydney | Part-time Contract', 'Bluegum Fittings | Sydney | Full-time').safe, false)

check('rewording a bullet in place is allowed',
  edit('- Designed a workflow system covering', '- Built a workflow system covering').safe, true)
check('capitalising words the line already had is allowed',
  edit('- Designed a workflow system covering', '- Designed a Workflow System covering').safe, true)
check('including the parts of a hyphenated word',
  guard.inspectTailoring('Full-stack software engineer with three years of experience.', 'Full Stack Software Engineer with three years of experience.').safe, true)
check('reordering a skills line to lead with the job\'s tools is allowed',
  edit('JavaScript, TypeScript, Python, C#', 'C#, Python, JavaScript, TypeScript').safe, true)
check('keeping a metric while rewording is allowed',
  edit('Redesigned the website, improving performance by 30%', 'Rebuilt the website, cutting load time by 30%').safe, true)
check('a skill new to the skills line is flagged', edit('Python, C#', 'Python, C#, Kubernetes').flags.map(f => f.value), ['kubernetes'])

// ── Added lines: nothing was edited, so there is no line to compare with ──
// Before this, every one of these came back safe.
const lines = real.split(String.fromCharCode(10))
const reshape = (fn) => { const out = [...lines]; fn(out); return guard.inspectTailoring(real, out.join(String.fromCharCode(10))) }
check('an invented bullet is flagged, though it edits no line',
  reshape(out => out.splice(3, 0, '- Administered Microsoft 365 and Intune for 300 staff.')).flags.map(f => f.value),
  ['microsoft', 'intune', '365', '300'])
check('a bullet moved, word for word, to another job is flagged',
  reshape(out => out.splice(5, 0, ...out.splice(2, 1))).flags.map(f => [f.kind, f.value]),
  [['moved-bullet', '- Built the Staff Hub using Angular, .NET and PostgreSQL.']])
// qwen2.5:7b copied two bullets that name nothing into another job. With no
// name or figure to compare, the block check alone let them through.
check('a bullet that names nothing, copied from another job, is flagged',
  reshape(out => out.splice(3, 0, lines[5])).flags.map(f => f.kind), ['moved-bullet'])
check('so is one put in place of a real bullet, where it reads as an edit',
  edit(lines[2], lines[5]).flags.map(f => f.kind), ['moved-bullet'])
check('a bullet split in two under its own job is allowed',
  reshape(out => out.splice(2, 1, '- Built the Staff Hub using Angular and .NET.', '- Stored its data in PostgreSQL.')).safe, true)
check('a new line naming a tool the résumé never mentions is flagged',
  reshape(out => out.push('Cloud: Kubernetes')).flags.map(f => f.value), ['kubernetes'])
check('a new line using only what the résumé already says is allowed',
  reshape(out => out.push('Comfortable across Python and C#.')).safe, true)

// ── Moved lines ─────────────────────────────────────────────────────────
// What a local Qwen3-30B did: changed the tense of two bullets and moved a
// third up its own job. The moved bullet used to be paired with an edited one
// and flagged for every name in it.
const oneJob = [
  'Full Stack Developer | Mar 2026 - Present',
  'Northgate | Sydney | Full-time Contract',
  '- Build production websites using React and Node.js.',
  '- Built the Staff Hub using Angular, .NET and PostgreSQL.',
  '- Developed role-based folders, document access and audit records.',
  '- Develop the content management system for Nestly.',
]
const reordered = [...oneJob]
reordered.splice(3, 2, oneJob[4], oneJob[3])
reordered[2] = '- Built production websites using React and Node.js.'
reordered[5] = '- Developed the content management system for Nestly.'
check('a bullet moved within its own job, between edited ones, is allowed',
  guard.inspectTailoring(oneJob.join(String.fromCharCode(10)), reordered.join(String.fromCharCode(10))).safe, true)
check('swapping two job titles is still a heading change, not a move',
  reshape(out => { [out[0], out[3]] = [out[3], out[0]] }).flags.map(f => f.kind), ['heading', 'heading'])
// Qwen3 ends every line with two spaces. With an added line, every pair below
// it used to be misaligned: a bullet compared with a job title, and so on.
check('trailing spaces on every line do not misalign the pairs',
  reshape(out => { out.splice(3, 0, '- Stored its data in PostgreSQL.'); for (let i = 0; i < out.length; i++) out[i] += '  ' }).safe, true)

// A sentence ending on the employer carries its full stop into the capture.
const letterBase = ['Software Engineer', 'Acme Pty Ltd 2019'].join(String.fromCharCode(10))
check('a sentence-final full stop does not make a known employer unknown',
  guard.inspectCoverLetter(letterBase, 'I built the billing service at Acme Pty Ltd.').safe, true)
check('an unknown employer is still flagged with its full stop',
  guard.inspectCoverLetter(letterBase, 'I built the billing service at Globex.').flags.map(f => f.value), ['Globex'])

done()
