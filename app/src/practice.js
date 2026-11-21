// Pure helpers for the Practice tab (screens/PracticeScreen.js), kept out of the
// screen so plain Node can test them.

// "1d", "2mo", "1y": when a card comes back after a rating.
export function formatInterval(days) {
  const n = Math.max(1, Math.round(Number(days) || 1))
  if (n < 30) return `${n}d`
  if (n < 365) return `${Math.round(n / 30)}mo`
  return '1y'
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
