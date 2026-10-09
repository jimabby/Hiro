import { useEffect, useRef, useState } from 'react'

// Questions about your own job search, answered from your own data. See
// services/askHiro.js. The assistant can suggest a scan or a page to open;
// a suggestion is a button, and nothing happens until it is pressed.

const STARTERS = [
  'Which applications have gone quiet for over two weeks?',
  'What do I need to do this week?',
  'Which platform gets me the most interviews?',
  'Summarise my search so far.',
]

const PAGE_LABELS = {
  dashboard: 'Dashboard', pipeline: 'Pipeline', offers: 'Offers', review: 'Review', attention: 'Needs Attention',
  timeline: 'Timeline', analytics: 'Analytics', settings: 'Settings', workbench: 'Workbench',
}

export default function AskHiro({ showToast, onNavigate, onOpenApplication }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [messages, busy])

  async function send(text) {
    const q = String(text ?? input).trim()
    if (!q || busy) return
    const history = messages.map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setInput('')
    setBusy(true)
    try {
      const res = await window.api.askHiro(q, history)
      if (res?.success) setMessages(prev => [...prev, { role: 'assistant', content: res.reply, actions: res.actions || [] }])
      else setMessages(prev => [...prev, { role: 'assistant', content: res?.error || 'Something went wrong.', error: true }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: err.message, error: true }])
    } finally {
      setBusy(false)
    }
  }

  async function runAction(a) {
    if (a.type === 'scan') {
      const res = await window.api.askHiroRunScan(a.keywords)
      if (res?.success) showToast?.(`Scan queued for "${a.keywords}" — drafts will wait in Review`, 'success')
      else showToast?.(res?.error || 'Could not queue the scan', 'error')
    } else if (a.type === 'open') {
      onNavigate?.(a.page)
    } else if (a.type === 'openApplication') {
      onOpenApplication?.(a.id)
    }
  }

  const actionLabel = a => a.type === 'scan' ? `Scan for "${a.keywords}"`
    : a.type === 'open' ? `Open ${PAGE_LABELS[a.page] || a.page}`
      : 'Open application'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', maxWidth: 820 }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Ask Hiro</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Questions about your own applications, interviews and offers. Answers come from your data only,
          and Hiro never changes anything from here — suggested actions are buttons you choose to press.
        </p>
      </div>

      <div className="card" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }} aria-live="polite">
        {messages.length === 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {STARTERS.map(s => (
              <button key={s} className="btn btn-ghost btn-sm" onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <div style={{
              padding: '8px 12px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5,
              background: m.role === 'user' ? 'var(--accent)' : 'var(--surface2)',
              color: m.role === 'user' ? '#fff' : m.error ? 'var(--red)' : 'var(--text)',
            }}>{m.content}</div>
            {m.actions?.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {m.actions.map((a, j) => (
                  <button key={j} className="btn btn-ghost btn-sm" onClick={() => runAction(a)}>{actionLabel(a)}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Thinking…</div>}
        <div ref={endRef} />
      </div>

      <form style={{ display: 'flex', gap: 8, marginTop: 12 }} onSubmit={e => { e.preventDefault(); send() }}>
        <input aria-label="Ask Hiro a question" value={input} onChange={e => setInput(e.target.value)}
          placeholder="e.g. Which interviews are coming up, and what do they have in common?" style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>Ask</button>
        {messages.length > 0 && <button className="btn btn-ghost" type="button" onClick={() => setMessages([])}>Clear</button>}
      </form>
    </div>
  )
}
