// The bug this exists for.
//
// Every page used to unsubscribe with removeAllListeners(channel), which takes
// down EVERY listener on that channel rather than its own. `update:status` has
// two subscribers — the app-wide banner in App.jsx and the panel in Settings —
// so opening Settings once and navigating away silently killed the banner for
// the rest of the session. The download the user had just started from that
// panel then reported its progress, and its "restart to install", into nothing.
//
// It is a whole class of bug rather than one instance: it needs two components
// on one channel, and it leaves no error behind. So these tests assert the
// contract directly — a subscription outlives an unrelated component's unmount,
// and unmounting removes exactly one listener.

import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { createRequire } from 'node:module'
import { EVENT_CHANNELS } from './setup'

// preload.js is CommonJS and does a bare `require('electron')`, which vi.mock
// cannot intercept — that only rewrites ESM imports. Patch Node's own loader
// instead, so the real file runs unmodified against a fake bridge.
const nodeRequire = createRequire(import.meta.url)
const Module = nodeRequire('node:module')

function loadPreload(ipcRenderer) {
  const exposed = {}
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (_name, obj) => Object.assign(exposed, obj) },
    ipcRenderer,
  }
  const originalLoad = Module._load
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return fakeElectron
    return originalLoad.call(this, request, ...rest)
  }
  try {
    const path = nodeRequire.resolve('../../electron/preload.js')
    delete nodeRequire.cache[path]
    nodeRequire(path)
  } finally {
    Module._load = originalLoad
  }
  return exposed
}

// Two independent subscribers to one channel, mounted and unmounted separately —
// the exact shape of App.jsx's banner and Settings' UpdatePanel.
function Banner() {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    const off = window.api.onUpdateStatus(setStatus)
    return () => off?.()
  }, [])
  return <div data-testid="banner">{status?.version || 'none'}</div>
}

function Panel() {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    const off = window.api.onUpdateStatus(setStatus)
    return () => off?.()
  }, [])
  return <div data-testid="panel">{status?.version || 'none'}</div>
}

function Host({ showPanel }) {
  return (
    <>
      <Banner />
      {showPanel && <Panel />}
    </>
  )
}

describe('IPC subscription lifecycle', () => {
  it('keeps a long-lived subscriber alive when another component unmounts', async () => {
    const { rerender } = render(<Host showPanel />)
    expect(window.api.__listenerCount('update:status')).toBe(2)

    // Navigate away from Settings. This is the step that used to break things.
    rerender(<Host showPanel={false} />)
    expect(window.api.__listenerCount('update:status')).toBe(1)

    await act(async () => {
      window.api.__emit('update:status', { version: '2.0.0' })
    })

    // The banner must still be receiving. Before the fix this read 'none'.
    expect(screen.getByTestId('banner').textContent).toBe('2.0.0')
  })

  it('removes exactly one listener per unmount', () => {
    const { unmount } = render(<Host showPanel />)
    expect(window.api.__listenerCount('update:status')).toBe(2)
    unmount()
    expect(window.api.__listenerCount('update:status')).toBe(0)
  })

  it('leaves no listeners behind after a mount/unmount cycle', () => {
    for (let i = 0; i < 5; i++) {
      const { unmount } = render(<Host showPanel />)
      unmount()
    }
    expect(window.api.__listenerCount('update:status')).toBe(0)
  })

  // The contract itself, asserted against the real preload module. A future
  // `on*` added without returning its unsubscribe would reintroduce the bug in a
  // way the component tests above cannot see.
  it('every preload on* returns an unsubscribe function', () => {
    const added = []
    const removed = []
    const api = loadPreload({
      on: (channel, handler) => added.push({ channel, handler }),
      removeListener: (channel, handler) => removed.push({ channel, handler }),
      invoke: async () => null,
      send: () => {},
      removeAllListeners: () => { throw new Error('removeAllListeners must not be used') },
    })

    const subscriberNames = Object.keys(api).filter(k => /^on[A-Z]/.test(k))
    // Guard against the list silently emptying and the assertion passing vacuously.
    expect(subscriberNames.length).toBeGreaterThanOrEqual(Object.keys(EVENT_CHANNELS).length)

    for (const name of subscriberNames) {
      const off = api[name](() => {})
      expect(typeof off, `${name} must return an unsubscribe function`).toBe('function')
      off()
    }
    // Each unsubscribe must remove the exact handler it registered — passing the
    // channel alone would be the old indiscriminate behaviour wearing a new name.
    expect(removed.length).toBe(subscriberNames.length)
    for (const { channel, handler } of removed) {
      expect(added.some(a => a.channel === channel && a.handler === handler)).toBe(true)
    }
  })

  it('no longer exposes removeAllListeners', () => {
    const api = loadPreload({ on: () => {}, removeListener: () => {}, invoke: async () => null, send: () => {} })
    // Leaving it exposed would let the old pattern creep back in.
    expect(api.removeAllListeners).toBeUndefined()
  })
})
