import { useState, useEffect } from 'react'

const PLATFORM_COLORS = { Seek: 'badge-blue', LinkedIn: 'badge-green', Indeed: 'badge-yellow' }
const STATUS_BADGE = {
  applied: { label: 'Applied', color: 'badge-blue' },
  interview: { label: 'Interview', color: 'badge-green' },
  offer: { label: 'Offer', color: 'badge-green' },
  rejected: { label: 'Rejected', color: 'badge-red' },
  pending: { label: 'Pending', color: 'badge-yellow' },
  no_response: { label: 'No Response', color: 'badge-gray' },
  skipped: { label: 'Skipped', color: 'badge-gray' },
}

function relativeDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  const now = new Date()
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
}

export default function Timeline({ active }) {
  const [byDate, setByDate] = useState({})
  const [expanded, setExpanded] = useState(null)
  const [dayJobs, setDayJobs] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [expandAll, setExpandAll] = useState(false)
  const [expandedJobs, setExpandedJobs] = useState({})

  // Reloads every time the page is shown, not once on mount. Pages stay mounted
  // here, so mounting happens once at startup — this page used to show the
  // application history as it stood when the app launched, and a scan that ran
  // an hour later simply did not appear on the timeline of that day.
  useEffect(() => {
    if (active === false) return
    window.api.getApplicationsByDate().then(rows => {
      const grouped = {}
      rows.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = []
        grouped[r.date].push({ platform: r.platform, count: r.count })
      })
      setByDate(grouped)
    })
  }, [active])

  async function toggleDay(date) {
    if (expandAll) {
      // In expand-all mode, toggle individual dates
      if (expandedJobs[date]) {
        setExpandedJobs(prev => { const next = { ...prev }; delete next[date]; return next })
        return
      }
    } else {
      if (expanded === date) { setExpanded(null); return }
    }
    // `date` is a LOCAL calendar day, but applied_at is stored in UTC — convert
    // the local-midnight boundaries to UTC before querying.
    const start = new Date(date + 'T00:00:00')
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ')
    const jobs = await window.api.getApplications({
      dateFrom: fmt(start),
      dateTo: fmt(new Date(start.getTime() + 86400000 - 1000)),
    })
    if (expandAll) {
      setExpandedJobs(prev => ({ ...prev, [date]: jobs }))
    } else {
      setDayJobs(jobs)
      setExpanded(date)
    }
  }

  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a))

  const allPlatforms = [...new Set(Object.values(byDate).flatMap(ps => ps.map(p => p.platform)))].sort()

  const filteredDates = dates.filter(date => {
    const platforms = byDate[date]
    if (platformFilter && !platforms.some(p => p.platform === platformFilter)) return false
    if (searchQuery) {
      // Match what the user actually SEES ("Today", "Wed, 16 July 2026"), not
      // just the raw ISO key — typing "july" previously found nothing.
      const q = searchQuery.toLowerCase()
      return date.includes(q) ||
        relativeDate(date).toLowerCase().includes(q) ||
        platforms.some(p => p.platform.toLowerCase().includes(q))
    }
    return true
  })

  // Summary stats
  const totalDays = dates.length
  const totalApps = Object.values(byDate).reduce((sum, platforms) => sum + platforms.reduce((s, p) => s + p.count, 0), 0)
  const avgPerDay = totalDays > 0 ? Math.round(totalApps / totalDays) : 0

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Timeline</h1>
          {totalDays > 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
              {totalApps} applications across {totalDays} day{totalDays !== 1 ? 's' : ''} · ~{avgPerDay}/day avg
            </p>
          )}
        </div>
        {dates.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Filter by date..."
              style={{ width: 180, padding: '6px 10px', fontSize: 12 }}
            />
            {allPlatforms.length > 1 && (
              <select value={platformFilter} onChange={e => setPlatformFilter(e.target.value)} style={{ width: 180, padding: '6px 10px', fontSize: 12 }}>
                <option value="">All Platforms</option>
                {allPlatforms.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            <button className="btn btn-ghost" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={async () => {
              if (expandAll) {
                setExpandAll(false)
                setExpandedJobs({})
              } else {
                setExpandAll(true)
                const results = await Promise.all(
                  filteredDates.map(date =>
                    window.api.getApplications({ dateFrom: date + ' 00:00:00', dateTo: date + ' 23:59:59' }).then(jobs => [date, jobs])
                  )
                )
                setExpandedJobs(Object.fromEntries(results))
              }
            }}>
              {expandAll ? 'Collapse All' : 'Expand All'}
            </button>
          </div>
        )}
      </div>

      {filteredDates.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-icon" aria-hidden="true">◷</div>
          {dates.length === 0 ? (
            <>
              <div className="empty-title">No applications yet</div>
              <div className="empty-hint">Once a scan submits its first application, every day of activity shows up here.</div>
            </>
          ) : (
            <>
              <div className="empty-title">No matching days</div>
              <div className="empty-hint">Nothing matches the current date filter or platform.</div>
            </>
          )}
        </div>
      ) : (
        <div style={{ position: 'relative', paddingLeft: 24 }}>
          {/* Timeline line */}
          <div style={{
            position: 'absolute', left: 11, top: 0, bottom: 0,
            width: 2, background: 'var(--border)',
          }} />

          {filteredDates.map(date => {
            const platforms = byDate[date]
            const total = platforms.reduce((s, p) => s + p.count, 0)
            const isOpen = expandAll ? !!expandedJobs[date] : expanded === date
            const currentJobs = expandAll ? (expandedJobs[date] || []) : dayJobs
            return (
              <div key={date} style={{ position: 'relative', marginBottom: 12 }}>
                {/* Timeline dot */}
                <div style={{
                  position: 'absolute', left: -18, top: 22,
                  width: 10, height: 10, borderRadius: '50%',
                  background: isOpen ? 'var(--accent)' : 'var(--border)',
                  border: '2px solid var(--surface)',
                  transition: 'background 0.15s',
                }} />

                <div
                  className="card card-interactive"
                  // A bare clickable div was unreachable by keyboard — the only
                  // way to expand a day was with a mouse.
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => toggleDay(date)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(date) }
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{relativeDate(date)}</span>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {/* System locale, not a hardcoded en-AU — every other
                              date in the app already follows the OS setting. */}
                          {new Date(date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {platforms.map(p => (
                          <span key={p.platform} className={`badge ${PLATFORM_COLORS[p.platform] || 'badge-blue'}`}>
                            {p.platform} ×{p.count}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{total} application{total !== 1 ? 's' : ''} {isOpen ? '▲' : '▼'}</span>
                  </div>
                  {isOpen && currentJobs.length > 0 && (
                    <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }} onClick={e => e.stopPropagation()}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Role</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Company</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Platform</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Match</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Status</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentJobs.map(j => (
                            <tr key={j.id}>
                              <td style={{ padding: '6px 8px', fontSize: 13, fontWeight: 500 }}>{j.job_title}</td>
                              <td style={{ padding: '6px 8px', fontSize: 13, color: 'var(--text-muted)' }}>{j.company}</td>
                              <td style={{ padding: '6px 8px', fontSize: 12 }}>
                                <span className={`badge ${PLATFORM_COLORS[j.platform] || 'badge-blue'}`}>{j.platform}</span>
                              </td>
                              <td style={{ padding: '6px 8px', fontSize: 13, color: j.match_score >= 80 ? 'var(--green)' : j.match_score >= 60 ? 'var(--yellow)' : 'var(--text-muted)', fontWeight: 600 }}>{j.match_score}%</td>
                              <td style={{ padding: '6px 8px', fontSize: 12 }}>
                                <span className={`badge ${STATUS_BADGE[j.status]?.color || 'badge-gray'}`}>
                                  {STATUS_BADGE[j.status]?.label || j.status}
                                </span>
                              </td>
                              <td style={{ padding: '6px 8px' }}>
                                {j.job_url && (
                                  <a href={j.job_url} target="_blank" rel="noreferrer"
                                    style={{ color: 'var(--accent)', fontSize: 11, textDecoration: 'none' }}>
                                    View →
                                  </a>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
