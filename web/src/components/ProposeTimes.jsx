import { useEffect, useState } from 'react'

// Free interview slots from the calendar, and an editable reply offering them.
// See services/availability.js. Nothing is sent from here: the reply is copied
// or opened in the user's own mail app.

export default function ProposeTimes({ applicationId, onClose, showToast }) {
  const [result, setResult] = useState(null)
  const [email, setEmail] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    window.api.proposeInterviewTimes(applicationId).then(res => {
      if (!live) return
      if (!res?.success) { setError(res?.error || 'Could not find free times'); return }
      setResult(res); setEmail(res.email); setTo(res.to || '')
    }).catch(err => live && setError(err.message))
    return () => { live = false }
  }, [applicationId])

  async function copy() {
    try { await navigator.clipboard.writeText(email); showToast?.('Reply copied', 'success') } catch { showToast?.('Could not copy', 'error') }
  }

  async function openInMail() {
    const res = await window.api.openMailDraft({ to, subject: result?.subject || '', body: email })
    if (!res?.success) showToast?.(res?.error || 'Could not open your mail app', 'error')
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Propose interview times" style={{
      position: 'fixed', inset: 0, background: 'var(--scrim)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120,
    }} onClick={onClose}>
      <div className="card modal-content" style={{ width: 640, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18 }}>Propose interview times</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!result && !error && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Checking your calendar…</p>}
        {error && <p style={{ fontSize: 13, color: 'var(--red)' }}>{error}</p>}

        {result && (
          <>
            <p style={{ fontSize: 12, color: result.calendarChecked ? 'var(--text-muted)' : 'var(--amber, var(--red))', marginBottom: 10 }}>
              {result.calendarChecked
                ? 'Checked against your calendar and every interview in Hiro.'
                : result.calendarError
                  ? `Your calendar could not be read (${result.calendarError}) — only interviews in Hiro were checked. Confirm these before sending.`
                  : 'No calendar is connected, so only interviews in Hiro were checked. Confirm these before sending, or connect a calendar in Settings.'}
            </p>
            {result.slots.length === 0 && (
              <p style={{ fontSize: 13 }}>No free slot fits your working hours in the days ahead. Widen them in Settings → Interview Availability.</p>
            )}
            <div className="form-group">
              <label htmlFor="propose-to">To</label>
              <input id="propose-to" type="email" value={to} placeholder="recruiter@company.com" onChange={e => setTo(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="propose-body">Reply</label>
              <textarea id="propose-body" rows={14} value={email} onChange={e => setEmail(e.target.value)}
                style={{ fontFamily: 'inherit', fontSize: 13 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={copy}>Copy</button>
              <button className="btn btn-primary" onClick={openInMail} disabled={!email.trim()}>Open in mail app</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
