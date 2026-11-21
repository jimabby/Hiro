import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// The thank-you note after an interview (services/thankYouNote.js). Drafted by
// the AI, edited here, and sent by the user from their own mail app — nothing
// is sent from Hiro. The draft carries one placeholder for something that
// really came up in the interview, because the model was not in the room.

function ThankYouNoteDialog({ interviewId, onClose, onDone, showToast }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState(null)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setDraft(null); setError(null)
    window.api.draftThankYou(interviewId).then((res) => {
      if (!live) return
      if (!res?.success) { setError(res?.error || 'Could not draft the note'); return }
      setDraft(res); setTo(res.to || ''); setSubject(res.subject || ''); setBody(res.body || '')
    }).catch(err => live && setError(err.message))
    return () => { live = false }
  }, [interviewId, nonce])

  const unfilled = draft?.placeholder && body.includes(draft.placeholder)

  async function copy() {
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); showToast?.('Note copied', 'success') } catch { showToast?.('Could not copy', 'error') }
  }

  async function openInMail() {
    const res = await window.api.openMailDraft({ to, subject, body })
    if (!res?.success) showToast?.(res?.error || 'Could not open your mail app', 'error')
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Thank-you note" style={{
      position: 'fixed', inset: 0, background: 'var(--scrim)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120,
    }} onClick={onClose}>
      <div className="card modal-content" style={{ width: 640, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18 }}>Thank-you note</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!draft && !error && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Drafting…</p>}
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{error}</p>}

        {draft && (
          <>
            <p style={{ fontSize: 12, color: unfilled ? 'var(--amber, var(--red))' : 'var(--text-muted)', marginBottom: 10 }}>
              {unfilled
                ? `Replace ${draft.placeholder} with something that really came up in the interview — Hiro was not there, so it does not guess.`
                : 'Nothing has been sent. Check it reads like you, then send it from your mail app.'}
            </p>
            <div className="form-group">
              <label htmlFor="thanks-to">To</label>
              <input id="thanks-to" type="email" value={to} placeholder="interviewer@company.com" onChange={e => setTo(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="thanks-subject">Subject</label>
              <input id="thanks-subject" value={subject} onChange={e => setSubject(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="thanks-body">Note</label>
              <textarea id="thanks-body" rows={12} value={body} onChange={e => setBody(e.target.value)}
                style={{ fontFamily: 'inherit', fontSize: 13 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => setNonce(n => n + 1)}>Redraft</button>
              <button className="btn btn-ghost" onClick={copy}>Copy</button>
              <button className="btn btn-ghost" onClick={openInMail} disabled={!body.trim()}>Open in mail app</button>
              <button className="btn btn-primary" onClick={onDone}>Mark sent</button>
            </div>
          </>
        )}
        {error && <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onDone}>Mark done without a note</button>
        </div>}
      </div>
    </div>
  )
}

// Rendered into <body>, not where it is opened from. It is opened from inside
// glass cards (the Upcoming Interviews panel, the task inbox), and a card's
// backdrop-filter makes it the containing block for position:fixed
// descendants — so the overlay was boxed into the card and painted under the
// cards after it, instead of covering the window.
export default function ThankYouNote(props) {
  return createPortal(<ThankYouNoteDialog {...props} />, document.body)
}
