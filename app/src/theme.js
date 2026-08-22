// Mirrors the desktop app's dark palette (web/src/index.css). Keep the two in
// step — the phone and the desktop are the same product, and a companion app in
// a slightly different grey reads as a knock-off.
//
// The desktop surfaces are translucent glass over an ambient wash, sampled with
// backdrop-filter. React Native has no equivalent without pulling in a blur
// library, and a blur behind a scrolling list is an expensive thing to add for
// decoration. So these mirror the OPAQUE values the desktop itself falls back
// to where backdrop-filter is unavailable (the `@supports not` block at the end
// of index.css) — the same colours that stylesheet resolves to, arrived at the
// same way, rather than a second guess at what the glass looks like.
export const colors = {
  bg: '#07080c',
  // --glass / --glass-raised in the desktop's no-blur fallback.
  surface: '#1a1d28',
  surface2: '#222634',
  surface3: '#2c3040',
  // --border / --border-strong (rgba white 0.11 / 0.19) composited over surface.
  border: '#2e3038',
  borderStrong: '#3d3f47',
  accent: '#6d75f6',
  accentHover: '#7f86f8',
  green: '#32d583',
  yellow: '#fdb022',
  red: '#f97066',
  text: '#f0f2f8',
  textMuted: '#9aa3b8',
  textFaint: '#6b7488',
}

// --radius / --radius-lg. Larger than the old 10/14, in step with the desktop:
// the softer corner is part of what makes the surface read as a material.
export const radius = 12
export const radiusLg = 18

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
