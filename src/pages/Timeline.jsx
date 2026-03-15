import { useState, useEffect } from 'react'

const PLATFORM_COLORS = { Seek: 'badge-blue', LinkedIn: 'badge-green', Indeed: 'badge-yellow' }

export default function Timeline() {
  const [byDate, setByDate] = useState({})
  const [expanded, setExpanded] = useState(null)
  const [dayJobs, setDayJobs] = useState([])

  useEffect(() => {
    window.api.getApplicationsByDate().then(rows => {
      const grouped = {}
      rows.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = []
        grouped[r.date].push({ platform: r.platform, count: r.count })
      })
      setByDate(grouped)
    })
  }, [])

  async function toggleDay(date) {
    if (expanded === date) { setExpanded(null); return }
    const jobs = await window.api.getApplications({ dateFrom: date + ' 00:00:00', dateTo: date + ' 23:59:59' })
    setDayJobs(jobs)
    setExpanded(date)
  }

  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a))

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 24 }}>Timeline</h1>
      {dates.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>No applications yet.</div>
      ) : dates.map(date => {
        const platforms = byDate[date]
        const total = platforms.reduce((s, p) => s + p.count, 0)
        const isOpen = expanded === date
        return (
          <div key={date} className="card" style={{ marginBottom: 12, cursor: 'pointer' }} onClick={() => toggleDay(date)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  {new Date(date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {platforms.map(p => (
                    <span key={p.platform} className={`badge ${PLATFORM_COLORS[p.platform] || 'badge-blue'}`}>
                      {p.platform} &times;{p.count}
                    </span>
                  ))}
                </div>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{total} application{total !== 1 ? 's' : ''} {isOpen ? '▲' : '▼'}</span>
            </div>
            {isOpen && dayJobs.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }} onClick={e => e.stopPropagation()}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Role</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Company</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Match</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayJobs.map(j => (
                      <tr key={j.id}>
                        <td style={{ padding: '6px 8px', fontSize: 13 }}>{j.job_title}</td>
                        <td style={{ padding: '6px 8px', fontSize: 13, color: 'var(--text-muted)' }}>{j.company}</td>
                        <td style={{ padding: '6px 8px', fontSize: 13, color: j.match_score >= 80 ? 'var(--green)' : 'var(--yellow)' }}>{j.match_score}%</td>
                        <td style={{ padding: '6px 8px', fontSize: 12 }}><span className="badge badge-blue">{j.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
