// Pure helpers for the Practice tab (screens/PracticeScreen.js), kept out of the
// screen so plain Node can test them.

// "1d", "2mo", "1y": when a card comes back after a rating.
export function formatInterval(days) {
  const n = Math.max(1, Math.round(Number(days) || 1))
  if (n < 30) return `${n}d`
  if (n < 365) return `${Math.round(n / 30)}mo`
  return '1y'
}

// When a card comes back after each button. Again is always "today": a missed
// card returns at the end of today's cards (the desktop's practice.rate, and
// applyPendingPractice below), even though the schedule it sets is tomorrow.
export function ratingWhen(key, intervals) {
  return key === 'again' ? 'today' : formatInterval(intervals?.[key])
}

// One line for the habit the feature is measured on.
export function statsLine(stats) {
  if (!stats) return ''
  const week = `${stats.daysThisWeek} of ${stats.weeklyGoalDays} days this week`
  const streak = stats.streak > 0 ? ` · ${stats.streak}-day streak` : ''
  const due = stats.due > 0 ? ` · ${stats.due} due` : ''
  return `${week}${streak}${due}`
}

// Practice through the cloud: the desktop's last snapshot of today's cards,
// with what this phone has done since laid over it. Events still in the cloud
// are ones the desktop has not applied yet; without this, a card answered away
// from home would come straight back until the desktop next synced.
export function applyPendingPractice(snapshot, events = []) {
  const out = { ...snapshot, cloud: true, available: 0, cards: (snapshot?.cards || []).map(c => ({ ...c })) }
  const byId = new Map(out.cards.map(c => [c.id, c]))
  let queue = [...(snapshot?.queue || [])]
  let pending = 0
  for (const e of events) {
    const card = byId.get(e?.cardId)
    if (!card) continue
    if (e.type === 'rate') {
      // The same rules as the desktop (practice.rate): a missed card comes back
      // at the end of the day's queue, and on that second look Again sends it
      // round once more while any other answer lets it go.
      // A repeat of an answer already given today changes nothing, as there.
      const secondLook = card.done && card.relearn && queue.includes(card.id)
      if (secondLook) {
        queue = queue.filter(id => id !== card.id)
        if (e.rating === 'again') queue.push(card.id)
        else card.relearn = false
      } else if (!card.done) {
        card.done = true
        out.doneCount = (out.doneCount || 0) + 1
        queue = queue.filter(id => id !== card.id)
        if (e.rating === 'again') {
          card.relearn = true
          // Back tomorrow whatever the second answer, as the miss set it.
          card.intervals = { again: 1, hard: 1, good: 1, easy: 1 }
          queue.push(card.id)
        }
      }
      pending++
    } else if (e.type === 'note') {
      card.note = String(e.note || '').trim()
      pending++
    } else if (e.type === 'flag') {
      card.flagged = true
      queue = queue.filter(id => id !== card.id)
      pending++
    } else if (e.type === 'pause') {
      // Resuming waits for the desktop, which decides where the card goes.
      if (e.paused !== false) {
        card.paused = true
        queue = queue.filter(id => id !== card.id)
      }
      pending++
    }
  }
  out.queue = queue
  out.relearnCount = queue.filter(id => byId.get(id)?.relearn).length
  out.pendingChanges = pending
  return out
}

const pad = n => String(n).padStart(2, '0')

// This phone's calendar day, "YYYY-MM-DD", as the desktop writes days.
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function daysFrom(day, scheduledAt) {
  const [y1, m1, d1] = String(day).split('-').map(Number)
  const [y2, m2, d2] = String(scheduledAt).slice(0, 10).split('-').map(Number)
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000)
}

// Interviews counted from the phone's own today. Over the LAN the desktop's
// count is current; through the cloud it is as old as the last snapshot, so a
// desktop left off overnight would still say "tomorrow" on the day itself.
// The interview time is the desktop's local wall-clock, as the brief shows it.
export function currentCountdown(countdown, today = localDay()) {
  return (countdown || [])
    .map(c => (c.scheduledAt ? { ...c, daysLeft: daysFrom(today, c.scheduledAt) } : c))
    .filter(c => !(c.daysLeft < 0))
}

// Cards from an earlier day: the desktop has not synced since. They can still
// be practised (each rating is applied with the time it was made), but the
// user should know why the set did not change.
export function isStale(data, today = localDay()) {
  return Boolean(data?.cloud && data.day && data.day < today)
}

// "3 of 8" for a first look; a missed card shown again is not one more card.
export function positionLabel(data, card) {
  if (!data || !card) return ''
  if (card.relearn) return `Once more · ${data.relearnCount || 1} to go`
  return `${Math.min(data.doneCount + 1, data.cards.length)} of ${data.cards.length}`
}

// The card to show now: the first in the queue that the day still holds.
export function currentCard(data) {
  if (!data || !Array.isArray(data.cards) || !Array.isArray(data.queue)) return null
  return data.cards.find(c => c.id === data.queue[0]) || null
}

// ─── Swipe to rate ────────────────────────────────────────────────
//
// Once the answer is showing, a card dragged right is Good and dragged left is
// Again: the two answers that matter most, one thumb movement each. Hard and
// Easy stay as buttons. A drag past a third of the card's width counts, or a
// quick flick that has already moved a little; anything less springs back.
export const SWIPE_RATINGS = { right: 'good', left: 'again' }

export function swipeRating(dx, vx, width) {
  const w = Number(width) > 0 ? Number(width) : 320
  const far = Math.abs(dx) >= w / 3
  const flick = Math.abs(vx) >= 0.6 && Math.abs(dx) >= 40 && Math.sign(vx) === Math.sign(dx)
  if (!far && !flick) return null
  return dx > 0 ? SWIPE_RATINGS.right : SWIPE_RATINGS.left
}

