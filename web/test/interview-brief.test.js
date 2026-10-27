// The night-before interview brief and the company research inside it.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-brief-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { aiProvider: 'test', aiApiKey: 'k', masterResume: 'Jane Example\nEngineer', indeedRegion: 'au' }
const pushes = []
stub({
  './config': { CONFIG_DIR: TMP, load: () => ({ ...config }), update: p => { config = { ...config, ...p }; return config } },
  './logger': { append: () => {} },
  './push': { send: async (m) => { pushes.push(m); return { sent: 1 } } },
})

const db = service('database')
const ai = service('ai/index')
const research = service('companyResearch')
const brief = service('interviewBrief')
const { check, done } = createChecker()

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Acme raises $50m to expand - Financial Review</title><link>https://news.example/1</link><pubDate>${new Date(Date.now() - 2 * 86400000).toUTCString()}</pubDate><source url="x">Financial Review</source></item>
<item><title><![CDATA[Acme &amp; Co opens Sydney office]]></title><link>https://news.example/2</link><pubDate>${new Date(Date.now() - 20 * 86400000).toUTCString()}</pubDate><source url="y">ITNews</source></item>
<item><title>Ancient Acme story</title><link>https://news.example/3</link><pubDate>${new Date(Date.now() - 800 * 86400000).toUTCString()}</pubDate></item>
<item><title>No date</title><link>https://news.example/4</link></item>
</channel></rss>`

const local = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

async function main() {
  await db.init()

  // ─── News parsing ──────────────────────────────────────────────
  const items = research.parseNewsRss(RSS)
  check('recent headlines are kept, old and undated ones dropped', items.length, 2)
  check('the publisher suffix is removed from the title', items[0].title, 'Acme raises $50m to expand')
  check('the publisher is kept separately', items[0].source, 'Financial Review')
  check('CDATA and entities are decoded', items[1].title, 'Acme & Co opens Sydney office')
  check('newest first', items[0].date >= items[1].date, true)
  check('legal suffixes do not split one company in two', research.companyKey('Acme Pty Ltd'), research.companyKey('ACME'))

  // ─── Research is cached, and the summary sees only the headlines ─
  let fetches = 0
  let summaryInput = ''
  const fakeFetch = async () => { fetches++; return { ok: true, text: async () => RSS } }
  ai.chat = async (_p, _k, input) => { summaryInput = input.messages[0].content; return '- Acme raised money.' }
  const r1 = await research.research('Acme Pty Ltd', { fetchImpl: fakeFetch, cfg: config })
  check('research returns headlines', r1.headlines.length, 2)
  check('research returns the summary', r1.summary, '- Acme raised money.')
  check('headlines reach the model fenced as untrusted', /HEADLINES/.test(summaryInput) && /Acme raises/.test(summaryInput), true)
  await research.research('ACME', { fetchImpl: fakeFetch, cfg: config })
  check('a second lookup within a week is served from the cache', fetches, 1)
  await research.research('Acme', { fetchImpl: fakeFetch, cfg: config, refresh: true })
  check('refresh looks it up again', fetches, 2)
  const offline = await research.research('Globex', { fetchImpl: async () => { throw new Error('offline') }, cfg: config })
  check('unreachable news never throws', offline.headlines, [])

  // ─── The brief ─────────────────────────────────────────────────
  db.insertApplication({
    job_title: 'Data Engineer', company: 'Acme Pty Ltd', platform: 'Seek', job_url: 'https://jobs/1',
    job_description: 'Build pipelines.', status: 'interview', match_score: 88, tailored_resume: 'Jane Example\nEngineer',
  })
  const app = db.getApplications().find(a => a.company === 'Acme Pty Ltd')
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  db.addInterviewEvent({ applicationId: app.id, scheduledAt: `${local(tomorrow)} 10:00:00`, hasTime: true, source: 'manual' })
  db.saveRecruiterReply({ applicationId: app.id, uid: 7, from: 'tal@acme.com', subject: 'Interview invite', body: 'A panel with the data lead, technical round.', classifiedAs: 'interview', receivedAt: new Date().toISOString() })

  let questionCalls = 0
  ai.generateInterviewQuestions = async () => { questionCalls++; return [{ question: 'Tell me about a pipeline you built', answer: 'Draft answer', category: 'Technical' }] }

  const cold = await brief.buildBrief(app.id, { generate: false, cfg: config })
  check('a read-only brief never calls the model', questionCalls, 0)
  check('…and has no questions yet', cold.questions.length, 0)
  check('…but still has the cached news', cold.research.headlines.length, 2)

  const b = await brief.buildBrief(app.id, { cfg: config, fetchImpl: fakeFetch })
  check('the brief prepares the questions', b.questions[0].question, 'Tell me about a pipeline you built')
  check('the model\'s sample answer is kept as a draft', b.questions[0].sampleAnswer, 'Draft answer')
  check('the interview time is included', b.interview.scheduledAt, `${local(tomorrow)} 10:00:00`)
  check('what they said is included', b.replies[0].subject, 'Interview invite')
  check('questions to ask are included', b.questionsToAsk.length > 0, true)
  await brief.buildBrief(app.id, { cfg: config, fetchImpl: fakeFetch })
  check('questions are generated once, then reused', questionCalls, 1)
  check('the text form names the company', /Acme/.test(brief.toText(b)), true)

  // ─── The evening before ────────────────────────────────────────
  const morning = new Date(); morning.setHours(9, 0, 0, 0)
  const evening = new Date(); evening.setHours(19, 0, 0, 0)
  const notified = []
  const notify = (t, body) => notified.push({ t, body })

  check('nothing is sent before the brief hour', (await brief.runDue({ now: morning, cfg: config, notify })).length, 0)
  const sent = await brief.runDue({ now: evening, cfg: config, notify })
  check('the evening before, the brief is sent', sent.length, 1)
  check('the phone gets it', pushes.length, 1)
  check('the push opens the brief', pushes[0].data.screen, 'brief')
  check('the desktop is told too', notified.length, 1)
  check('the notification says when', /Tomorrow/.test(pushes[0].body), true)
  check('it is sent once, however often the check runs', (await brief.runDue({ now: evening, cfg: config, notify })).length, 0)
  check('switched off means never', (await brief.runDue({ now: evening, cfg: { ...config, interviewBriefEnabled: false }, notify })).length, 0)

  // ─── Automatic prep, scheduled when an interview reaches the calendar ─
  const prep = service('interviewPrep')
  const at = (d, h, m = 0) => `${local(d)} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
  const now = new Date(); now.setHours(12, 0, 0, 0)
  const inDays = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d }
  check('prep runs 24 hours ahead', prep.runAtFor(at(inDays(3), 10), true, now).getTime(), new Date(inDays(2).setHours(10, 0, 0, 0)).getTime())
  check('an interview under 24 hours away is prepped now', prep.runAtFor(at(inDays(0), 16), true, now).getTime(), now.getTime())
  check('a date-only interview counts from 9am', prep.runAtFor(`${local(inDays(2))} 00:00:00`, false, now).getTime(), new Date(inDays(1).setHours(9, 0, 0, 0)).getTime())

  const addInterview = (company, when) => {
    db.insertApplication({ job_title: 'Engineer', company, platform: 'Seek', job_url: `https://jobs/${company}`, job_description: 'x', status: 'interview' })
    const id = db.getApplications().find(a => a.company === company).id
    db.addInterviewEvent({ applicationId: id, scheduledAt: when, hasTime: true, source: 'manual' })
    return db.getInterviewEvents(id)[0]
  }
  const soon = addInterview('Soonco', at(inDays(0), 17))
  const later = addInterview('Laterco', at(inDays(4), 10))
  const built = []
  const build = async (applicationId) => { built.push(applicationId) }

  check('an interview this afternoon is due at once', prep.schedule(soon, { now }), { scheduled: true, due: true })
  check('scheduling again is a no-op', prep.schedule(soon, { now }), { scheduled: false, due: false })
  check('an interview in four days is scheduled, not due', prep.schedule(later, { now }), { scheduled: true, due: false })
  check('a past interview is not scheduled', prep.schedule({ ...soon, id: 999, scheduled_at: at(inDays(-1), 10) }, { now }).scheduled, false)

  await prep.runDue({ now, cfg: { ...config, aiProvider: '' }, build })
  check('without an AI provider nothing is generated', built.length, 0)
  check('and the job waits, saying why', /AI provider/.test(db.getInterviewPrepJob(soon.id, soon.scheduled_at).last_error), true)

  db.recordAiUsage({ provider: 'test', model: 'x', operation: 'y', costUsd: 1 })
  await prep.runDue({ now, cfg: { ...config, aiMonthlyBudgetUsd: 0.5 }, build })
  check('a spent monthly budget holds it back', built.length, 0)

  await prep.runDue({ now, cfg: { ...config, aiMonthlyBudgetUsd: 0 }, build })
  await prep.runDue({ now, cfg: config, build })
  const doneRow = db.getInterviewPrepJob(soon.id, soon.scheduled_at)
  check('the due interview is prepped once, however often the tick runs', built, [soon.application_id])
  check('and marked done', doneRow.status, 'done')
  check('the later one is left for its day', db.getInterviewPrepJob(later.id, later.scheduled_at).status, 'pending')

  // The daily cap: a second due interview the same day waits once it is hit.
  const another = addInterview('Anotherco', at(inDays(0), 18))
  prep.schedule(another, { now })
  const capped = []
  await prep.runDue({ now, cfg: { ...config, autoInterviewPrepDailyLimit: 1 }, build: async id => { capped.push(id) } })
  check('the daily limit holds further runs back', capped.length, 0)
  check('saying why', /limit/.test(db.getInterviewPrepJob(another.id, another.scheduled_at).last_error), true)
  await prep.runDue({ now, cfg: { ...config, autoInterviewPrep: false }, build: async id => { capped.push(id) } })
  check('switched off, nothing runs', capped.length, 0)

  // A deleted interview retires its job instead of spending anything.
  db.deleteInterviewEvent(another.id)
  await prep.runDue({ now, cfg: config, build: async id => { capped.push(id) } })
  check('a deleted interview is not prepped', [capped.length, db.getInterviewPrepJob(another.id, another.scheduled_at).status], [0, 'cancelled'])

  // A run whose questions failed is a failed run, retried on the next tick —
  // not "done" with an empty brief.
  const flaky = addInterview('Flakyco', at(inDays(0), 19))
  prep.schedule(flaky, { now })
  let opts = null
  await prep.runDue({ now, cfg: { ...config, autoInterviewPrepDailyLimit: 10 }, build: async (id, o) => { opts = o; throw new Error('No interview questions were generated.') } })
  const flakyRow = db.getInterviewPrepJob(flaky.id, flaky.scheduled_at)
  check('prep asks the brief to require its questions', opts?.requireQuestions, true)
  check('a run without questions is left to retry', [flakyRow.status, /questions/.test(flakyRow.last_error)], ['pending', true])

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
