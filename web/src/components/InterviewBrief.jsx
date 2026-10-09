import { useEffect, useState } from 'react'

// The night-before interview brief: when, what they said, what is in the news,
// the likely questions with your answers, and what to ask them. Built by
// services/interviewBrief.js; this only lays it out.

const section = { marginTop: 18 }
const heading = { fontSize: 13, fontWeight: 600, marginBottom: 6 }
const muted = { fontSize: 12, color: 'var(--text-muted)' }

function formatWhen(value, hasTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''))
  if (!m) return value
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
  const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  return hasTime ? `${date} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : date
}

export default function InterviewBrief({ applicationId, onClose, showToast }) {
  const [brief, setBrief] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load(refresh = false) {
    setLoading(true); setError(null)
    try {
      const res = await window.api.getInterviewBrief(applicationId, { refresh })
      if (res?.success) setBrief(res.brief)
      else setError(res?.error || 'Could not build the brief')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [applicationId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function copy() {
    const res = await window.api.getInterviewBriefText(applicationId)
    if (res?.success) {
      try { await navigator.clipboard.writeText(res.text); showToast?.('Brief copied', 'success') } catch { showToast?.('Could not copy', 'error') }
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Interview brief" style={{
      position: 'fixed', inset: 0, background: 'var(--scrim)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 120,
    }} onClick={onClose}>
      <div className="card modal-content" style={{ width: 720, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, marginBottom: 2 }}>Interview brief</h2>
            {brief && <div style={muted}>{brief.jobTitle} · {brief.company}{brief.salary ? ` · ${brief.salary}` : ''}</div>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" disabled={!brief} onClick={copy}>Copy</button>
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {loading && <p style={{ ...muted, marginTop: 16 }}>Putting the brief together — the first time can take a few seconds while the questions and news are fetched.</p>}
        {error && <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 16 }}>{error}</p>}

        {brief && !loading && (
          <>
            <div style={section}>
              <div style={heading}>When</div>
              {brief.interview ? (
                <div style={{ fontSize: 13 }}>
                  {formatWhen(brief.interview.scheduledAt, brief.interview.hasTime)}
                  {brief.interview.sourceZone && brief.interview.sourceLocal && (
                    <div style={muted}>They wrote {brief.interview.sourceLocal.slice(11, 16)} {brief.interview.sourceZone} — converted to your time.</div>
                  )}
                  {brief.interview.note && <div style={muted}>{brief.interview.note}</div>}
                </div>
              ) : <div style={muted}>No interview time is recorded for this application.</div>}
            </div>

            {brief.notes && (
              <div style={section}>
                <div style={heading}>Your notes</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{brief.notes}</div>
              </div>
            )}

            {brief.replies.length > 0 && (
              <div style={section}>
                <div style={heading}>What they said</div>
                {brief.replies.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, padding: '8px 10px', background: 'var(--surface2)', borderRadius: 6, marginBottom: 6 }}>
                    <div style={{ fontWeight: 600 }}>{r.subject}</div>
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{r.excerpt}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={section}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={heading}>In the news</div>
                <button className="btn btn-ghost btn-sm" onClick={() => load(true)}>Refresh</button>
              </div>
              {brief.research?.summary && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 8 }}>{brief.research.summary}</div>}
              {brief.research?.headlines?.length ? (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                  {brief.research.headlines.map((h, i) => (
                    <li key={i} style={{ marginBottom: 3 }}>
                      <a href={h.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{h.title}</a>
                      <span style={muted}> — {h.source ? `${h.source}, ` : ''}{h.date}</span>
                    </li>
                  ))}
                </ul>
              ) : <div style={muted}>No recent headlines found. The summary only ever repeats what the headlines say.</div>}
            </div>

            <div style={section}>
              <div style={heading}>Likely questions{brief.answered ? ` — ${brief.answered} answered` : ''}</div>
              {brief.questions.length === 0 && <div style={muted}>None yet. Set up an AI provider to have them prepared.</div>}
              {brief.questions.map((q, i) => (
                <details key={i} style={{ marginBottom: 6, fontSize: 13 }}>
                  <summary style={{ cursor: 'pointer' }}>
                    {q.question}{q.category ? <span style={muted}> · {q.category}</span> : null}
                    {q.savedAnswer && <span style={{ ...muted, color: 'var(--green)' }}> · your answer saved</span>}
                  </summary>
                  <div style={{ padding: '6px 0 0 14px', whiteSpace: 'pre-wrap' }}>
                    {q.savedAnswer || <span style={muted}>Draft: {q.sampleAnswer || '—'}</span>}
                  </div>
                </details>
              ))}
            </div>

            <div style={section}>
              <div style={heading}>Questions to ask them</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {brief.questionsToAsk.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            </div>

            {brief.jobUrl && (
              <div style={{ ...section, fontSize: 12 }}>
                <a href={brief.jobUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Re-read the job posting →</a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
