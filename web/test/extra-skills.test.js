// "Other skills you have": skills the user ticks in Settings as true though no
// résumé lists them (config.extraSkills). The catalog they are picked from, the
// picker's data, the prompts that pass them to the model, and the fabrication
// guard that accepts them on a skills line or in the summary, never in a bullet.

const fs = require('fs')
const os = require('os')
const path = require('path')
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-extra-skills-'))
process.on('exit', () => { try { fs.rmSync(process.env.HIRO_CONFIG_DIR, { recursive: true, force: true }) } catch {} })

const OpenAI = require('openai')
const { service, createChecker } = require('./helpers')
const { check, done } = createChecker()

const catalog = service('skillCatalog')
const skills = service('skillsGap')
const guard = service('fabricationGuard')
const config = service('config')
const local = service('ai/local')

const NL = String.fromCharCode(10)

;(async () => {
  // ── The catalog ───────────────────────────────────────────────────
  check('the stored list is names, unique and trimmed',
    catalog.cleanSkills([' SQL Server', 'SQL Server', '', 42, null, 'x'.repeat(61), 'Intune']), ['SQL Server', 'Intune'])
  check('anything but a list stores nothing', catalog.cleanSkills('SQL Server'), [])
  check('a licence is found with a curly apostrophe',
    catalog.matcherFor("Driver's licence").test('I hold a current driver’s licence.'), true)
  check('a name the catalog does not have is matched literally',
    catalog.matcherFor('Kdb+').test('Built tick storage in kdb+ for traders'), true)
  check('which ticked skills a line names, as written',
    catalog.tickedIn('Databases: MSSQL, PostgreSQL', catalog.tickedMatchers(['SQL Server', 'Intune'])), ['MSSQL'])

  // ── The picker's data ─────────────────────────────────────────────
  const cfg = { masterResume: 'Built APIs on PostgreSQL and Node.js.', extraSkills: ['SQL Server', 'Retired skill'] }
  const jobs = [
    { job_title: '.NET Developer', job_description: 'C#, ASP.NET Core and SQL Server. Azure DevOps pipelines.' },
    { job_title: 'Backend Engineer', job_description: 'PostgreSQL and SQL Server experience.' },
  ]
  const picked = skills.choices({ cfg, jobs })
  const find = (name) => picked.groups.flatMap(g => g.skills).find(s => s.name === name)
  check('a skill the résumé names is marked as on it', find('PostgreSQL').onResume, true)
  check('ads asking for a skill are counted', find('SQL Server').ads, 2)
  check('a ticked skill is marked ticked', find('SQL Server').ticked, true)
  check('picker-only tools are offered and counted', [find('Azure DevOps').ads, find('ASP.NET Core').ads], [1, 1])
  check('a ticked skill the catalog no longer has stays, so it can be unticked',
    picked.groups.at(-1), { group: 'Ticked earlier', skills: [{ name: 'Retired skill', onResume: false, ads: 0, ticked: true }] })

  // ── The guard ─────────────────────────────────────────────────────
  const base = [
    'Full Stack Developer | Mar 2026 - Present',
    'Northgate | Sydney | Full-time Contract',
    '- Built the Staff Hub using Angular, .NET and PostgreSQL.',
    'Databases: PostgreSQL, MySQL',
  ].join(NL)
  const sqlServer = { extraSkills: ['SQL Server'] }
  const toSkills = base.replace('Databases: PostgreSQL, MySQL', 'Databases: SQL Server, PostgreSQL, MySQL')
  check('a skill nobody ticked, added to a skills line, is flagged',
    guard.inspectTailoring(base, toSkills).flags.map(f => f.value), ['sql', 'server'])
  check('a ticked skill may be added to a skills line', guard.inspectTailoring(base, toSkills, sqlServer).safe, true)
  check('or named in a new summary line',
    guard.inspectTailoring(base, `Developer with SQL Server experience.${NL}${base}`, sqlServer).safe, true)
  check('but not put into a job\'s bullet: ticking it does not say that job used it',
    guard.inspectTailoring(base, base.replace('.NET and PostgreSQL.', '.NET, PostgreSQL and SQL Server.'), sqlServer).flags.map(f => f.value),
    ['sql', 'server'])
  check('ticking one skill allows no other',
    guard.inspectTailoring(base, toSkills.replace('MySQL', 'MySQL, Oracle'), sqlServer).flags.map(f => f.value), ['oracle'])

  const licence = { extraSkills: ["Driver's licence"] }
  check('a licence nobody ticked is flagged in a cover letter',
    guard.inspectCoverLetter(base, 'I hold a current driver’s licence.').flags.map(f => f.kind), ['credential'])
  check('a ticked licence may be mentioned', guard.inspectCoverLetter(base, 'I hold a current driver’s licence.', licence).safe, true)
  check('and does not vouch for a different licence',
    guard.inspectCoverLetter(base, 'I hold a current electrician\'s licence.', licence).flags.map(f => f.kind), ['credential'])
  check('a screening answer may state it too',
    guard.inspectScreeningAnswer(base, 'Yes, I hold a full driver\'s licence.', licence).safe, true)

  // ── The prompts ───────────────────────────────────────────────────
  let prompt = ''
  OpenAI.Chat.Completions.prototype.create = async function (params) {
    prompt = params.messages[params.messages.length - 1].content
    return { choices: [{ index: 0, message: { role: 'assistant', content: 'Yes' }, finish_reason: 'stop' }], usage: {} }
  }
  await local.tailorResume('A .NET job', 'A résumé', '', 'test-model')
  check('with nothing ticked the tailoring prompt is unchanged', prompt.includes('OTHER SKILLS'), false)

  config.update({ extraSkills: ['SQL Server', 'ASP.NET Core'] })
  await local.tailorResume('A .NET job', 'A résumé', '', 'test-model')
  check('ticked skills reach the tailoring prompt', prompt.includes('which the résumé does not list: SQL Server, ASP.NET Core.'), true)
  check('with the rule that keeps them out of bullets', prompt.includes('Never add one to a job\'s bullets'), true)
  await local.generateCoverLetter('A .NET job', 'A résumé', '', 'test-model')
  check('and reach the cover letter prompt', prompt.includes('The letter may mention any the job asks for'), true)
  await local.answerScreeningQuestion('Do you know SQL Server?', 'A .NET job', 'A résumé', '', 'test-model')
  check('and the screening answer prompt, without guessing years', prompt.includes('do not guess how long or where'), true)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
