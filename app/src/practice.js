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
      if (!card.done) { card.done = true; out.doneCount = (out.doneCount || 0) + 1 }
      queue = queue.filter(id => id !== card.id)
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
  out.pendingChanges = pending
  return out
}

// The card to show now: the first in the queue that the day still holds.
export function currentCard(data) {
  if (!data || !Array.isArray(data.cards) || !Array.isArray(data.queue)) return null
  return data.cards.find(c => c.id === data.queue[0]) || null
}
