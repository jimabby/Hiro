// The offline read cache: what is kept, when it is too old, how it is labelled.
const { createChecker } = require('./helpers')
const m = require('../src/cacheModel')
const { check, done } = createChecker()

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const MIN = 60 * 1000, DAY = 24 * 60 * MIN

const entry = m.makeEntry({ hello: 1 }, NOW - 5 * MIN)
check('entry round-trips through storage', m.readEntry(JSON.stringify(entry)), entry)
check('garbage is no cache', m.readEntry('not json'), null)
check('another version is no cache', m.readEntry(JSON.stringify({ ...entry, v: 99 })), null)
check('missing is no cache', m.readEntry(null), null)

check('fresh entry is not stale', m.isStale(entry, NOW), false)
check('just under the limit is not stale', m.isStale(m.makeEntry(1, NOW - m.MAX_AGE_MS + MIN), NOW), false)
check('past the limit is stale', m.isStale(m.makeEntry(1, NOW - m.MAX_AGE_MS - MIN), NOW), true)
check('a timestamp from the future is stale', m.isStale(m.makeEntry(1, NOW + 10 * MIN), NOW), true)
check('no entry is stale', m.isStale(null, NOW), true)

check('label: just now', m.cachedLabel(m.makeEntry(1, NOW - 10 * 1000), NOW), 'cached · just now')
check('label: minutes', m.cachedLabel(entry, NOW), 'cached · 5 min ago')
check('label: hours', m.cachedLabel(m.makeEntry(1, NOW - 3 * 60 * MIN), NOW), 'cached · 3 h ago')
check('label: one day', m.cachedLabel(m.makeEntry(1, NOW - DAY), NOW), 'cached · 1 day ago')

const full = [{
  id: 1, job_title: 'Engineer', company: 'Acme', status: 'applied', match_score: 80,
  cover_letter: 'Dear…', tailored_resume: 'CV…', job_description: 'JD…', comment: 'my private note', token: 'secret',
}]
const slim = m.slimApplications(full)
check('slim list keeps what the list draws', slim[0], { id: 1, job_title: 'Engineer', company: 'Acme', status: 'applied', match_score: 80 })
check('slim list drops documents, notes and anything unknown',
  ['cover_letter', 'tailored_resume', 'job_description', 'comment', 'token'].some(k => k in slim[0]), false)
check('slim list tolerates garbage', m.slimApplications(null), [])

const dash = m.slimDashboard({
  stats: { totalAllTime: 3 }, perDay: [{ date: '2026-10-17', count: 1 }],
  interviews: [{ id: 9, job_title: 'E', company: 'A', scheduled_at: '2026-10-20 10:00', has_time: 1, note: 'long recruiter email' }],
  dueActions: [{ id: 2, job_title: 'E', company: 'A', next_action_at: '2026-10-17', cover_letter: 'x' }],
})
check('dashboard keeps the figures', dash.stats.totalAllTime, 3)
check('dashboard interview rows are trimmed', 'note' in dash.interviews[0], false)
check('dashboard follow-ups are trimmed', 'cover_letter' in dash.dueActions[0], false)

const list = [
  { id: 1, job_title: 'Platform Engineer', company: 'Acme', status: 'applied' },
  { id: 2, job_title: 'Designer', company: 'Beta', status: 'interview' },
]
check('offline filter by status', m.filterApplications(list, { status: 'interview' }).map(a => a.id), [2])
check('offline search', m.filterApplications(list, { search: 'acme' }).map(a => a.id), [1])
check('"all" filters nothing', m.filterApplications(list, { status: 'all' }).length, 2)

done()
