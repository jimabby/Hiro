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
                  <th>Match</th><th>Status</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(a)}>
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
                    <td style={{ color: 'var(--text-muted)' }}>
                      {new Date(a.applied_at).toLocaleDateString()}
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
              <button className="btn btn-ghost" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <a href={selected.job_url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', fontSize: 13 }}>View original posting →</a>
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

            {selected.tailored_resume && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8 }}>Tailored Resume</label>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
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
