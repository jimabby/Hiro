// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// How old a cached screening answer is. Shared by the Answer Bank panel and by
// the staleness count Settings itself shows, which is why it is not inside
// either of them.

export function answerAgeDays(updatedAt) {
  if (!updatedAt) return null
  const at = new Date(String(updatedAt).includes('T') ? updatedAt : `${String(updatedAt).replace(' ', 'T')}Z`)
  if (Number.isNaN(at.getTime())) return null
  return Math.max(0, Math.floor((Date.now() - at.getTime()) / 86400000))
}
