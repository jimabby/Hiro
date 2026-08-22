import { useEffect } from 'react'

// Focus management for every modal in the app, implemented once.
//
// There are ten `aria-modal="true"` dialogs across App, Dashboard, Review,
// NeedsAttention and Settings. None of them trapped focus: Tab from an open
// dialog walked straight into the page behind it, where the controls are
// visually obscured by the scrim but still focusable and still clickable by
// keyboard. On the submit-confirmation dialog in particular that is a real
// hazard — the page behind it can start another scan while an application is
// sitting one keystroke from being sent to an employer.
//
// This is deliberately a single document-level observer rather than a hook each
// dialog opts into. Ten call sites is ten chances to forget, the dialogs are
// spread across five files that are edited independently, and every one of them
// already declares `aria-modal="true"` — the correct marker is present and just
// wasn't doing anything. Watching for that marker means a dialog added later is
// covered the moment it is written, without knowing this file exists.

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Visibility matters here for a specific reason: every page in this app stays
// mounted and is merely hidden with display:none when inactive. A dialog left
// open on Settings is still in the DOM, still carrying aria-modal, after the
// user has switched to the Dashboard — and trapping focus inside an invisible
// dialog is worse than not trapping at all.
//
// checkVisibility() is the only check that answers this correctly, and the
// renderer is Chromium, where it exists. offsetParent and getClientRects were
// both tried and are wrong for the job: they depend on layout, so they report
// "hidden" for absolutely everything under a test DOM that does no layout, and
// offsetParent is additionally null for any position:fixed element — which is
// exactly what every overlay in this app is. Where the method is missing,
// treating elements as visible is the safe fallback: the trap still works, it
// just stops filtering.
function isVisible(el) {
  if (typeof el.checkVisibility !== 'function') return true
  return el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
}

function focusableWithin(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    el => isVisible(el) || el === document.activeElement
  )
}

function topmostDialog() {
  const open = [...document.querySelectorAll('[aria-modal="true"]')].filter(isVisible)
  // Last in DOM order wins. The app stacks dialogs by z-index rather than
  // nesting them, and the later-rendered one is always the higher z-index —
  // see the submit-review (310) and question (300) dialogs in App.
  return open.length ? open[open.length - 1] : null
}

export default function useModalFocus() {
  useEffect(() => {
    let active = null            // the dialog currently trapped
    let restoreTo = null         // what had focus before it opened

    function onKeyDown(e) {
      if (e.key !== 'Tab' || !active) return
      const items = focusableWithin(active)
      if (!items.length) {
        // Nothing to move to, so the only correct behaviour is to stay put —
        // letting Tab through would leave the dialog entirely.
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      // Focus escaping the dialog (via a click on the scrim, or a control that
      // unmounted) is pulled back rather than being allowed to wrap from
      // wherever it happens to be.
      if (!active.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    function sync() {
      const next = topmostDialog()
      if (next === active) return

      if (!active && next) {
        // Opening: remember where to put focus back, but only on the outermost
        // dialog — a second dialog stacking on the first must restore to the
        // first, which this handles by simply not overwriting on re-entry.
        restoreTo = document.activeElement
      }

      active = next

      if (active) {
        // An element inside may already have autoFocus (the question dialog's
        // textarea does); don't fight it.
        if (!active.contains(document.activeElement)) {
          const items = focusableWithin(active)
          if (items.length) items[0].focus()
          else {
            // A dialog with no controls still has to receive focus, or the
            // screen reader keeps announcing the page behind it.
            active.setAttribute('tabindex', '-1')
            active.focus()
          }
        }
      } else if (restoreTo?.isConnected) {
        // Closing: put focus back where it came from. Without this it lands on
        // <body> and the next Tab starts from the top of the sidebar, which is
        // nowhere near whatever the user was doing.
        restoreTo.focus()
        restoreTo = null
      } else {
        restoreTo = null
      }
    }

    // React commits the dialog into the DOM without any event we can hook, so
    // the DOM itself is the signal.
    //
    // childList alone is not enough. Switching pages does not unmount anything
    // here — App toggles each page's wrapper between display:block and
    // display:none — so clicking a nav item while a page-level dialog is open
    // hides that dialog by an attribute change and nothing else. Without
    // watching `style`, focus would stay trapped inside a dialog the user can
    // no longer see, which is a keyboard lock with no visible cause.
    // `sync` early-returns when the topmost dialog is unchanged, so the extra
    // notifications cost a querySelectorAll and nothing more.
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-modal'],
    })
    document.addEventListener('keydown', onKeyDown, true)
    sync()

    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}
