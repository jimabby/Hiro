// Focus containment for modal dialogs.
//
// The bug this exists for: ten `aria-modal="true"` dialogs across App,
// Dashboard, Review, NeedsAttention and Settings, and not one of them kept
// focus inside itself. Tab walked straight out into the page behind the scrim,
// where every control was still focusable and still actionable by keyboard —
// including "Run Scan Now" while a submit-confirmation dialog was sitting one
// keystroke from sending an application to an employer.
//
// These assert the contract rather than any one dialog's markup, because the
// implementation is a document-level observer keyed on aria-modal: a dialog
// added to any page later is covered by it without knowing it exists, and that
// property is the thing worth protecting.

import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useState } from 'react'
import useModalFocus from '../../src/hooks/useModalFocus'

function Harness({ withControls = true }) {
  const [open, setOpen] = useState(false)
  useModalFocus()
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      <button>behind</button>
      {open && (
        <div role="dialog" aria-modal="true">
          {withControls && (
            <>
              <button>first</button>
              <button>last</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// jsdom does not implement sequential focus navigation, so Tab is simulated the
// way the hook sees it: a keydown it can intercept. What is under test is the
// hook's redirect, not the browser's default order.
function tab({ shift = false } = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }))
  })
}

// The hook watches the DOM with a MutationObserver, which delivers on a
// microtask — so the assertions have to come after one has drained.
const settle = async () => { await act(async () => { await Promise.resolve() }) }

describe('modal focus', () => {
  it('moves focus into a dialog when it opens', async () => {
    render(<Harness />)
    act(() => screen.getByText('open').click())
    await settle()
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('wraps forward from the last control to the first', async () => {
    render(<Harness />)
    act(() => screen.getByText('open').click())
    await settle()
    act(() => screen.getByText('last').focus())
    tab()
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('wraps backward from the first control to the last', async () => {
    render(<Harness />)
    act(() => screen.getByText('open').click())
    await settle()
    act(() => screen.getByText('first').focus())
    tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByText('last'))
  })

  it('pulls focus back when it has escaped the dialog', async () => {
    render(<Harness />)
    act(() => screen.getByText('open').click())
    await settle()
    // Simulates focus landing outside — a scrim click, or a control unmounting.
    act(() => screen.getByText('behind').focus())
    tab()
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('holds focus in a dialog that has no controls of its own', async () => {
    render(<Harness withControls={false} />)
    act(() => screen.getByText('open').click())
    await settle()
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    tab()
    expect(document.activeElement).toBe(dialog)
  })

  it('leaves the page alone while no dialog is open', async () => {
    render(<Harness />)
    await settle()
    act(() => screen.getByText('behind').focus())
    tab()
    // Nothing to trap, so the hook must not intercept — the browser's own
    // ordering has to keep working everywhere else in the app.
    expect(document.activeElement).toBe(screen.getByText('behind'))
  })
})

// Switching pages does not unmount anything in this app — App toggles each
// page's wrapper between display:block and display:none. A dialog belonging to
// a page the user has navigated away from is therefore still in the DOM and
// still carrying aria-modal, and trapping focus inside it is a keyboard lock
// with nothing on screen to explain it.
describe('modal focus across page switches', () => {
  function PagedHarness() {
    const [hidden, setHidden] = useState(false)
    useModalFocus()
    return (
      <div>
        <button onClick={() => setHidden(true)}>leave</button>
        <div style={{ display: hidden ? 'none' : 'block' }}>
          <div role="dialog" aria-modal="true"><button>inside</button></div>
        </div>
      </div>
    )
  }

  it('releases focus when the dialog’s page is hidden', async () => {
    // jsdom does not implement checkVisibility at all — so it cannot be spied
    // on, it has to be supplied. This stands in for the Chromium behaviour the
    // hook relies on: an element under a display:none ancestor is not visible.
    Element.prototype.checkVisibility = function visible() {
      for (let el = this; el; el = el.parentElement) {
        if (el.style?.display === 'none') return false
      }
      return true
    }
    try {
      render(<PagedHarness />)
      await settle()
      expect(document.activeElement).toBe(screen.getByText('inside'))

      act(() => screen.getByText('leave').click())
      await settle()

      // The trap is released: Tab is no longer intercepted, so focus stays put
      // rather than being yanked back into the hidden dialog.
      act(() => screen.getByText('leave').focus())
      tab()
      expect(document.activeElement).toBe(screen.getByText('leave'))
    } finally {
      delete Element.prototype.checkVisibility
    }
  })
})
