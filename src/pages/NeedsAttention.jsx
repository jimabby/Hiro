import { useState, useEffect } from 'react'

export default function NeedsAttention({ onCountChange }) {
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    const data = await window.api.getAttentionJobs()
    setJobs(data)
    onCountChange(data.length)
  }

  async function dismiss(id) {
    await window.api.dismissAttentionJob(id)
    setJobs(prev => prev.filter(j => j.id !== id))
    onCountChange(prev => prev - 1)
    if (selected?.id === id) setSelected(null)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Needs Attention</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            Jobs that require manual application — AI couldn't auto-apply.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load}>Refresh</button>
      </div>

      {jobs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          All clear — no jobs need attention.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {jobs.map(job => (
            <div key={job.id} className="card" style={{ cursor: 'pointer' }} onClick={() => setSelected(job)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{job.job_title}</span>
                    <span className="badge badge-blue">{job.platform}</span>
                    <span style={{
                      color: job.match_score >= 85 ? 'var(--green)' : 'var(--yellow)',
                      fontWeight: 600, fontSize: 13,
                    }}>{job.match_score}%</span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {job.company} {job.salary ? `· ${job.salary}` : ''}
                  </div>
                  <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>
                    {job.reason}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <a href={job.job_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                    <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px' }}>Apply Now</button>
                  </a>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={e => { e.stopPropagation(); dismiss(job.id) }}>
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setSelected(null)}>
          <div className="card" style={{ width: 640, maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontSize: 18 }}>{selected.job_title}</h2>
              <button className="btn btn-ghost" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{selected.company} · {selected.platform} · {selected.salary}</div>
              <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{selected.reason}</div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <a href={selected.job_url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', fontSize: 13 }}>View job posting →</a>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ marginBottom: 10 }}>AI Talking Points</label>
              {(() => {
                const points = Array.isArray(selected.talking_points)
                  ? selected.talking_points
                  : JSON.parse(selected.talking_points || '[]')
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
              <a href={selected.job_url} target="_blank" rel="noreferrer">
                <button className="btn btn-primary">Apply Now</button>
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
