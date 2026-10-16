// Toast stack rules and the notification history, kept out of App so they can
// be tested without rendering the whole shell.

export const MAX_VISIBLE_TOASTS = 4

// A toast that must not be pushed off the stack by a newer one: errors stay up
// until dismissed (the new-device security warning rides this channel), and a
// toast carrying an action (Undo) is the only chance to take something back.
export function isSticky(t) {
  return !!(t && (t.sticky || t.type === 'error' || t.action))
}

// Adds a toast, evicting the OLDEST transient ones first when the stack is
// full. Sticky toasts are never evicted — the stack is allowed to grow past the
// limit rather than drop one. The old `prev.slice(-3)` evicted whatever was
// oldest, which was routinely an error or an Undo.
export function pushToast(prev, toast, max = MAX_VISIBLE_TOASTS) {
  const next = [...prev, toast]
  while (next.length > max) {
    const i = next.findIndex(t => t !== toast && !isSticky(t))
    if (i === -1) break
    next.splice(i, 1)
  }
  return next
}

// ─── Notification history ──────────────────────────────────────

export const HISTORY_KEY = 'hiro.notificationHistory'
export const HISTORY_SEEN_KEY = 'hiro.notificationHistorySeen'
export const MAX_HISTORY = 100

// Toast text is mostly ours, but some of it carries error messages from
// providers and the main process, and those can echo a key or token back. The
// history is written to localStorage, which is plain text on disk, so anything
// shaped like a credential is masked before it gets there.
const SECRET_PATTERNS = [
  // Provider-style prefixed keys: sk-…, sk-ant-…, ghp_…, xoxb-…, AIza…
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // Bearer / basic auth headers.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value pairs that name what they are.
  /\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Any other long unbroken run of key-like characters.
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, label) => (
      typeof label === 'string' && /^(api|token|secret|pass|pwd|bearer|basic)/i.test(label)
        ? `${label}${match.slice(label.length).match(/^\s*[:=]?\s*/)[0]}[redacted]`
        : '[redacted]'
    ))
  }
  return out
}

export function historyEntry(toast) {
  return {
    id: toast.id,
    msg: redactSecrets(toast.msg),
    type: toast.type,
    at: Date.now(),
  }
}

export function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(parsed)
      ? parsed.filter(e => e && typeof e.msg === 'string').slice(-MAX_HISTORY)
      : []
  } catch {
    return []
  }
}

export function saveHistory(entries) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(-MAX_HISTORY))) } catch { /* storage unavailable */ }
}

export function loadSeenAt() {
  try { return Number(localStorage.getItem(HISTORY_SEEN_KEY)) || 0 } catch { return 0 }
}

export function saveSeenAt(at) {
  try { localStorage.setItem(HISTORY_SEEN_KEY, String(at)) } catch { /* storage unavailable */ }
}
