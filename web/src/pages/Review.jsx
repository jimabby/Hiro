import { useState, useEffect, useCallback, useRef } from 'react'

// Review-before-submit queue.
//
// When review mode is on, a job that clears the match threshold is drafted in
// full — resume tailored, cover letter written — but parked as 'held' instead
// of being submitted. Nothing reaches an employer from this page until it is
// approved here. Approving costs no AI calls: the documents were written when
// the job was found and are stored on the row.

function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function scoreColour(score) {
  if (score == null) return 'var(--text-muted)'
  if (score >= 85) return 'var(--green)'
  if (score >= 70) return 'var(--accent)'
  return 'var(--text-muted)'
}

export default function Review({ active, showToast, onCountChange }) {
  const [held, setHeld] = useState([])
  const [followUps, setFollowUps] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(() => new Set())
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const [confirmReject, setConfirmReject] = useState(null)
  const logRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const [rows, drafts] = await Promise.all([
        window.api.getHeldApplications(),
        window.api.getFollowUpDrafts?.() || Promise.resolve([]),
      ])
      const list = Array.isArray(rows) ? rows : []
      const followUpList = Array.isArray(drafts) ? drafts : []
      setHeld(list)
      setFollowUps(followUpList)
      onCountChange?.(list.length + followUpList.length)
      // Drop selections for rows that no longer exist, or "Approve 3" would
      // act on jobs that were already submitted.
      setSelected(prev => new Set([...prev].filter(id => list.some(r => r.id === id))))
    } catch (err) {
      showToast?.(`Could not load the review queue: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [onCountChange, showToast])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (active) load() }, [active, load])

  useEffect(() => {
    window.api.onReviewLog?.((msg) => setLog(prev => [...prev.slice(-100), msg]))
    return () => window.api.removeAllListeners?.('review:log')
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const allSelected = held.length > 0 && selected.size === held.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(held.map(h => h.id)))

  async function openDetail(row) {
    // The list query omits the document columns — fetch the full row so the
    // drafted resume and cover letter can actually be read before approving.
    try {
      const full = await window.api.getApplication(row.id)
      setDetail(full || row)
    } catch {
      setDetail(row)
    }
  }

  async function approve(ids) {
    if (ids.length === 0) return
    setBusy(true)
    setLog([])
    try {
      const res = ids.length === 1
        ? await window.api.approveHeldApplication(ids[0])
        : await window.api.approveHeldApplications(ids)

      if (ids.length === 1) {
        if (res?.success) showToast?.('Application submitted', 'success')
        else showToast?.(res?.reason || 'Could not submit', 'error')
      } else {
        showToast?.(
          `${res?.succeeded || 0} of ${ids.length} submitted${res?.failed ? ` — ${res.failed} failed` : ''}`,
          res?.failed ? 'error' : 'success'
        )
      }
    } catch (err) {
      showToast?.(`Submit failed: ${err.message}`, 'error')
    } finally {
      setBusy(false)
      setDetail(null)
      load()
    }
  }

  async function reject(id) {
    try {
      await window.api.rejectHeldApplication(id)
      showToast?.('Draft rejected — filed as skipped so it will not be re-drafted', 'info')
    } catch (err) {
      showToast?.(`Could not reject: ${err.message}`, 'error')
    } finally {
      setConfirmReject(null)
      setDetail(null)
      load()
    }
  }

  async function resolveFollowUp(id, approve) {
    setBusy(true)
    try {
      const result = approve
        ? await window.api.approveFollowUpDraft(id)
        : await window.api.rejectFollowUpDraft(id)
      if (result?.success) showToast?.(approve ? 'Follow-up email sent' : 'Follow-up draft rejected', approve ? 'success' : 'info')
      else showToast?.(result?.reason || 'Could not update follow-up', 'error')
    } catch (err) {
      showToast?.(`Could not update follow-up: ${err.message}`, 'error')
    } finally {
      setBusy(false)
      load()
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading review queue…</div>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Review</h1>
        {held.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={toggleAll} disabled={busy}>
              {allSelected ? 'Clear selection' : `Select all ${held.length}`}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => approve([...selected])}
            >
              {busy ? 'Submitting…' : `Approve & submit${selected.size ? ` (${selected.size})` : ''}`}
            </button>
          </div>
        )}
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20, maxWidth: 720 }}>
        These applications were drafted but <strong>not sent</strong>. Read what would go out, then approve
        or reject. Approving submits the documents already written — it costs no extra AI calls.
        {' '}Turn this queue off in Settings → Automation if you would rather Hiro submit directly.
      </p>

      {followUps.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>Follow-up emails</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>AI drafted these messages, but none has been emailed yet.</p>
          {followUps.map(draft => (
            <div key={draft.id} style={{ borderTop: '1px solid var(--border)', padding: '14px 0' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{draft.job_title} at {draft.company}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 10px' }}>To: {draft.recipient} · {draft.subject}</div>
              <pre style={{ background: 'var(--surface2)', borderRadius: 8, padding: 12, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12 }}>{draft.body}</pre>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => resolveFollowUp(draft.id, false)}>Reject</button>
                <button className="btn btn-primary" disabled={busy} onClick={() => resolveFollowUp(draft.id, true)}>Approve & send</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {held.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.5 }}>✓</div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>Nothing waiting for review.</div>
          <div style={{ fontSize: 12 }}>
            With review mode on, jobs that clear your match threshold will appear here before anything is sent.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface2)', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px', width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th style={{ padding: '10px 12px' }}>Role</th>
                <th style={{ padding: '10px 12px' }}>Company</th>
                <th style={{ padding: '10px 12px' }}>Platform</th>
                <th style={{ padding: '10px 12px' }}>Resume</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Match</th>
                <th style={{ padding: '10px 12px' }}>Held</th>
                <th style={{ padding: '10px 12px', width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {held.map(row => (
                <tr key={row.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={`Select ${row.job_title}`}
                    />
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button
                      onClick={() => openDetail(row)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        color: 'var(--text)', fontSize: 13, textAlign: 'left', textDecoration: 'underline',
                        textDecorationColor: 'var(--border)',
                      }}
                    >
                      {row.job_title}
                    </button>
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>{row.company}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>{row.platform}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>{row.resume_name || '—'}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: scoreColour(row.match_score), fontWeight: 600 }}>
                    {row.match_score != null ? `${row.match_score}%` : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 12 }}>{fmtWhen(row.held_at)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmReject(row)} style={{ marginRight: 6 }}>
                      Reject
                    </button>
                    <button className="btn btn-primary" disabled={busy} onClick={() => approve([row.id])}>
                      Submit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {busy && log.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Submitting…</div>
          <div ref={logRef} style={{
            maxHeight: 180, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11,
            color: 'var(--text-muted)', whiteSpace: 'pre-wrap',
          }}>
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}

      {/* Draft detail — what would actually be sent */}
      {detail && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Draft detail" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 24,
        }}>
          <div className="card modal-content" style={{ width: 780, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div>
                <h2 style={{ fontSize: 17, marginBottom: 4 }}>{detail.job_title}</h2>
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {detail.company} · {detail.platform}
                  {detail.match_score != null && <> · <span style={{ color: scoreColour(detail.match_score) }}>{detail.match_score}% match</span></>}
                </div>
                {/* Salary belongs in the approval decision, not two clicks away
                    on the posting — it is often the reason to reject. */}
                <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>
                  {detail.salary ? detail.salary : 'Salary not listed in the ad'}
                </div>
              </div>
              <button className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button>
            </div>

            {detail.match_explanation && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, fontStyle: 'italic' }}>
                {detail.match_explanation}
              </p>
            )}

            {detail.recruiter_email && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                Follow-up contact found in the ad: <strong>{detail.recruiter_email}</strong>
              </div>
            )}

            <section style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Cover letter that would be sent</h3>
              <pre style={{
                background: 'var(--surface2)', borderRadius: 8, padding: 14, fontSize: 12,
                whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--text)', margin: 0,
                maxHeight: 260, overflowY: 'auto',
              }}>{detail.cover_letter || '(none generated)'}</pre>
            </section>

            <section style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>
                Tailored resume {detail.resume_name ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· from “{detail.resume_name}”</span> : null}
              </h3>
              <pre style={{
                background: 'var(--surface2)', borderRadius: 8, padding: 14, fontSize: 12,
                whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--text)', margin: 0,
                maxHeight: 300, overflowY: 'auto',
              }}>{detail.tailored_resume || '(master resume, untailored)'}</pre>
            </section>

            {/* Screening answers are written by the form filler at submission
                time, not when the draft is held, so there is nothing to show
                here yet. Saying so is better than a silent omission that reads
                like "this job had no questions". */}
            <section style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Screening questions</h3>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                Not yet written. This posting’s questions are read from the form during submission,
                so they cannot be previewed here. Anything the AI cannot answer confidently still
                stops and asks you while the application is being filled in.
              </p>
            </section>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 22, gap: 8 }}>
              {detail.job_url
                ? <a className="btn btn-ghost" href={detail.job_url} target="_blank" rel="noreferrer">View posting</a>
                : <span />}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmReject(detail)}>Reject</button>
                <button className="btn btn-primary" disabled={busy} onClick={() => approve([detail.id])}>
                  {busy ? 'Submitting…' : 'Approve & submit'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmReject && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm rejection" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }}>
          <div className="card modal-content" style={{ width: 440 }}>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Reject this draft?</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>
              <strong>{confirmReject.job_title}</strong> at {confirmReject.company} will be filed as skipped.
              Nothing is sent, and the job will not be re-drafted on the next scan.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setConfirmReject(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => reject(confirmReject.id)}>Reject draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
