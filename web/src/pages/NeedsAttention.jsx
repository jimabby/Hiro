import { useState, useEffect, useRef, useMemo } from 'react'

// Application deadline parsed from the job ad. Colour tracks urgency, since
// the whole point of surfacing it here is to answer "which of these do I have
// to deal with first".
function ClosingBadge({ date }) {
  if (!date) return null
  const parsed = new Date(`${date}T12:00:00`)
  if (isNaN(parsed.getTime())) return null
  const days = Math.round((parsed - new Date()) / 86400000)
  const label = days < 0 ? 'closed' : days === 0 ? 'closes today' : days === 1 ? 'closes tomorrow' : `closes in ${days}d`
  const color = days < 0 ? 'var(--text-muted)' : days <= 2 ? 'var(--red)' : days <= 7 ? 'var(--yellow)' : 'var(--text-muted)'
  return (
    <span title={`Applications close ${date}`} style={{
      fontSize: 11, fontWeight: 600, color, border: `1px solid ${color}`,
      borderRadius: 6, padding: '1px 6px', opacity: days < 0 ? 0.6 : 1,
    }}>{label}</span>
  )
}

export default function NeedsAttention({ onCountChange, showToast }) {
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [applying, setApplying] = useState(null)
  const [applyLog, setApplyLog] = useState([])
  const [applyResult, setApplyResult] = useState(null)
  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [sortBy, setSortBy] = useState('date') // date, match, company
  const [selectedIds, setSelectedIds] = useState(new Set())
  const logEndRef = useRef(null)

  useEffect(() => { load() }, [])

  useEffect(() => {
    window.api.onAttentionLog((msg) => {
      setApplyLog(prev => [...prev, msg])
    })
    return () => window.api.removeAllListeners('attention:log')
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [applyLog])

  const filtered = useMemo(() => {
    let result = jobs
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(j => (j.job_title || '').toLowerCase().includes(q) || (j.company || '').toLowerCase().includes(q))
    }
    if (platformFilter) {
      result = result.filter(j => j.platform === platformFilter)
    }
    result = [...result].sort((a, b) => {
      if (sortBy === 'match') return (b.match_score || 0) - (a.match_score || 0)
      if (sortBy === 'company') return (a.company || '').localeCompare(b.company || '')
      if (sortBy === 'closing') {
        // Soonest deadline first; anything without a parsed date sinks to the
        // bottom rather than sorting as "very urgent".
        const av = a.closing_date || '￿'
        const bv = b.closing_date || '￿'
        if (av !== bv) return av.localeCompare(bv)
        return (b.found_at || '').localeCompare(a.found_at || '')
      }
      return (b.found_at || '').localeCompare(a.found_at || '') // date desc
    })
    return result
  }, [jobs, search, platformFilter, sortBy])

  async function load() {
    try {
      const data = await window.api.getAttentionJobs()
      setJobs(data)
      onCountChange(data.length)
    } catch (err) {
      showToast?.(`Failed to load attention jobs: ${err.message}`, 'error')
    }
  }

  async function dismiss(id) {
    try {
      await window.api.dismissAttentionJob(id)
      setJobs(prev => prev.filter(j => j.id !== id))
      onCountChange(prev => prev - 1)
      if (selected?.id === id) setSelected(null)
    } catch (err) {
      showToast?.(`Dismiss failed: ${err.message}`, 'error')
    }
  }

  async function deleteJob(id) {
    try {
      await window.api.deleteAttentionJob(id)
      setJobs(prev => prev.filter(j => j.id !== id))
      onCountChange(prev => prev - 1)
      if (selected?.id === id) setSelected(null)
    } catch (err) {
      showToast?.(`Delete failed: ${err.message}`, 'error')
    }
  }

  async function clearAll() {
    if (!window.confirm('Delete all attention jobs? This cannot be undone.')) return
    try {
      await window.api.clearAllAttentionJobs()
      setJobs([])
      onCountChange(0)
      setSelected(null)
    } catch (err) {
      showToast?.(`Clear failed: ${err.message}`, 'error')
    }
  }

  async function aiApply(job) {
    setApplying(job.id)
    setApplyLog([`Starting AI apply for ${job.job_title} at ${job.company}...`])
    setApplyResult(null)
    setSelected(null)

    try {
      const result = await window.api.applyAttentionJob(job.id)
      setApplyResult(result)

      if (result.success) {
        setJobs(prev => prev.filter(j => j.id !== job.id))
        onCountChange(prev => prev - 1)
        showToast?.(`Applied to ${job.job_title} at ${job.company}`, 'success')
      } else {
        showToast?.(result.reason || 'Application failed', 'error')
      }
    } catch (err) {
      setApplyResult({ success: false, reason: err.message })
      showToast?.(`Apply error: ${err.message}`, 'error')
    }
  }

  // Retry every selected job in one pass. The main process holds the applicator
  // busy for the whole run, so a scheduled scan can't interleave submissions.
  async function aiApplySelected() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`Retry AI Apply on ${ids.length} job${ids.length === 1 ? '' : 's'}? Each is submitted for real.`)) return

    setApplying('bulk')
    setApplyLog([`Retrying ${ids.length} job${ids.length === 1 ? '' : 's'}...`])
    setApplyResult(null)
    setSelected(null)

    try {
      const result = await window.api.applyAttentionJobs(ids)
      if (!result.success) {
        setApplyResult({ success: false, reason: result.reason })
        showToast?.(result.reason || 'Bulk retry failed', 'error')
        return
      }
      // Only the jobs that actually applied leave the list; the rest keep their
      // (possibly updated) failure reason so they can be retried again.
      const appliedIds = new Set(result.results.filter(r => r.success).map(r => r.id))
      setJobs(prev => prev.filter(j => !appliedIds.has(j.id)))
      onCountChange(prev => prev - appliedIds.size)
      setSelectedIds(new Set())
      setApplyResult({
        success: result.succeeded > 0,
        bulk: true,
        reason: `${result.succeeded} applied, ${result.failed} still need attention.`,
      })
      showToast?.(
        `${result.succeeded} of ${ids.length} applied`,
        result.succeeded > 0 ? 'success' : 'error'
      )
      load() // refresh reasons on the ones that failed again
    } catch (err) {
      setApplyResult({ success: false, reason: err.message })
      showToast?.(`Bulk retry error: ${err.message}`, 'error')
    }
  }

  function closeApplyModal() {
    setApplying(null)
    setApplyLog([])
    setApplyResult(null)
  }

  const platforms = [...new Set(jobs.map(j => j.platform))].sort()

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Needs Attention</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            Jobs that require manual application — AI couldn't auto-apply.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {jobs.length > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={clearAll}>
              Clear All
            </button>
          )}
          <button className="btn btn-ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {/* Search & filter bar */}
      {jobs.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search jobs or companies..."
            style={{ width: 180, padding: '6px 10px', fontSize: 12 }}
          />
          {platforms.length > 1 && (
            <select value={platformFilter} onChange={e => setPlatformFilter(e.target.value)} style={{ width: 180, padding: '6px 10px', fontSize: 12 }}>
              <option value="">All Platforms</option>
              {platforms.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ width: 180, padding: '6px 10px', fontSize: 12 }}>
            <option value="date">Newest First</option>
            <option value="closing">Closing Soonest</option>
            <option value="match">Highest Match</option>
            <option value="company">Company A–Z</option>
          </select>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {filtered.length} of {jobs.length} job{jobs.length !== 1 ? 's' : ''}
          </span>
          {selectedIds.size > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{selectedIds.size} selected</span>
              <button className="btn btn-primary" style={{ fontSize: 11, padding: '3px 8px', background: 'var(--accent)' }}
                onClick={aiApplySelected} disabled={applying !== null}>
                Retry Selected
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={async () => {
                for (const id of selectedIds) { await window.api.dismissAttentionJob(id) }
                setJobs(prev => prev.filter(j => !selectedIds.has(j.id)))
                onCountChange(prev => prev - selectedIds.size)
                setSelectedIds(new Set())
                showToast?.(`Dismissed ${selectedIds.size} jobs`, 'success')
              }}>Dismiss Selected</button>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--red)' }} onClick={async () => {
                for (const id of selectedIds) { await window.api.deleteAttentionJob(id) }
                setJobs(prev => prev.filter(j => !selectedIds.has(j.id)))
                onCountChange(prev => prev - selectedIds.size)
                setSelectedIds(new Set())
                showToast?.(`Deleted ${selectedIds.size} jobs`, 'success')
              }}>Delete Selected</button>
            </div>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>⚑</div>
          {jobs.length === 0 ? 'All clear — no jobs need attention.' : 'No matching jobs found.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map(job => (
            <div key={job.id} className="card" style={{ cursor: 'pointer' }} onClick={() => setSelected(job)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1 }}>
                  <input type="checkbox" style={{ width: 'auto', marginTop: 4, flexShrink: 0 }}
                    checked={selectedIds.has(job.id)}
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                      setSelectedIds(prev => {
                        const next = new Set(prev)
                        e.target.checked ? next.add(job.id) : next.delete(job.id)
                        return next
                      })
                    }}
                  />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{job.job_title}</span>
                    <span className="badge badge-blue">{job.platform}</span>
                    <span style={{
                      color: job.match_score >= 85 ? 'var(--green)' : 'var(--yellow)',
                      fontWeight: 600, fontSize: 13,
                    }}>{job.match_score}%</span>
                    {job.closing_date && <ClosingBadge date={job.closing_date} />}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {job.company} {job.salary ? `· ${job.salary}` : ''}
                  </div>
                  <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>
                    {job.reason}
                  </div>
                </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px', background: 'var(--accent)' }}
                    onClick={e => { e.stopPropagation(); aiApply(job) }}
                    disabled={applying !== null}>
                    {applying === job.id ? 'Applying...' : 'AI Apply'}
                  </button>
                  <a href={job.job_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                    <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px' }}>Apply Now</button>
                  </a>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={e => { e.stopPropagation(); dismiss(job.id) }}>
                    Dismiss
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px', color: 'var(--red)' }}
                    onClick={e => { e.stopPropagation(); deleteJob(job.id) }}>
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setSelected(null)}>
          <div className="card modal-content" style={{ width: 640, maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18 }}>{selected.job_title}</h2>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={() => deleteJob(selected.id)}>Delete</button>
                <button className="btn btn-ghost" onClick={() => setSelected(null)}>✕</button>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{selected.company} · {selected.platform} · {selected.salary}</div>
              <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{selected.reason}</div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <a href={selected.job_url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', fontSize: 13 }}>View job posting →</a>
            </div>

            {selected.match_explanation && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 6 }}>Match Explanation</label>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
                  {selected.match_explanation}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <label style={{ marginBottom: 10 }}>AI Talking Points</label>
              {(() => {
                let points = []
                if (Array.isArray(selected.talking_points)) points = selected.talking_points
                else { try { points = JSON.parse(selected.talking_points || '[]') } catch { /* corrupt row — degrade to none */ } }
                return points.map((p, i) => (
                  <div key={i} style={{
                    padding: '10px 14px', background: 'var(--surface2)',
                    borderRadius: 8, marginBottom: 8, fontSize: 13,
                    borderLeft: '3px solid var(--accent)',
                  }}>
                    {p}
                  </div>
                ))
              })()}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => dismiss(selected.id)}>Dismiss</button>
              <button className="btn btn-primary" style={{ background: 'var(--accent)' }}
                onClick={() => aiApply(selected)}>
                AI Apply
              </button>
              <a href={selected.job_url} target="_blank" rel="noreferrer">
                <button className="btn btn-primary">Apply Now</button>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* AI Apply progress modal */}
      {applying && (
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div className="card modal-content" style={{ width: 560, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16 }}>{applying === 'bulk' ? 'Retrying selected jobs...' : 'AI Applying...'}</h2>
              {applyResult && (
                <button className="btn btn-ghost" onClick={closeApplyModal}>Close</button>
              )}
            </div>

            <div style={{
              flex: 1, overflowY: 'auto', background: 'var(--surface2)',
              borderRadius: 8, padding: '12px 14px', fontFamily: 'monospace',
              fontSize: 12, minHeight: 160,
            }}>
              {applyLog.map((line, i) => (
                <div key={i} style={{ marginBottom: 4, color: 'var(--text-muted)' }}>{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>

            {applyResult && (
              <div style={{
                marginTop: 16, padding: '12px 14px', borderRadius: 8,
                background: applyResult.success ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: applyResult.success ? 'var(--green)' : 'var(--red)',
                fontSize: 13, fontWeight: 600,
              }}>
                {applyResult.bulk
                  ? applyResult.reason
                  : applyResult.success ? 'Application submitted successfully!' : `Failed: ${applyResult.reason}`}
              </div>
            )}

            {!applyResult && (
              <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
                A browser window will open — please do not close it.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