// How far a drag has got towards counting, 0 to 1, for fading in the label.
export function swipeProgress(dx, width) {
  const w = Number(width) > 0 ? Number(width) : 320
  return Math.max(0, Math.min(1, Math.abs(dx) / (w / 3)))
}

// ─── Practice calendar ─────────────────────────────────────────────
//
// The desktop sends half a year (practiceCore.practiceCalendar); a phone screen
// shows the most recent weeks of it. Returns the same shape, cut to `weeks`.
export function calendarTail(calendar, weeks = 16) {
  if (!calendar || !Array.isArray(calendar.counts) || !calendar.start) return null
  const have = Math.floor(calendar.counts.length / 7)
  const n = Math.max(1, Math.min(have, Math.floor(Number(weeks)) || 16))
  const skip = (have - n) * 7
  const counts = calendar.counts.slice(skip, skip + n * 7)
  const [y, m, d] = String(calendar.start).split('-').map(Number)
  const first = new Date(y, m - 1, d + skip)
  const start = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(first.getDate()).padStart(2, '0')}`
  const seen = counts.filter(c => c >= 0)
  return {
    start,
    weeks: n,
    counts,
    max: Math.max(0, ...seen),
    activeDays: seen.filter(c => c > 0).length,
    total: seen.reduce((a, b) => a + b, 0),
  }
}

export function calendarShade(count, max) {
  if (!(count > 0)) return 0
  if (!(max > 0)) return 1
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)))
}

// ─── Read aloud ────────────────────────────────────────────────────
//
// Text blocks → what the phone's text-to-speech says. Code is not read out
// character by character (nobody learns from hearing "open brace"); it is
// announced, and stays on screen.
export function speechText(blocks) {
  const parts = []
  for (const b of blocks || []) {
    if (b.type === 'pre') { parts.push('Code example on screen.'); continue }
    const text = (b.spans || []).map(s => s.text).join('').replace(/\s+/g, ' ').trim()
    if (!text) continue
    parts.push(/[.!?:;]$/.test(text) ? text : `${text}.`)
  }
  return parts.join(' ')
}

// Android's text-to-speech refuses anything longer than its input limit
// (Speech.maxSpeechInputLength, 4,000 characters on most phones) and says
// nothing at all. Bank answers are short, but an imported or AI-written answer
// can be twice that. So long text is split into pieces under the limit, at a
// sentence end where one is near, else at a space, and the pieces are queued.
export function speechChunks(text, max = 4000) {
  const limit = Math.max(50, Math.floor(Number(max)) || 4000)
  const out = []
  let rest = String(text || '').trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '))
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    else cut += 1
    if (cut <= 0) cut = limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

// ─── Home-screen widget ────────────────────────────────────────────
//
// The widget runs without the app's keys or connection, so it never asks the
// desktop for anything. The app keeps a small summary of the day whenever it
// loads practice (widgetSummary), and the widget words it for the phone's own
// today (widgetView). Counts only: no question text leaves the app's screens.

export function widgetSummary(data, savedAt = new Date()) {
  if (!data || !Array.isArray(data.cards)) return null
  const s = data.stats || {}
  return {
    day: data.day || localDay(savedAt),
    left: Array.isArray(data.queue) ? data.queue.length : 0,
    done: Number(data.doneCount) || 0,
    total: data.cards.length,
    streak: Number(s.streak) || 0,
    practisedToday: Boolean(s.practisedToday),
    daysThisWeek: Number(s.daysThisWeek) || 0,
    weeklyGoalDays: Number(s.weeklyGoalDays) || 4,
    due: Number(s.due) || 0,
    savedAt: savedAt.toISOString(),
  }
}

function addDay(day, n) {
  const [y, m, d] = String(day).split('-').map(Number)
  return localDay(new Date(y, m - 1, d + n))
}
function mondayOf(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return localDay(date)
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// → { headline, detail, stale }. A summary from an earlier day says what is
// still true today: the streak survives a day without practice only until the
// end of that day, and the week's count resets on Monday.
export function widgetView(summary, today = localDay()) {
  if (!summary || !summary.day) {
    return { headline: 'Daily interview practice', detail: 'Open Hiro to see today’s cards.', stale: false }
  }
  const goal = summary.weeklyGoalDays || 4
  if (summary.day === today) {
    const headline = summary.left > 0 ? `${plural(summary.left, 'card')} left today` : 'Done for today ✓'
    const week = `${summary.daysThisWeek} of ${goal} days this week`
    return { headline, detail: summary.streak > 0 ? `${summary.streak}-day streak · ${week}` : week, stale: false }
  }
  if (summary.day > today) return { headline: 'Daily interview practice', detail: 'Open Hiro to see today’s cards.', stale: true }
  // An earlier day. The streak is still alive only if that day was yesterday
  // and was practised: today's practice extends it.
  const alive = summary.practisedToday && summary.day === addDay(today, -1) && summary.streak > 0
  const sameWeek = mondayOf(summary.day) === mondayOf(today)
  const week = `${sameWeek ? summary.daysThisWeek : 0} of ${goal} days this week`
  return {
    headline: 'New cards today',
    detail: alive ? `Keep your ${summary.streak}-day streak · ${week}` : week,
    stale: true,
  }
}

// hiro://practice: the widget's tap, and anything else that wants the tab.
export function isPracticeLink(link) {
  let parsed
  try { parsed = new URL(String(link || '')) } catch { return false }
  if (parsed.protocol !== 'hiro:') return false
  return (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase() === 'practice'
}
