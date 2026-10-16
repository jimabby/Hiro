import { useSyncExternalStore } from 'react'

// The activity log, held outside React state.
//
// It used to live in App, so every automation log line — dozens a second during
// a scan — set App state and re-rendered every mounted page. Only the Dashboard
// shows the log, so it is the only thing that should re-render when a line
// arrives. App writes here; the log card subscribes.

const MAX_LINES = 200

let lines = []
const listeners = new Set()

function emit() {
  for (const fn of [...listeners]) fn()
}

export function appendLog(line) {
  lines = [...lines.slice(-MAX_LINES), line]
  emit()
}

export function setLogs(next) {
  lines = Array.isArray(next) ? next.slice(-(MAX_LINES + 1)) : []
  emit()
}

export function getLogs() {
  return lines
}

export function subscribeLogs(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useLogs() {
  return useSyncExternalStore(subscribeLogs, getLogs)
}

// Whether there is anything to show. A boolean, so a component that only needs
// to know whether the log card exists re-renders when that flips, not per line.
export function useHasLogs() {
  return useSyncExternalStore(subscribeLogs, () => lines.length > 0)
}
