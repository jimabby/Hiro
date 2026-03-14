import { useState, useEffect } from 'react'

const PLATFORM_COLORS = { Seek: 'var(--accent)', LinkedIn: 'var(--green)', Indeed: 'var(--yellow)' }

function BarChart({ data }) {
  if (!data || data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data</div>
  const max = Math.max(...data.map(d => d.count), 1)
  const chartH = 140
  const barW = Math.floor(100 / data.length) - 2

  return (
    <svg width="100%" height={chartH + 40} viewBox={`0 0 ${data.length * (barW + 4)} ${chartH + 40}`} preserveAspectRatio="none">
      {data.map((d, i) => {
        const h = Math.max((d.count / max) * chartH, 2)
        const x = i * (barW + 4)
        const y = chartH - h
        const label = new Date(d.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short' })
        return (
          <g key={d.date}>
            <rect x={x} y={y} width={barW} height={h} fill="var(--accent)" rx={2} />
            {d.count > 0 && <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{d.count}</text>}
            <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" fontSize={8} fill="var(--text-muted)">{label}</text>
          </g>
        )
      })}
    </svg>
  )
}

function PieChart({ data }) {
  if (!data || data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data</div>
  const total = data.reduce((s, d) => s + d.count, 0)
  if (total === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data</div>

  let angle = -Math.PI / 2
  const cx = 90, cy = 90, r = 70, innerR = 40

  return (
    <svg width={180} height={180}>
      {data.map((d, i) => {
        const slice = (d.count / total) * 2 * Math.PI
        const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle)
        const x2 = cx + r * Math.cos(angle + slice), y2 = cy + r * Math.sin(angle + slice)
        const xi1 = cx + innerR * Math.cos(angle), yi1 = cy + innerR * Math.sin(angle)
        const xi2 = cx + innerR * Math.cos(angle + slice), yi2 = cy + innerR * Math.sin(angle + slice)
        const largeArc = slice > Math.PI ? 1 : 0
        const path = `M ${xi1} ${yi1} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${innerR} ${innerR} 0 ${largeArc} 0 ${xi1} ${yi1}`
        const color = PLATFORM_COLORS[d.platform] || 'var(--text-muted)'
        angle += slice
        return <path key={d.platform} d={path} fill={color} opacity={0.85} />
      })}
    </svg>
  )
}

export default function Analytics() {
  const [stats, setStats] = useState(null)
  const [perDay, setPerDay] = useState([])

  useEffect(() => {
    Promise.all([
      window.api.getStats(),
      window.api.getApplicationsPerDay(7),
    ]).then(([s, d]) => {
      setStats(s)
      setPerDay(d)
    })
  }, [])

  if (!stats) return <div style={{ color: 'var(--text-muted)' }}>Loading...</div>

  const byPlatform = stats.byPlatform || []
  const byStatus = stats.byStatus || []
  const responseRate = stats.responseRate ?? 0
  const mostActive = byPlatform.reduce((a, b) => b.count > (a?.count || 0) ? b : a, null)

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 24 }}>Analytics</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Response Rate', value: `${responseRate}%` },
          { label: 'Total Interviews', value: stats.interviews },
          { label: 'Most Active Platform', value: mostActive?.platform || '—' },
        ].map(s => (
          <div key={s.label} className="card stat-card">
            <div className="stat-value" style={{ fontSize: 24 }}>{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>Applications — Last 7 Days</div>
          <BarChart data={perDay} />
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>By Platform</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <PieChart data={byPlatform} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {byPlatform.map(p => (
                <div key={p.platform} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: PLATFORM_COLORS[p.platform] || 'var(--text-muted)', flexShrink: 0 }} />
                  {p.platform}: {p.count}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>By Status</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {byStatus.map(s => (
            <div key={s.status} style={{ textAlign: 'center', minWidth: 80 }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{s.count}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{s.status}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
