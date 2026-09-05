// A stand-in for the preload bridge.
//
// The real one lives behind contextBridge and cannot be loaded in jsdom, so the
// tests here talk to a fake with the same contract — crucially including the
// part the renderer kept getting wrong: every on* returns its own unsubscribe.
// See test/renderer/ipc-subscriptions.test.jsx for what that guards.

import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Channels the main process can push on, and the api method that subscribes.
export const EVENT_CHANNELS = {
  onNotification: 'notification',
  onAutomationLog: 'automation:log',
  onQuestionAsk: 'question:ask',
  onSubmitReview: 'submit:review',
  onUpdateStatus: 'update:status',
  onAttentionLog: 'attention:log',
  onSkippedApplyLog: 'skipped:apply-log',
  onReviewLog: 'review:log',
  onLinkedInStatusUpdate: 'linkedin:status-update',
  onGmailStatusUpdate: 'gmail:status-update',
  onSeekStatusUpdate: 'seek:status-update',
  onIndeedStatusUpdate: 'indeed:status-update',
}

export function makeApi(overrides = {}) {
  const listeners = new Map() // channel -> Set<fn>

  const subscribe = (channel, cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel).add(cb)
    return () => listeners.get(channel).delete(cb)
  }

  const api = {
    // Test helpers, not part of the real bridge.
    __emit: (channel, payload) => {
      for (const fn of [...(listeners.get(channel) || [])]) fn(payload)
    },
    __listenerCount: (channel) => (listeners.get(channel) || new Set()).size,

    getConfig: vi.fn(async () => ({ setupComplete: true, resumes: [], masterResume: 'x' })),
    getConfigLoadError: vi.fn(async () => null),
    getConfigSecretError: vi.fn(async () => null),
    getStats: vi.fn(async () => ({ attentionCount: 0, heldCount: 0, followUpReviewCount: 0, totalToday: 0 })),
    getRecentLogs: vi.fn(async () => []),
    getUpdateStatus: vi.fn(async () => null),
    getAutomationStatus: vi.fn(async () => ({ running: false })),
    ...overrides,
  }

  for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
    if (!(method in api)) api[method] = (cb) => subscribe(channel, cb)
  }
  return api
}

// jsdom implements no media queries at all, and App reads one on mount to
// follow the system colour theme. Without this every test that renders App dies
// on `window.matchMedia is not a function` — which says nothing about the thing
// being tested.
//
// Reports "not dark", so the theme under test is the deterministic one rather
// than whatever the machine running the suite happens to prefer.
function installMatchMedia() {
  if (typeof window.matchMedia === 'function') return
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

// Node 24+ ships its own global `localStorage`, and it wins: vitest populates
// the jsdom globals onto globalThis without overwriting a built-in that is
// already there, so `window.localStorage` ends up being Node's — which is
// unbacked without --localstorage-file and has no getItem at all. App reads it
// on mount for the theme, so every test that renders App dies on
// "localStorage.getItem is not a function", on Node 24/25 only. CI runs 22 and
// never saw it; a contributor on a current Node saw nothing else.
//
// Restoring a working Storage keeps the suite reading the same on every Node
// the engines field allows.
function installLocalStorage() {
  if (typeof window.localStorage?.getItem === 'function') return
  let store = new Map()
  const storage = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)) },
    removeItem: (key) => { store.delete(String(key)) },
    clear: () => { store = new Map() },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
  // App reads the bare global, not window.*, so both have to point at it.
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}

beforeEach(() => {
  installMatchMedia()
  installLocalStorage()
  window.localStorage.clear()
  window.api = makeApi()
})

afterEach(() => {
  cleanup()
  delete window.api
})
