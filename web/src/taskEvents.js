// "Something a to-do list shows has changed" — one signal for every view of it.
//
// The Pipeline board and the task inbox above it each load their own data, and
// each changed it without telling the other: "Mark done" in the inbox cleared a
// follow-up that the board went on showing as overdue, and completing it on the
// board left it in the inbox. Rather than thread a refresh callback through
// both (and every future view of the same rows), a mutation announces itself
// on window and every listener reloads.
//
// `source` lets a view skip the event it raised itself — it has already
// reloaded, and reloading twice is a wasted IPC round trip, not a bug.

import { useEffect } from 'react'

export const TASKS_CHANGED = 'hiro:tasks-changed'

export function notifyTasksChanged(source = '') {
  try { window.dispatchEvent(new CustomEvent(TASKS_CHANGED, { detail: { source } })) } catch { /* no window in tests */ }
}

export function useTasksChanged(handler, source = '') {
  useEffect(() => {
    const listener = (e) => { if (!source || e.detail?.source !== source) handler() }
    window.addEventListener(TASKS_CHANGED, listener)
    return () => window.removeEventListener(TASKS_CHANGED, listener)
  }, [handler, source])
}
