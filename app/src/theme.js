// Mirrors the desktop app's dark palette (web/src/index.css)
export const colors = {
  bg: '#0f1117',
  surface: '#1a1d27',
  surface2: '#242736',
  border: '#2e3245',
  accent: '#6366f1',
  accentHover: '#4f52d4',
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
}

export const radius = 10

export const statusColors = {
  applied: colors.accent,
  interview: colors.green,
  offer: colors.green,
  rejected: colors.red,
  pending: colors.yellow,
  no_response: colors.border,
  skipped: colors.textMuted,
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
}

export function statusLabel(status) {
  return statusLabels[status] || String(status || '')
}
