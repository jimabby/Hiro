import { useCallback, useEffect, useRef, useState } from 'react'

// Questions about your own job search, answered from your own data. See
// services/askHiro.js. The assistant can suggest a scan, a page to open or a
// follow-up date; a suggestion is a button, and nothing happens until it is
// pressed — a follow-up additionally shows what it will set, editable, and
// waits for a second confirm.
//
// Conversations are stored on the desktop (in the same database, so they are
// encrypted whenever the database is) and listed beside the chat. They used to
// live in this component's state and were lost the moment the page changed.

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

// Confirm-to-apply for a suggested follow-up. The date and note are the
// model's proposal, shown as editable fields; the main process checks them
// again (the application still exists, the date is a real upcoming day).
function FollowUpConfirm({ action, onDone, onCancel, showToast }) {
  const [date, setDate] = useState(action.date)
  const [note, setNote] = useState(action.note || '')
  const [saving, setSaving] = useState(false)

  async function confirm() {
    setSaving(true)
    try {
      const res = await window.api.askHiroSetFollowUp(action.id, date, note)
      if (res?.success) {
        showToast?.(`Follow-up set for ${res.date}`, 'success')
        onDone?.()
      } else {
        showToast?.(res?.error || 'Could not set the follow-up', 'error')
      }
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div role="group" aria-label="Confirm follow-up" style={{ marginTop: 6, padding: 10, background: 'var(--surface2)', borderRadius: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Follow-up date
        <input type="date" aria-label="Follow-up date" value={date} onChange={e => setDate(e.target.value)} />
      </label>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 160 }}>
        Note
        <input aria-label="Follow-up note" value={note} maxLength={200} onChange={e => setNote(e.target.value)} />
      </label>
      <button className="btn btn-primary btn-sm" disabled={saving || !date} onClick={confirm}>{saving ? 'Saving…' : 'Confirm follow-up'}</button>
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  )
}

export default function AskHiro({ showToast, onNavigate, onOpenApplication }) {
  const [threads, setThreads] = useState([])
  const [threadId, setThreadId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null) // `${messageIndex}:${actionIndex}`
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [messages, busy])

  const loadThreads = useCallback(async () => {
    try { setThreads((await window.api.askHiroThreads?.()) || []) } catch { /* the chat still works without the list */ }
  }, [])
  useEffect(() => { loadThreads() }, [loadThreads])

  async function openThread(id) {
    if (busy) return
    try {
      const t = await window.api.askHiroThread(id)
      if (!t) { showToast?.('That conversation no longer exists', 'error'); loadThreads(); return }
      setThreadId(t.id)
      setMessages(t.messages || [])
      setConfirming(null)
    } catch (err) {
      showToast?.(err.message, 'error')
    }
  }

  function newThread() {
    if (busy) return
    setThreadId(null)
    setMessages([])
    setConfirming(null)
  }

  async function deleteThread(id) {
    const res = await window.api.askHiroDeleteThread(id)
    if (res?.success === false) { showToast?.(res.error || 'Could not delete that conversation', 'error'); return }
    if (id === threadId) newThread()
    loadThreads()
  }

  async function send(text) {
    const q = String(text ?? input).trim()
    if (!q || busy) return
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setInput('')
    setBusy(true)
    try {
      // The history is the stored thread's, read by the main process — the page
      // only says which thread this question belongs to.
      const res = await window.api.askHiro(q, threadId)
      if (res?.threadId) setThreadId(res.threadId)
      if (res?.success) setMessages(prev => [...prev, { role: 'assistant', content: res.reply, actions: res.actions || [] }])
      else setMessages(prev => [...prev, { role: 'assistant', content: res?.error || 'Something went wrong.', error: true }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: err.message, error: true }])
    } finally {
      setBusy(false)
      loadThreads()
    }
  }

  async function runAction(a, key) {
    if (a.type === 'scan') {
      const res = await window.api.askHiroRunScan(a.keywords)
      if (res?.success) showToast?.(`Scan queued for "${a.keywords}" — drafts will wait in Review`, 'success')
      else showToast?.(res?.error || 'Could not queue the scan', 'error')
    } else if (a.type === 'open') {
      onNavigate?.(a.page)
    } else if (a.type === 'openApplication') {
      onOpenApplication?.(a.id)
    } else if (a.type === 'setFollowUp') {
      setConfirming(confirming === key ? null : key)
    }
  }

  const actionLabel = a => a.type === 'scan' ? `Scan for "${a.keywords}"`
    : a.type === 'open' ? `Open ${PAGE_LABELS[a.page] || a.page}`
      : a.type === 'setFollowUp' ? `Set follow-up${a.title ? ` for ${a.title}${a.company ? ` at ${a.company}` : ''}` : ''} on ${a.date}`
        : 'Open application'

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 64px)', maxWidth: 1080 }}>
      <aside aria-label="Conversations" style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
        <button className="btn btn-ghost btn-sm" onClick={newThread} disabled={busy}>New conversation</button>
        {threads.map(t => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 6, background: t.id === threadId ? 'var(--surface2)' : 'transparent' }}>
            <button className="btn btn-ghost btn-sm" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              aria-current={t.id === threadId ? 'true' : undefined} onClick={() => openThread(t.id)} title={t.title}>
              {t.title || 'Conversation'}
            </button>
            <button className="btn btn-ghost btn-sm" aria-label={`Delete conversation ${t.title}`} onClick={() => deleteThread(t.id)}>×</button>
          </div>
        ))}
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
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
            <div key={m.id ?? `local-${i}`} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
              <div style={{
                padding: '8px 12px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5,
                background: m.role === 'user' ? 'var(--accent)' : 'var(--surface2)',
                color: m.role === 'user' ? '#fff' : m.error ? 'var(--red)' : 'var(--text)',
              }}>{m.content}</div>
              {m.actions?.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {m.actions.map((a, j) => (
                    <button key={j} className="btn btn-ghost btn-sm" onClick={() => runAction(a, `${i}:${j}`)}>{actionLabel(a)}</button>
                  ))}
                </div>
              )}
              {m.actions?.map((a, j) => a.type === 'setFollowUp' && confirming === `${i}:${j}` && (
                <FollowUpConfirm key={`confirm-${j}`} action={a} showToast={showToast}
                  onDone={() => setConfirming(null)} onCancel={() => setConfirming(null)} />
              ))}
            </div>
          ))}
          {busy && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Thinking…</div>}
          <div ref={endRef} />
        </div>

        <form style={{ display: 'flex', gap: 8, marginTop: 12 }} onSubmit={e => { e.preventDefault(); send() }}>
          <input aria-label="Ask Hiro a question" value={input} onChange={e => setInput(e.target.value)}
            placeholder="e.g. Which interviews are coming up, and what do they have in common?" style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>Ask</button>
        </form>
      </div>
    </div>
  )
}
