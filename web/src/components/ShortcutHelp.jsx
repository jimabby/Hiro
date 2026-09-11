// Every keyboard shortcut in the app, in one place a person can find.
//
// The shortcuts existed — a digit for each page, "/" for search, arrows to walk
// the application list — but the only hint of any of them was a 10px kbd chip
// that appears on hover in the sidebar. A shortcut nobody knows about is a
// shortcut nobody uses. "?" is the convention every mail client and code host
// has taught people; the button in the sidebar footer is for everyone else.

export const SHORTCUTS = [
  { keys: ['1', '…', '9'], what: 'Switch page (in sidebar order)' },
  { keys: ['/'], what: 'Focus the search box on the Dashboard' },
  { keys: ['↑', '↓'], what: 'Previous / next application while one is open' },
  { keys: ['Esc'], what: 'Close the open panel or preview' },
  { keys: ['Ctrl', 'Enter'], what: 'Submit your answer to a screening question' },
  { keys: ['?'], what: 'Show this list' },
]

export default function ShortcutHelp({ open, onClose }) {
  if (!open) return null
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title"
      data-testid="shortcut-help"
      style={{
        position: 'fixed', inset: 0, background: 'var(--scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 250,
      }}
      onClick={onClose}>
      <div className="card modal-content" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 id="shortcut-help-title" style={{ fontSize: 16 }}>Keyboard shortcuts</h2>
          <button className="btn btn-ghost btn-sm" aria-label="Close shortcuts" onClick={onClose}>✕</button>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', alignItems: 'center', margin: 0 }}>
          {SHORTCUTS.map(s => (
            <div key={s.what} style={{ display: 'contents' }}>
              <dt style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                {s.keys.map((k, i) => (
                  k === '…'
                    ? <span key={i} style={{ color: 'var(--text-faint)', fontSize: 12 }}>…</span>
                    : <kbd key={i} className="kbd" style={{ fontSize: 11, lineHeight: '20px', padding: '0 7px', marginLeft: 0, color: 'var(--text)' }}>{k}</kbd>
                ))}
              </dt>
              <dd style={{ fontSize: 13, margin: 0 }}>{s.what}</dd>
            </div>
          ))}
        </dl>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 16, marginBottom: 0 }}>
          Shortcuts stay out of the way while you are typing in a field or a dialog is open.
        </p>
      </div>
    </div>
  )
}
