import { useState, useEffect } from 'react'

const PLATFORM_COLORS = { Seek: 'var(--accent)', LinkedIn: 'var(--green)', Indeed: 'var(--yellow)' }
const STATUS_COLORS = {
  applied: 'var(--accent)', interview: 'var(--green)', offer: 'var(--green)',
  rejected: 'var(--red)', pending: 'var(--yellow)', skipped: 'var(--text-muted)',
}

function BarChart({ data }) {
  if (!data || data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data</div>
  const max = Math.max(...data.map(d => d.count), 1)
  const chartH = 140
  const barW = Math.max(Math.floor(400 / data.length) - 6, 12)

  return (
    <svg width="100%" height={chartH + 40} viewBox={`0 0 ${data.length * (barW + 6)} ${chartH + 40}`} preserveAspectRatio="xMidYMax meet">
      {data.map((d, i) => {
        const h = Math.max((d.count / max) * chartH, 2)
        const x = i * (barW + 6)
        const y = chartH - h
        const label = new Date(d.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short' })
        return (
          <g key={d.date}>
            <rect x={x} y={y} width={barW} height={h} fill="var(--accent)" rx={3} opacity={0.85} />
            {d.count > 0 && <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)" fontWeight="600">{d.count}</text>}
            <text x={x + barW / 2} y={chartH + 16} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{label}</text>
          </g>
        )
      })}
    </svg>
  )
}

function PieChart({ data, colorMap }) {
  if (!data || data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data</div>
  const total = data.reduce((s, d) => s + d.count, 0)
  if (total === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data</div>

  let angle = -Math.PI / 2
  const cx = 90, cy = 90, r = 70, innerR = 40

  return (
    <svg width={180} height={180}>
      {data.map((d) => {
        // Cap just under a full circle — an arc whose start and end coincide renders nothing
        const slice = Math.min((d.count / total) * 2 * Math.PI, 2 * Math.PI - 0.001)
        const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle)
        const x2 = cx + r * Math.cos(angle + slice), y2 = cy + r * Math.sin(angle + slice)
        const xi1 = cx + innerR * Math.cos(angle), yi1 = cy + innerR * Math.sin(angle)
        const xi2 = cx + innerR * Math.cos(angle + slice), yi2 = cy + innerR * Math.sin(angle + slice)
        const largeArc = slice > Math.PI ? 1 : 0
        const path = `M ${xi1} ${yi1} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${innerR} ${innerR} 0 ${largeArc} 0 ${xi1} ${yi1}`
        const key = d.platform || d.status
        const color = (colorMap || PLATFORM_COLORS)[key] || 'var(--text-muted)'
        angle += slice
        return <path key={key} d={path} fill={color} opacity={0.85} />
      })}
      <text x={cx} y={cy - 4} textAnchor="middle" fill="var(--text)" fontSize={18} fontWeight="700">{total}</text>
      <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--text-muted)" fontSize={9}>total</text>
    </svg>
  )
}

// Distribution of AI match scores across every scanned job, with the
// apply-threshold marked — shows at a glance whether the threshold is letting
// through too much or starving the auto-apply.
function ScoreHistogram({ apps, threshold }) {
  const scored = apps.filter(a => a.match_score != null)
  if (scored.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No scored jobs yet — run a scan (or a Test Scan) first.</div>

  const buckets = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i === 9 ? 100 : i * 10 + 9, count: 0 }))
  for (const a of scored) {
    const s = Math.max(0, Math.min(100, a.match_score))
    buckets[Math.min(9, Math.floor(s / 10))].count++
  }
  const max = Math.max(...buckets.map(b => b.count), 1)
  const chartH = 120, barW = 34, gap = 8
  const width = 10 * (barW + gap) - gap
  const thrX = Math.min((threshold / 100) * width, width)

  return (
    <svg width="100%" height={chartH + 36} viewBox={`0 0 ${width} ${chartH + 36}`} preserveAspectRatio="xMidYMax meet">
      {buckets.map((b, i) => {
        const h = b.count === 0 ? 2 : Math.max((b.count / max) * chartH, 3)
        const x = i * (barW + gap)
        const y = chartH - h
        const applies = b.hi >= threshold // bucket (partially) clears the threshold
        return (
          <g key={b.lo}>
            <rect x={x} y={y} width={barW} height={h} rx={3}
              fill={applies ? 'var(--green)' : 'var(--text-muted)'} opacity={applies ? 0.85 : 0.35} />
            {b.count > 0 && <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize={10} fill="var(--text-muted)" fontWeight="600">{b.count}</text>}
            <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{b.lo}–{b.hi}</text>
          </g>
        )
      })}
      <line x1={thrX} y1={-2} x2={thrX} y2={chartH} stroke="var(--red)" strokeWidth={1.5} strokeDasharray="4 3" />
      <text x={Math.min(thrX + 4, width - 70)} y={10} fontSize={9} fill="var(--red)" fontWeight="600">threshold {threshold}%</text>
    </svg>
  )
}

