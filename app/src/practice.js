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

// The card to show now: the first in the queue that the day still holds.
export function currentCard(data) {
  if (!data || !Array.isArray(data.cards) || !Array.isArray(data.queue)) return null
  return data.cards.find(c => c.id === data.queue[0]) || null
}
