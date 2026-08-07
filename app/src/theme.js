// Mirrors the desktop app's dark palette (web/src/index.css). Keep the two in
// step — the phone and the desktop are the same product, and a companion app in
// a slightly different grey reads as a knock-off.
export const colors = {
  bg: '#0e1016',
  surface: '#171a23',
  surface2: '#212533',
  surface3: '#2b3042',
  border: '#2e3245',
  borderStrong: '#3d4258',
  accent: '#6366f1',
  accentHover: '#4f52d4',
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#64748b',
}

export const radius = 10
export const radiusLg = 14

export const statusColors = {
  applied: colors.accent,
  interview: colors.green,
  offer: colors.green,
  rejected: colors.red,
  pending: colors.yellow,
  no_response: colors.border,
  skipped: colors.textMuted,
  // Review mode drafted this but hasn't sent it — waiting on the user, not done.
  held: colors.yellow,
}

// Human-readable label for a status. Needed because the raw values are no
// longer all single words — "no_response" rendered as-is looks like a bug.
export const statusLabels = {
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  pending: 'Pending',
  no_response: 'No Response',
  skipped: 'Skipped',
  held: 'Held for review',
}

export function statusLabel(status) {
  return statusLabels[status] || String(status || '')
}