function FunnelBar({ label, count, total, color }) {
  const pct = total > 0 ? (count / total) * 100 : 0
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{label}</span>
        <span style={{ color: 'var(--text-muted)' }}>{count} ({pct.toFixed(1)}%)</span>
      </div>
      <div style={{ height: 8, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  )
}

export default function Analytics() {
  const [stats, setStats] = useState(null)
  const [perDay, setPerDay] = useState([])
  const [allApps, setAllApps] = useState([])
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState(null)
  const [timeRange, setTimeRange] = useState(7)
  const [matchThreshold, setMatchThreshold] = useState(80)
  const [advice, setAdvice] = useState(null)
  const [applyingAdvice, setApplyingAdvice] = useState(false)

  useEffect(() => {
    Promise.all([
      window.api.getStats(),
      window.api.getApplicationsPerDay(timeRange),
      window.api.getApplications({}),
    ]).then(([s, d, a]) => {
      setStats(s)
      setPerDay(d)
      setAllApps(a)
    })
  }, [timeRange])

  useEffect(() => {
    window.api.getConfig().then(c => setMatchThreshold(c.matchThreshold ?? 80))
    // Recommendation derived from the last Test Scan, if one has run this session.
    window.api.getThresholdAdvice?.().then(a => setAdvice(a?.available ? a : null)).catch(() => {})
  }, [])

  async function applyRecommended() {
    if (!advice) return
    setApplyingAdvice(true)
    try {
      const cfg = await window.api.getConfig()
      await window.api.saveConfig({ ...cfg, matchThreshold: advice.recommended })
      setMatchThreshold(advice.recommended)
    } finally {
      setApplyingAdvice(false)
    }
  }

  if (!stats) return <div style={{ color: 'var(--text-muted)' }}>Loading...</div>

  const byPlatform = stats.byPlatform || []
  const byStatus = stats.byStatus || []
  const responseRate = stats.responseRate ?? 0
  const mostActive = byPlatform.reduce((a, b) => b.count > (a?.count || 0) ? b : a, null)

  // Computed metrics
  const avgMatch = allApps.length > 0
    ? Math.round(allApps.reduce((sum, a) => sum + (a.match_score || 0), 0) / allApps.length)
    : 0

  const submittedCount = allApps.filter(a => a.status !== 'skipped').length
  const interviewCount = allApps.filter(a => a.status === 'interview').length
  const offerCount = allApps.filter(a => a.status === 'offer').length
  const rejectedCount = allApps.filter(a => a.status === 'rejected').length
  const pendingCount = allApps.filter(a => a.status === 'pending' || a.status === 'applied').length
  const skippedCount = allApps.filter(a => a.status === 'skipped').length

  // Week-over-week trend
  const thisWeek = allApps.filter(a => {
    const d = new Date(a.applied_at)
    return d >= new Date(Date.now() - 7 * 86400000)
  }).length
  const lastWeek = allApps.filter(a => {
    const d = new Date(a.applied_at)
    return d >= new Date(Date.now() - 14 * 86400000) && d < new Date(Date.now() - 7 * 86400000)
  }).length
  const weekTrend = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : (thisWeek > 0 ? 100 : 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 0 }}>Analytics</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {exportMsg && <span style={{ fontSize: 12, color: exportMsg.type === 'success' ? 'var(--green)' : 'var(--red)' }}>{exportMsg.text}</span>}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={exporting} onClick={async () => {
            setExporting(true); setExportMsg(null)
            try {
              const res = await window.api.exportAnalyticsPDF()
              if (res.success) { setExportMsg({ type: 'success', text: '✓ PDF saved' }); setTimeout(() => setExportMsg(null), 3000) }
              else if (res.reason !== 'cancelled') setExportMsg({ type: 'error', text: res.error || 'Export failed' })
            } catch (err) { setExportMsg({ type: 'error', text: err.message }) }
            setExporting(false)
          }}>
            {exporting ? 'Exporting...' : 'Export PDF'}
          </button>
        </div>
      </div>

      {/* Key metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Response Rate', value: `${responseRate}%`, sub: `${interviewCount} interviews` },
          { label: 'Avg Match Score', value: `${avgMatch}%`, sub: `across ${allApps.length} jobs` },
          { label: 'Most Active', value: mostActive?.platform || '—', sub: mostActive ? `${mostActive.count} applications` : '' },
          {
            label: 'Weekly Trend',
            value: `${weekTrend >= 0 ? '+' : ''}${weekTrend}%`,
            sub: `${thisWeek} this week vs ${lastWeek} last week`,
            color: weekTrend > 0 ? 'var(--green)' : weekTrend < 0 ? 'var(--red)' : 'var(--text)',
          },
        ].map(s => (
          <div key={s.label} className="card stat-card">
            <div className="stat-value" style={{ fontSize: 24, color: s.color || 'var(--text)' }}>{s.value}</div>
            <div className="stat-label">{s.label}</div>
            {s.sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Applications — Last {timeRange} Days</span>
            <select value={timeRange} onChange={e => setTimeRange(Number(e.target.value))} style={{ width: 'auto', fontSize: 12, padding: '4px 8px' }}>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
          <BarChart data={perDay} />
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>By Platform</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <PieChart data={byPlatform} colorMap={PLATFORM_COLORS} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {byPlatform.map(p => (
                <div key={p.platform} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: PLATFORM_COLORS[p.platform] || 'var(--text-muted)', flexShrink: 0 }} />
                  {p.platform}: <span style={{ fontWeight: 600 }}>{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Match score distribution vs apply threshold */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Match Score Distribution</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            green buckets clear your {matchThreshold}% threshold — tune it in Settings, test with Test Scan
          </span>
        </div>
        <ScoreHistogram apps={allApps} threshold={matchThreshold} />

        {/* Threshold recommendation from the last Test Scan. The histogram above
            is drawn from saved applications, which are already filtered by the
            current threshold — a dry run is the only unbiased sample of what
            the scrapers actually find. */}
        {advice && (
          <div style={{
            marginTop: 16, padding: '14px 16px', borderRadius: 8,
            background: 'var(--surface2)', borderLeft: '3px solid var(--accent)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                  Threshold suggestion — from your last Test Scan
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Scored {advice.total} job{advice.total === 1 ? '' : 's'} (median {advice.median}%, best {advice.max}%).
                  At your current {advice.currentThreshold}% threshold, {advice.wouldApply} would have been applied to.
                </div>
              </div>
              {advice.recommended !== matchThreshold && (
                <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px', flexShrink: 0 }}
                  onClick={applyRecommended} disabled={applyingAdvice}>
                  {applyingAdvice ? 'Saving...' : `Use ${advice.recommended}%`}
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              {advice.curve.map(c => (
                <div key={c.threshold} style={{
                  fontSize: 11, padding: '4px 8px', borderRadius: 6,
                  background: c.threshold === advice.recommended ? 'var(--accent)' : 'var(--surface)',
                  color: c.threshold === advice.recommended ? '#fff' : 'var(--text-muted)',
                  border: c.threshold === matchThreshold ? '1px solid var(--text-muted)' : '1px solid transparent',
                  fontWeight: c.threshold === advice.recommended ? 600 : 400,
                }}>
                  {c.threshold}% → {c.count} job{c.count === 1 ? '' : 's'}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Funnel + Status breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>Application Funnel</div>
          <FunnelBar label="Submitted" count={submittedCount} total={allApps.length} color="var(--accent)" />
          <FunnelBar label="Awaiting Response" count={pendingCount} total={allApps.length} color="var(--yellow)" />
          <FunnelBar label="Got Interview" count={interviewCount} total={allApps.length} color="var(--green)" />
          <FunnelBar label="Got Offer" count={offerCount} total={allApps.length} color="var(--green)" />
          <FunnelBar label="Rejected" count={rejectedCount} total={allApps.length} color="var(--red)" />
          <FunnelBar label="Skipped" count={skippedCount} total={allApps.length} color="var(--text-muted)" />
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>By Status</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <PieChart data={byStatus.map(s => ({ ...s, platform: undefined }))} colorMap={STATUS_COLORS} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {byStatus.map(s => (
                <div key={s.status} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: STATUS_COLORS[s.status] || 'var(--text-muted)', flexShrink: 0 }} />
                  <span style={{ textTransform: 'capitalize' }}>{s.status}:</span>
                  <span style={{ fontWeight: 600 }}>{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
