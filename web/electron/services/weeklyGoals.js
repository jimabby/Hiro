// Weekly goals: "apply to 10, follow up on 3, reach out to 2 people".
//
// A job search is a volume game played over months, and the week is the unit
// people actually plan in. The counts already exist (what was sent, which
// follow-ups were done, which contacts were reached); this sets a target beside
// each and says whether the week is on pace.
//
// The week starts on Monday, in the user's own timezone. "On pace" is measured
// against the share of the week that has passed, so Tuesday morning with one
// application of ten is not "behind" — but Thursday evening with two is.

const configService = require('./config')
const database = require('./database')

const GOALS = [
  { key: 'applications', label: 'Applications sent', unit: 'application' },
  { key: 'followUps', label: 'Follow-ups done', unit: 'follow-up' },
  { key: 'contacts', label: 'People contacted', unit: 'contact' },
]
const MAX_TARGET = 200

// Targets from config, cleaned: whole numbers from 0 (no goal) to MAX_TARGET.
function normaliseTargets(raw) {
  const out = {}
  for (const { key } of GOALS) {
    const n = Math.floor(Number(raw?.[key]))
    out[key] = Number.isFinite(n) ? Math.min(MAX_TARGET, Math.max(0, n)) : 0
  }
  return out
}

// Local Monday 00:00 of the week containing `now`.
function weekStart(now = new Date()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

// A Date as the UTC text SQLite stores timestamps in ("YYYY-MM-DD HH:MM:SS").
const sqliteUtc = d => d.toISOString().slice(0, 19).replace('T', ' ')
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// How much of the week has gone, 0–1. Measured by the clock, so pace rises
// through each day rather than jumping at midnight.
function weekElapsed(now = new Date()) {
  const start = weekStart(now)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return Math.min(1, Math.max(0, (now - start) / (end - start)))
}

// Where the week stands. A goal is 'done' at its target, 'behind' when it is
// more than one unit short of where an even pace would put it by now, and
// 'on-track' otherwise. A target of 0 is no goal, and is left out.
function progress({ cfg = configService.load(), now = new Date(), activity } = {}) {
  const targets = normaliseTargets(cfg.weeklyGoals)
  const start = weekStart(now)
  const counts = activity || database.getWeeklyActivity(sqliteUtc(start))
  const elapsed = weekElapsed(now)
  const goals = GOALS.filter(g => targets[g.key] > 0).map((g) => {
    const target = targets[g.key]
    const done = Math.max(0, Number(counts[g.key]) || 0)
    const expected = target * elapsed
    const state = done >= target ? 'done' : expected - done > 1 ? 'behind' : 'on-track'
    return { ...g, target, done, expected: Math.round(expected * 10) / 10, state }
  })
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return {
    weekStart: localDay(start),
    weekEnd: localDay(end),
    elapsed: Math.round(elapsed * 100) / 100,
    targets,
    goals,
    behind: goals.filter(g => g.state === 'behind').map(g => g.key),
    allDone: goals.length > 0 && goals.every(g => g.state === 'done'),
  }
}

function saveTargets(input) {
  const targets = normaliseTargets(input)
  configService.update({ weeklyGoals: targets })
  return { success: true, targets }
}

// One line for a nudge, or null when nothing is behind. Used by the scheduler
// once a day from Wednesday on — earlier in the week "behind" is noise.
function nudgeText(p) {
  if (!p || !p.behind.length) return null
  const parts = p.goals.filter(g => g.state === 'behind')
    .map(g => `${g.done}/${g.target} ${g.label.toLowerCase()}`)
  return `This week so far: ${parts.join(', ')}. A little behind pace — there is still time.`
}

module.exports = { GOALS, progress, saveTargets, normaliseTargets, weekStart, weekElapsed, nudgeText, MAX_TARGET }
