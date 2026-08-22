// Smart scheduling — spreading the daily allowance in batches across a window.
//
// Two bugs this exists for, both silent:
//
// 1. `interval` is floor(windowMinutes / numBatches), and numBatches comes from
//    the daily limit. Past one batch per minute it floored to 0, so every batch
//    was planned for the same moment — and because runBatch() refuses to start
//    while another is running, all but the first were dropped without a word.
//    A limit of 600 at a batch size of 1 produced 600 timers on 15 distinct
//    times, all inside the first quarter hour, and applied almost nothing.
//
// 2. Jitter was clamped at the bottom (`Math.max(startMinutes, …)`) and not at
//    the top, so the last batch of a short window ran after the finish time the
//    user configured — 09:00–09:30 planned its final batch at 09:41.
//
// Neither raised an error, and both look identical to a quiet day from the
// outside, which is why they are asserted here rather than left to observation.

const { stub, service, createChecker } = require('./helpers')

let cfg = {}

stub({
  './config': { load: () => cfg, update: () => cfg, CONFIG_DIR: '/tmp/hiro-test' },
  './database': { getStats: () => ({ totalToday: 0, attentionCount: 0 }) },
  './email': {},
  './webhooks': { send: async () => {} },
  './applicator': { isBusy: () => false, cancel: () => {}, run: async () => ({}) },
  './cloudSync': { updateScanStatus: async () => {}, sync: async () => {} },
  './logger': { append: () => {} },
  './askQuestion': { makeAskQuestion: () => () => {} },
  'node-cron': { schedule: () => ({ stop: () => {} }) },
})

const scheduler = service('scheduler.js')
const { check, done } = createChecker()

// Monday, 08:00 local — a weekday (the schedule is Mon–Fri) and before the
// window opens, so every planned batch is still in the future and survives the
// "skip batches in the past" filter.
const FAKE = new Date(2026, 7, 24, 8, 0, 0)
const RealDate = Date
global.Date = class extends RealDate {
  constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(FAKE) }
  static now() { return FAKE.getTime() }
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

function plan(overrides = {}) {
  cfg = {
    setupComplete: true, pendingScans: [], enableSmartScheduling: true,
    smartScheduleStartTime: '09:00', smartScheduleEndTime: '17:00',
    smartScheduleBatchSize: 3, smartScheduleJitter: 15,
    enableSeek: true, enableIndeed: true, enableLinkedIn: true,
    dailyLimitSeek: 10, dailyLimitIndeed: 10, dailyLimitLinkedIn: 10,
    ...overrides,
  }
  scheduler.restart(null)
  return scheduler.getBatchSchedule() || []
}

// ── The ordinary case still behaves ────────────────────────────────
// 30 a day at 3 per batch is 10 batches over 8 hours. Guarded because the fix
// caps jitter at half the interval, and the default interval is wide enough
// that the default jitter must pass through untouched.
{
  const times = plan()
  check('default settings plan one batch per 3 applications', times.length, 10)
  check('default batches all land at distinct times', new Set(times).size, 10)
  check('default batches start no earlier than the window', toMinutes(times[0]) >= 9 * 60, true)
  check('default batches finish no later than the window', toMinutes(times[times.length - 1]) <= 17 * 60, true)
}

// ── More batches than the window has minutes ───────────────────────
{
  const times = plan({
    dailyLimitSeek: 200, dailyLimitIndeed: 200, dailyLimitLinkedIn: 200,
    smartScheduleBatchSize: 1,
  })
  // 600 batches will not fit in a 480-minute window, so the window wins and the
  // batches get larger. What must NOT happen is 600 timers stacked on one minute.
  check('an oversized plan is capped to the minutes available', times.length, 480)
  check('every capped batch gets its own minute', new Set(times).size, times.length)
  check('a capped plan still uses the whole window',
    toMinutes(times[times.length - 1]) - toMinutes(times[0]) > 400, true)
}

{
  // Far past the ceiling: same cap, and the batch size absorbs the volume.
  const times = plan({
    dailyLimitSeek: 500, dailyLimitIndeed: 500, dailyLimitLinkedIn: 500,
    smartScheduleBatchSize: 1,
  })
  check('the cap holds however large the limit is', times.length, 480)
  check('the cap never collapses onto one time', new Set(times).size, 480)
}

// ── Jitter must not escape the window ──────────────────────────────
{
  const times = plan({ smartScheduleEndTime: '09:30' })
  const end = toMinutes('09:30')
  check('no batch is planned after the configured end time',
    times.filter(t => toMinutes(t) > end).length, 0)
  check('no batch is planned before the configured start time',
    times.filter(t => toMinutes(t) < toMinutes('09:00')).length, 0)
}

// ── Jitter must not reorder batches on top of each other ───────────
{
  // A 1-minute interval with the default ±15 jitter used to let batches
  // overtake each other and share minutes — the same collapse by another route.
  const times = plan({
    dailyLimitSeek: 20, dailyLimitIndeed: 20, dailyLimitLinkedIn: 20,
    smartScheduleBatchSize: 1,
  })
  check('a tight interval still gives every batch its own minute',
    new Set(times).size, times.length)
}

// ── The reported schedule is readable ──────────────────────────────
{
  const times = plan()
  const sorted = times.every((t, i) => i === 0 || toMinutes(t) >= toMinutes(times[i - 1]))
  check('the planned schedule is reported in chronological order', sorted, true)
}

scheduler.stop({ abortRun: false })
global.Date = RealDate
done()
