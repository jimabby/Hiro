// Skills employers keep asking for that the résumé never mentions.
//
// The keyword-gap analysis on a single job answers "what is this ad looking for
// that I have not said?" — useful for one application, and forgotten after it.
// The question worth changing the master résumé over is the aggregate one: over
// the last few months of ads Hiro has read, which skills come up again and
// again, and which of those does the résumé not name at all?
//
// Done locally and deterministically, against a vocabulary of skills (plus any
// the user adds), rather than by a model: it reads every recent ad on each run,
// costs nothing, gives the same answer twice, and a count of "12 of 40 ads" can
// be checked by opening those ads. A model asked to tally forty adverts would be
// none of those things.
//
// A skill the résumé does not name is NOT a claim the user lacks it — plenty of
// people have used Docker without writing it down. The report says "not in your
// résumé", and the decision to add it is the user's. Nothing here writes to a
// résumé.

const configService = require('./config')
const database = require('./database')

// The skills counted, and how each is spotted, live in ./skillCatalog.js.
const { VOCABULARY, REPORT_GROUPS, PICKER_GROUPS, compile, escapeRegExp, matcherFor, cleanSkills } = require('./skillCatalog')

const COMPILED = compile(VOCABULARY)

function customTerms(list) {
  const parts = Array.isArray(list) ? list : String(list || '').split(/[,\n]/)
  const out = {}
  for (const raw of parts) {
    const t = String(raw || '').trim()
    if (t && t.length <= 60) out[t] = [escapeRegExp(t.toLowerCase())]
  }
  return out
}

// Every résumé the user has, so a skill counted as missing really is missing
// from all of them — and the report can say which résumé does name it.
function resumesOf(cfg) {
  const list = (Array.isArray(cfg.resumes) ? cfg.resumes : [])
    .filter(r => r && typeof r.text === 'string' && r.text.trim())
    .map(r => ({ id: r.id, name: r.name || 'Résumé', text: r.text }))
  if (cfg.masterResume && !list.some(r => r.text === cfg.masterResume)) list.unshift({ id: 'master', name: 'Master résumé', text: cfg.masterResume })
  return list
}

// The report. `jobs` and `cfg` are injectable for tests.
//   minShare — a skill must appear in at least this share of ads to be listed
//   minJobs  — and in at least this many, so three ads cannot make a "trend"
function analyse({ cfg = configService.load(), jobs, days = 90, minShare = 0.1, minJobs = 3, limit = 25 } = {}) {
  const ads = jobs || database.getRecentJobDescriptions(days)
  const resumes = resumesOf(cfg)
  const matchers = [...COMPILED, ...compile(customTerms(cfg.skillTerms))]
  const sample = ads.length

  const rows = []
  for (const { skill, re } of matchers) {
    let count = 0
    let strong = 0
    const examples = []
    for (const ad of ads) {
      if (!re.test(`${ad.job_title || ''}\n${ad.job_description || ''}`)) continue
      count++
      if (Number(ad.match_score) >= 70) strong++
      if (examples.length < 3) examples.push({ company: ad.company || '', job_title: ad.job_title || '' })
    }
    if (!count) continue
    const inResumes = resumes.filter(r => re.test(r.text)).map(r => r.name)
    rows.push({ skill, jobs: count, share: sample ? Math.round((count / sample) * 100) / 100 : 0, strongMatches: strong, inResume: inResumes.length > 0, inResumes, examples })
  }
  rows.sort((a, b) => b.jobs - a.jobs || a.skill.localeCompare(b.skill))

  const trending = rows.filter(r => r.jobs >= minJobs && r.share >= minShare)
  return {
    sample,
    days,
    hasResume: resumes.length > 0,
    missing: trending.filter(r => !r.inResume).slice(0, limit),
    covered: trending.filter(r => r.inResume).slice(0, limit),
    // Too few ads to call anything a trend: said, rather than shown as an empty
    // report that reads as "your résumé covers everything".
    enoughData: sample >= Math.max(minJobs * 2, 8),
  }
}

// What the "Other skills you have" picker in Settings shows: every skill in the
// catalog, whether a résumé already names it (then there is nothing to tick),
// and how many recent ads ask for it, so the ones employers want can lead. A
// ticked skill the catalog no longer has stays listed, so it can be unticked.
function choices({ cfg = configService.load(), jobs, days = 90 } = {}) {
  const ads = (jobs || database.getRecentJobDescriptions(days))
    .map(ad => `${ad.job_title || ''}\n${ad.job_description || ''}`)
  const resumes = resumesOf(cfg)
  const ticked = new Set(cleanSkills(cfg.extraSkills))
  const listed = new Set()
  const groups = Object.entries({ ...REPORT_GROUPS, ...PICKER_GROUPS }).map(([group, skills]) => ({
    group,
    skills: Object.keys(skills).map(name => {
      listed.add(name)
      const re = matcherFor(name)
      return { name, onResume: resumes.some(r => re.test(r.text)), ads: ads.filter(text => re.test(text)).length, ticked: ticked.has(name) }
    }),
  }))
  const orphans = [...ticked].filter(name => !listed.has(name))
  if (orphans.length) groups.push({ group: 'Ticked earlier', skills: orphans.map(name => ({ name, onResume: false, ads: 0, ticked: true })) })
  return { groups, sample: ads.length, hasResume: resumes.length > 0 }
}

module.exports = { analyse, choices, VOCABULARY, customTerms, resumesOf }
