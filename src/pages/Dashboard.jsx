import { useState, useEffect, useRef } from 'react'

const STATUS_BADGE = {
  applied: { label: 'Applied', color: 'badge-blue' },
  interview: { label: 'Interview', color: 'badge-green' },
  rejected: { label: 'Rejected', color: 'badge-red' },
  pending: { label: 'Pending', color: 'badge-yellow' },
  skipped: { label: 'Skipped', color: 'badge-gray' },
}

export default function Dashboard({ logs, scanRunning, onScanStart }) {
  const [stats, setStats] = useState(null)
  const [apps, setApps] = useState([])
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState({ status: '', platform: '' })
  const [resumeExpanded, setResumeExpanded] = useState(false)
  const logRef = useRef(null)

  useEffect(() => { loadData() }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  async function loadData() {
    const [s, a] = await Promise.all([
      window.api.getStats(),
      window.api.getApplications({}),
    ])
    setStats(s)
    setApps(a)
  }

  async function stopScan() {
    await window.api.stopAutomation()
  }

  async function changeStatus(id, status, e) {
    e.stopPropagation()
    await window.api.updateApplicationStatus(id, status)
    setApps(prev => prev.map(a => a.id === id ? { ...a, status } : a))
    if (selected?.id === id) setSelected(s => ({ ...s, status }))
  }

  async function saveComment(id, comment) {
    await window.api.updateApplicationComment(id, comment)
    setApps(prev => prev.map(a => a.id === id ? { ...a, comment } : a))
    if (selected?.id === id) setSelected(s => ({ ...s, comment }))
  }

  async function deleteApp(id, e) {
    e.stopPropagation()
    await window.api.deleteApplication(id)
    setApps(prev => prev.filter(a => a.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  async function clearAll() {
    if (!window.confirm('Delete all application history? This cannot be undone.')) return
    await window.api.clearAllApplications()
    setApps([])
    setSelected(null)
    loadData()
  }

  const filtered = apps.filter(a => {
    if (filter.status && a.status !== filter.status) return false
    if (filter.platform && a.platform !== filter.platform) return false
    return true
  })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {scanRunning && (
            <button className="btn btn-danger" onClick={stopScan}>
              Stop Scan
            </button>
          )}
          <button className="btn btn-primary" onClick={onScanStart} disabled={scanRunning}>
            {scanRunning ? 'Scanning...' : 'Run Scan Now'}
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
          {[
            { label: 'Today', value: stats.totalToday },
            { label: 'This Week', value: stats.totalThisWeek },
            { label: 'All Time', value: stats.totalAllTime },
            { label: 'Interviews', value: stats.interviews },
          ].map(s => (
            <div key={s.label} className="card stat-card">
              <div className="stat-value">{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Activity Log</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{logs.length} entries</span>
          </div>
          <div className="log-box" ref={logRef}>{logs.join('\n')}</div>
        </div>
      )}

      {/* Applications */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Jobs ({filtered.length})</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {apps.length > 0 && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={clearAll}>
                Clear All
              </button>
            )}
            <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))} style={{ width: 'auto' }}>
              <option value="">All Statuses</option>
              <option value="applied">Applied</option>
              <option value="interview">Interview</option>
              <option value="rejected">Rejected</option>
              <option value="pending">Pending</option>
              <option value="skipped">Skipped (low score)</option>
            </select>
            <select value={filter.platform} onChange={e => setFilter(f => ({ ...f, platform: e.target.value }))} style={{ width: 'auto' }}>
              <option value="">All Platforms</option>
              <option value="Seek">Seek</option>
              <option value="Indeed">Indeed</option>
              <option value="LinkedIn">LinkedIn</option>
            </select>
            <button className="btn btn-ghost" onClick={loadData} style={{ whiteSpace: 'nowrap' }}>Refresh</button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            No jobs yet. Run a scan to get started.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th><th>Company</th><th>Platform</th>
                  <th>Match</th><th>Status</th><th>Comment</th><th>Date</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => { setSelected(a); setResumeExpanded(false) }}>
                    <td style={{ fontWeight: 500 }}>{a.job_title}</td>
                    <td>{a.company}</td>
                    <td><span className="badge badge-blue">{a.platform}</span></td>
                    <td>
                      <span style={{
                        color: a.match_score >= 85 ? 'var(--green)' : a.match_score >= 70 ? 'var(--yellow)' : 'var(--text-muted)',
                        fontWeight: 600,
                      }}>{a.match_score}%</span>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      {a.status === 'skipped' ? (
                        <span className="badge badge-gray">Skipped</span>
                      ) : (
                        <select value={a.status} style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
                          onChange={e => changeStatus(a.id, e.target.value, e)}>
                          <option value="applied">Applied</option>
                          <option value="interview">Interview</option>
                          <option value="rejected">Rejected</option>
                          <option value="pending">Pending</option>
                        </select>
                      )}
                    </td>
                    <td onClick={e => e.stopPropagation()} style={{ minWidth: 140 }}>
                      <input
                        defaultValue={a.comment || ''}
                        placeholder="Add note..."
                        onBlur={e => saveComment(a.id, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                        style={{
                          background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                          color: 'var(--text)', fontSize: 12, width: '100%', padding: '2px 4px',
                          outline: 'none',
                        }}
                      />
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {new Date(a.applied_at).toLocaleDateString()}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)', padding: '2px 6px' }}
                        onClick={e => deleteApp(a.id, e)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selected && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setSelected(null)}>
          <div className="card" style={{ width: 680, maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <h2 style={{ fontSize: 18 }}>{selected.job_title}</h2>
                  <span className={`badge ${STATUS_BADGE[selected.status]?.color || 'badge-gray'}`}>
                    {STATUS_BADGE[selected.status]?.label || selected.status}
                  </span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {selected.company} · {selected.platform} {selected.salary ? `· ${selected.salary}` : ''}
                  {' · '}<span style={{ color: selected.match_score >= 80 ? 'var(--green)' : 'var(--yellow)' }}>
                    {selected.match_score}% match
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={async () => {
                    await window.api.deleteApplication(selected.id)
                    setApps(prev => prev.filter(a => a.id !== selected.id))
                    setSelected(null)
                  }}>Delete</button>
                <button className="btn btn-ghost" onClick={() => setSelected(null)}>✕</button>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <a href={selected.job_url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', fontSize: 13 }}>View original posting →</a>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ marginBottom: 6 }}>Comment</label>
              <textarea
                defaultValue={selected.comment || ''}
                placeholder="Add a note about this application..."
                onBlur={e => saveComment(selected.id, e.target.value)}
                style={{ minHeight: 60, resize: 'vertical', fontSize: 13 }}
              />
            </div>

            {selected.job_description && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8 }}>Job Description</label>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto',
                }}>{selected.job_description}</pre>
              </div>
            )}

            {selected.cover_letter && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ marginBottom: 0 }}>Cover Letter</label>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => window.api.downloadResume(selected.cover_letter, `Cover Letter - ${selected.job_title} - ${selected.company}`)}>
                    Download .docx
                  </button>
                </div>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
                }}>{selected.cover_letter}</pre>
              </div>
            )}

            {selected.tailored_resume && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ marginBottom: 0 }}>Tailored Resume</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => setResumeExpanded(e => !e)}>
                      {resumeExpanded ? 'Collapse' : 'Expand'}
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => window.api.downloadResume(selected.tailored_resume, `${selected.job_title} - ${selected.company}`)}>
                      Download .docx
                    </button>
                  </div>
                </div>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap',
                  maxHeight: resumeExpanded ? 'none' : 200, overflow: 'auto',
                }}>{selected.tailored_resume}</pre>
              </div>
            )}

            {selected.screening_qa && JSON.parse(selected.screening_qa || '[]').length > 0 && (
              <div>
                <label style={{ marginBottom: 8 }}>Screening Q&A</label>
                {JSON.parse(selected.screening_qa).map((qa, i) => (
                  <div key={i} style={{ marginBottom: 10, padding: 12, background: 'var(--surface2)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4, fontSize: 13 }}>Q: {qa.question}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>A: {qa.answer}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
