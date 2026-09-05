// Mirrors the desktop app's palettes (web/src/index.css). Keep the two in step —
// the phone and the desktop are the same product, and a companion app in a
// slightly different grey reads as a knock-off.
//
// The desktop surfaces are translucent glass over an ambient wash, sampled with
// backdrop-filter. React Native has no equivalent without pulling in a blur
// library, and a blur behind a scrolling list is an expensive thing to add for
// decoration. So the dark values mirror the OPAQUE ones the desktop itself falls
// back to where backdrop-filter is unavailable (the `@supports not` block at the
// end of index.css) — the same colours that stylesheet resolves to, arrived at
// the same way, rather than a second guess at what the glass looks like. The
// light values are composited the same way from [data-theme="light"].
//
// ── Why there are two now ────────────────────────────────────────────────
//
// This app was dark-only by an explicit decision, and that decision predates the
// desktop's. The desktop settled on three states — light, dark, and follow the
// system — and argued the third one out: "an app that opens dark on a machine
// set to light looks broken before it has done anything." That argument is
// stronger on a phone, not weaker: phones switch themselves at sunset, and a
// companion app that stays black while every other app on the device has turned
// white is the one that looks broken.
//
// So the phone follows the system and offers nothing to configure. The desktop
// needs an explicit override because a desktop OS theme is often set once and
// forgotten; a phone's is live, deliberate, and usually scheduled.

import { useMemo } from 'react'
import { useColorScheme } from 'react-native'

const dark = {
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

// The desktop's [data-theme="light"] block, with its translucent surfaces and
// borders composited over --bg #eef0f6 — React Native cannot layer an alpha fill
// over an implicit parent the way CSS does, so the result is precomputed here.
//
// The semantic colours are NOT the dark ones: a mid-tone green or amber that
// glows against near-black fails contrast on a white ground, which is why the
// desktop darkens them in exactly the same place. Taking them across unchanged
// is the single most common way a "light mode" ships unreadable.
const light = {
  bg: '#eef0f6',
  // --glass / --glass-raised are near-white in this theme, so a surface reads by
  // its border rather than by its fill.
  surface: '#ffffff',
  surface2: '#f4f5f9',
  surface3: '#e7e9f0',
  // rgba(15,23,42,0.10) and 0.18 over #eef0f6.
  border: '#d5d8e1',
  borderStrong: '#bcc0cd',
  accent: '#5457e5',
  accentHover: '#4a4dd8',
  green: '#0f9d58',
  yellow: '#b45309',
  red: '#dc2626',
  text: '#10162a',
  textMuted: '#57637a',
  textFaint: '#8c96a9',
}

export const palettes = { dark, light }

// The palette for the phone's current appearance setting.
//
// useColorScheme() returns null while the value is being read, and on a device
// with no preference at all. Dark is the fallback for both: it is what this app
// has always been, and a brief flash of white on a dark phone is worse than the
// reverse.
export function useTheme() {
  const scheme = useColorScheme()
  return scheme === 'light' ? light : dark
}

// Kept as a named export so a module-scope StyleSheet that has not been
// converted still resolves, and so non-component code (a chart helper, a test)
// has something to reach for. Anything rendered should use useTheme().
export const colors = dark

// Whether the status bar should draw its content light or dark. The two are
// inverted relative to the palette name: a dark UI needs light glyphs.
export function useStatusBarStyle() {
  return useColorScheme() === 'light' ? 'dark' : 'light'
}

// ─── Status vocabulary ───────────────────────────────────────────────────

// Colours are per-palette because two of them (no_response, withdrawn) are
// greys, and a grey that reads as "quiet" on black reads as "invisible" on
// white.
function buildStatusColors(c) {
  return {
    applied: c.accent,
    interview: c.green,
    offer: c.green,
    rejected: c.red,
    pending: c.yellow,
    no_response: c.borderStrong,
    skipped: c.textMuted,
    // Review mode drafted this but hasn't sent it — waiting on the user, not done.
    held: c.yellow,
    // You pulled out. Grey rather than red, matching the desktop: nobody rejected
    // you, and colouring it like a rejection is the same misattribution the status
    // exists to avoid. Distinct from no_response's grey so the two are told apart
    // at a glance — "they never answered" and "I stopped waiting" are different
    // outcomes and used to render identically here.
    withdrawn: c.textFaint,
  }
}

export const statusColors = buildStatusColors(dark)

export function useStatusColors() {
  const c = useTheme()
  return useMemo(() => buildStatusColors(c), [c])
}

// --radius / --radius-lg. Larger than the old 10/14, in step with the desktop:
// the softer corner is part of what makes the surface read as a material.
export const radius = 12
export const radiusLg = 18

// The statuses a person may set by hand on this phone, in the order the chips
// show them. Mirrors SETTABLE_STATUSES in web/src/statuses.js exactly, and the
// two omissions are the point:
//
//   'skipped' and 'held' are assigned by the scan. Neither is a claim a person
//   makes about what happened, and offering 'skipped' here — which this app did
//   — let you file a submitted application as one that was never sent.
//
//   'withdrawn' was missing, which is the same error in the other direction:
//   the one status added specifically to stop misreporting an outcome was the
//   one the phone could not record. A withdrawn application opened here showed
//   its chips with none selected, looking unset, and a reflexive tap silently
//   overwrote the withdrawal.
export const SETTABLE_STATUSES = [
  'applied', 'interview', 'offer', 'rejected', 'pending', 'no_response', 'withdrawn',
]

// The list filter chips. Every status a row can actually hold, so nothing in the
// database is unreachable from the list — including the ones above that a person
// cannot set.
export const STATUS_FILTERS = [
  'all', 'applied', 'held', 'interview', 'offer', 'pending',
  'rejected', 'no_response', 'withdrawn', 'skipped',
]

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
  withdrawn: 'Withdrawn',
}

export function statusLabel(status) {
  return statusLabels[status] || String(status || '')
}
