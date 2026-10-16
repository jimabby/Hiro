import { useState, useEffect, useMemo, useRef } from 'react'

// Ctrl+K: one box that reaches every page, the common actions, and any
// application by title or company.
//
// Focus trapping comes from useModalFocus (mounted in App), which covers every
// aria-modal dialog — this one included — without opting in.

// Subsequence match with a score: every query character must appear in order.
// Consecutive runs and matches at word starts score higher, so "set" ranks
// "Settings" above "Reset filters". Returns null for no match.
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = String(text || '').toLowerCase()
  // A plain substring is always the best kind of match.
  const sub = t.indexOf(q)
  if (sub !== -1) return 1000 - sub + (sub === 0 || /\W/.test(t[sub - 1]) ? 200 : 0)
  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    run = found === ti ? run + 1 : 0
    score += 1 + run * 2 + (found === 0 || /\W/.test(t[found - 1]) ? 3 : 0)
    ti = found + 1
  }
  return score
}

export function rankCommands(query, commands, limit = 50) {
  if (!query.trim()) return commands.slice(0, limit)
  return commands
    .map(c => ({ c, s: fuzzyScore(query, `${c.label} ${c.hint || ''}`) }))
    .filter(x => x.s != null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.c)
}

const GROUP_LABEL = { page: 'Go to', action: 'Action', application: 'Application' }

export default function CommandPalette({ open, onClose, commands, onOpenApplication }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [apps, setApps] = useState([])
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Fresh each time it opens: applications change under every scan.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    let live = true
    Promise.resolve(window.api.getApplications?.({}))
      .then(rows => { if (live) setApps(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (live) setApps([]) })
    return () => { live = false }
  }, [open])

  const appCommands = useMemo(() => apps.map(a => ({
    id: `app-${a.id}`,
    group: 'application',
    label: `${a.job_title || 'Untitled role'} — ${a.company || 'Unknown company'}`,
    hint: a.status,
    run: () => onOpenApplication(a.id),
  })), [apps, onOpenApplication])

  const results = useMemo(() => {
    // Applications only once the user has typed: listing hundreds of them
    // under an empty query would bury the pages and actions.
    const pool = query.trim() ? [...commands, ...appCommands] : commands
    return rankCommands(query, pool)
  }, [query, commands, appCommands])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const run = (cmd) => {
    if (!cmd) return
    onClose()
    cmd.run()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(i => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const optionId = (i) => `command-option-${i}`

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Command palette"
      data-testid="command-palette"
      style={{
        position: 'fixed', inset: 0, background: 'var(--scrim)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 260, paddingTop: '12vh',
      }}
      onClick={onClose}>
      <div className="card modal-content" style={{ width: 560, maxWidth: 'calc(100vw - 32px)', padding: 0, overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          aria-label="Search pages, actions and applications"
          placeholder="Search pages, actions and applications…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          style={{
            width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: '1px solid var(--border)',
            borderRadius: 0, padding: '14px 16px', fontSize: 15, background: 'transparent',
          }}
        />
        <ul id="command-palette-list" role="listbox" aria-label="Results" ref={listRef}
          style={{ listStyle: 'none', margin: 0, padding: 6, maxHeight: '50vh', overflowY: 'auto' }}>
          {results.length === 0 && (
            <li role="presentation" style={{ padding: '12px 10px', fontSize: 13, color: 'var(--text-muted)' }}>
              No matches
            </li>
          )}
          {results.map((cmd, i) => (
            <li
              key={cmd.id}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => { if (i !== active) setActive(i) }}
              onClick={() => run(cmd)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13,
                background: i === active ? 'var(--surface3)' : 'transparent',
              }}
            >
              <span style={{
                fontSize: 10.5, color: 'var(--text-muted)', width: 74, flexShrink: 0,
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>{GROUP_LABEL[cmd.group] || cmd.group}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cmd.label}</span>
              {cmd.hint && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{cmd.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
