import { useState, useEffect, useRef } from 'react'

// The bell in the sidebar header, and the list of every notification shown this
// session and recent ones before it — including toasts that were dismissed or
// pushed off the stack before anyone read them.

function timeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(at).toLocaleDateString()
}

const ICON = { success: '✓', error: '✗' }
const COLOUR = { success: 'var(--green)', error: 'var(--red)' }

export default function NotificationCenter({ entries, unread, onOpen, onClear }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const buttonRef = useRef(null)

  useEffect(() => {
    if (!open) return
    onOpen?.()
    function onDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onOpen])

  // While the panel is open, anything new is being read as it arrives.
  useEffect(() => {
    if (open && unread > 0) onOpen?.()
  }, [open, unread, onOpen])

  const newestFirst = [...entries].reverse()

  return (
    <div ref={rootRef} style={{ position: 'relative', marginLeft: 'auto' }}>
      <button
        ref={buttonRef}
        className="btn btn-ghost btn-sm"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls="notification-history"
        title="Notification history"
        onClick={() => setOpen(v => !v)}
        style={{ position: 'relative', padding: '3px 7px', fontSize: 14, lineHeight: 1 }}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span aria-hidden="true" data-testid="notification-unread" style={{
            position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16,
            borderRadius: 'var(--pill)', background: 'var(--red)', color: '#fff',
            fontSize: 9.5, fontWeight: 700, lineHeight: '16px', textAlign: 'center', padding: '0 4px',
            fontVariantNumeric: 'tabular-nums',
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
      {open && (
        <div id="notification-history" role="dialog" aria-label="Notification history"
          data-testid="notification-history"
          className="card"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 240,
            width: 340, maxHeight: '60vh', overflowY: 'auto', padding: 0,
            boxShadow: 'var(--shadow-lg)',
          }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Notifications</span>
            {entries.length > 0 && (
              <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={onClear}>Clear</button>
            )}
          </div>
          {newestFirst.length === 0 ? (
            <p style={{ padding: '14px 12px', margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              Nothing yet. Notifications you dismiss or miss are kept here.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {newestFirst.map(e => (
                <li key={e.id} style={{
                  display: 'flex', gap: 8, padding: '9px 12px', fontSize: 12,
                  borderBottom: '1px solid var(--border)',
                }}>
                  <span aria-hidden="true" style={{ color: COLOUR[e.type] || 'var(--accent)', flexShrink: 0 }}>
                    {ICON[e.type] || 'ℹ'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                    {e.type === 'error' && <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Error: </span>}
                    {e.msg}
                  </span>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11, flexShrink: 0 }}>{timeAgo(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
