// Automatic interview prep: the brief's paid parts, generated ahead of time.
//
// The night-before brief (interviewBrief.runDue) builds the likely questions
// and the company research when it is announced. That is late for an interview
// booked at 9am — the questions arrive at 6pm the evening before, if the
// desktop was awake — and it is too late altogether for one booked for this
// afternoon. So when calendar sync first puts an interview in the calendar,
// the same generation is scheduled for the day before (24 hours ahead of the
// interview), or for straight away when the interview is closer than that.
//
// Rules that keep it from costing money unasked:
//
//   - Idempotent per interview time. interview_prep_jobs is keyed on
//     (interview, scheduled_at): another sync pass is an ignored insert, and a
//     reschedule earns one fresh run for the new time.
//   - Nothing runs without an AI provider configured, or once the monthly AI
//     budget (ai/usage.js) is spent; those jobs wait and are retried on the
//     next tick, until the interview itself has passed.
//   - A daily cap on automatic runs (autoInterviewPrepDailyLimit, default 3),
//     so a recruiter booking a week of interviews in one email cannot turn into
//     an unbounded run of model calls in one evening.
//   - Off with autoInterviewPrep: false. The brief itself still works on
//     demand, exactly as before.
//
// Driven from the scheduler's existing ten-minute brief tick; the "straight
// away" case is the same runner called once more, right after scheduling.

const database = require('./database')
const configService = require('./config')
const { isAiConfigured } = require('./ai/configured')

const DEFAULT_DAILY_LIMIT = 3
const MAX_ATTEMPTS = 3
const LEAD_MS = 24 * 3600 * 1000

const pad = n => String(n).padStart(2, '0')
// has_time arrives as 1/0 from SQLite and true/false from callers.
const isTimed = v => v == null || v === true || Number(v) === 1
function toLocalSql(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// interview_events.scheduled_at is local "YYYY-MM-DD HH:MM:SS"; a date-only
// interview (has_time 0) is treated as starting at 09:00 so "the day before"
// still means the day before.
function parseLocal(value, hasTime = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''))
  if (!m) return null
  const timed = hasTime && m[4] != null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), timed ? Number(m[4]) : 9, timed ? Number(m[5]) : 0)
}

// When prep for this interview should run: 24 hours ahead, or now if that has
// already passed. Pure, for tests.
function runAtFor(scheduledAt, hasTime = true, now = new Date()) {
  const when = parseLocal(scheduledAt, hasTime)
  if (!when) return null
  return new Date(Math.max(now.getTime(), when.getTime() - LEAD_MS))
}

// Called by calendar sync for each interview it puts in the calendar. Returns
// { scheduled, due } — `due` meaning the run time is already here.
function schedule(ev, { now = new Date() } = {}) {
  if (!ev?.id || !ev.application_id || !ev.scheduled_at) return { scheduled: false, due: false }
  const when = parseLocal(ev.scheduled_at, isTimed(ev.has_time))
  if (!when || when <= now) return { scheduled: false, due: false }
  const runAt = runAtFor(ev.scheduled_at, isTimed(ev.has_time), now)
  const { created } = database.scheduleInterviewPrep({
    interviewId: ev.id, applicationId: ev.application_id, scheduledAt: ev.scheduled_at, runAt: toLocalSql(runAt),
  })
  return { scheduled: created, due: created && runAt <= now }
}

function startOfToday(now) {
  return toLocalSql(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
}

// Why nothing can run right now, or null. Checked before every job rather than
// once, because a run can spend the last of the budget.
function blockedReason(cfg, now) {
  if (cfg.autoInterviewPrep === false) return 'Automatic interview prep is turned off.'
  if (!isAiConfigured(cfg)) return 'No AI provider is configured.'
  const budget = Number(cfg.aiMonthlyBudgetUsd) || 0
  if (budget > 0) {
    let spent = 0
    try { spent = database.getMonthlyAiSpend() } catch { spent = 0 }
    if (spent >= budget) return 'The monthly AI budget is spent.'
  }
  const raw = Number(cfg.autoInterviewPrepDailyLimit)
  const limit = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_LIMIT
  if (database.countInterviewPrepDoneSince(startOfToday(now)) >= limit) return 'Today\'s automatic prep limit is reached.'
  return null
}

let running = false

// Run every prep job whose time has come, one at a time. `build` is the brief
// builder (interviewBrief.buildBrief), injectable for tests.
async function runDue({ now = new Date(), cfg = configService.load(), build, log = () => {} } = {}) {
  if (running) return { skipped: 'already-running', done: [] }
  running = true
  const done = []
  try {
    const buildBrief = build || require('./interviewBrief').buildBrief
    for (const job of database.getDueInterviewPrepJobs(toLocalSql(now))) {
      // The interview may have been deleted or moved since this was queued. A
      // move has its own row under the new time, so this one is simply retired.
      const current = database.getInterviewEvent(job.interview_id)
      if (!current || current.scheduled_at !== job.scheduled_at) {
        database.updateInterviewPrepJob(job.interview_id, job.scheduled_at, { status: 'cancelled' })
        continue
      }
      const when = parseLocal(job.scheduled_at, isTimed(current.has_time))
      if (!when || when <= now) {
        database.updateInterviewPrepJob(job.interview_id, job.scheduled_at, { status: 'expired' })
        continue
      }
      const blocked = blockedReason(cfg, now)
      if (blocked) {
        // Left pending: the next tick tries again, and the interview passing
        // retires it above.
        database.updateInterviewPrepJob(job.interview_id, job.scheduled_at, { status: 'pending', lastError: blocked })
        break
      }
      try {
        await buildBrief(job.application_id, { generate: true, requireQuestions: true, cfg })
        database.updateInterviewPrepJob(job.interview_id, job.scheduled_at, { status: 'done', attempts: job.attempts + 1, done: true })
        done.push({ interviewId: job.interview_id, applicationId: job.application_id })
        log(`Interview prep ready for ${current.company || 'an interview'} (${job.scheduled_at}).`)
      } catch (err) {
        const attempts = job.attempts + 1
        database.updateInterviewPrepJob(job.interview_id, job.scheduled_at, {
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, lastError: err.message,
        })
      }
    }
  } finally {
    running = false
  }
  return { done }
}

module.exports = { schedule, runDue, runAtFor, parseLocal, DEFAULT_DAILY_LIMIT }
