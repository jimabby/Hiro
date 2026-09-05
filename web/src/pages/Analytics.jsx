import { useState, useEffect } from 'react'

const PLATFORM_COLORS = { Seek: 'var(--accent)', LinkedIn: 'var(--green)', Indeed: 'var(--yellow)' }
const STATUS_COLORS = {
  applied: 'var(--accent)', interview: 'var(--green)', offer: 'var(--green)',
  rejected: 'var(--red)', pending: 'var(--yellow)', skipped: 'var(--text-muted)',
  no_response: 'var(--border)',
}

// Compact annual figure. Salaries are whole thousands often enough that "$120k"
// reads better than "$120,000", but an odd figure shouldn't be rounded away.
function formatMoney(n) {
  if (n == null) return '—'
  if (n % 1000 === 0) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString()}`
}

// ─── The frame every chart sits in ───────────────────────────────────────
//
// An SVG is a picture. To a screen reader these four charts were nothing at
// all — no name, no description, no content — so the Analytics page, which is
// almost entirely charts, read as a page of empty boxes. That is the whole
// value of the page being inaccessible, not a rough edge on it.
//
// The fix is the same one that solves a second problem: put the numbers behind
// every chart one click away, as a real table. It gives assistive technology
// something to read, it lets anyone check a bar they are unsure of, and it makes
// the data exportable — which is the third thing people wanted from this page
// and could only get by re-deriving it from the CSV of applications.
//
// So: the SVG is labelled and marked as an image, the table is the accessible
// alternative, and both are fed from one `rows` prop so they can never disagree.

// RFC 4180 quoting, and the leading-character neutralisation the applications
// export already does. A company called "=cmd|' /c calc'!A1" is a formula the
// moment a spreadsheet opens the file, and analytics rows carry company names.
function csvCell(value) {
  const text = value == null ? '' : String(value)
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${guarded.replace(/"/g, '""')}"`
}

function toCsv(columns, rows) {
  const header = columns.map(c => csvCell(c.label)).join(',')
  const body = rows.map(r => columns.map(c => csvCell(r[c.key])).join(',')).join('\n')
  return `${header}\n${body}\n`
}

function downloadCsv(filename, columns, rows) {
  const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoked on the next tick rather than immediately: some browsers have not
  // finished reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ChartFrame({ title, summary, columns, rows, filename, children }) {
  const [showTable, setShowTable] = useState(false)
  const tableId = `chart-table-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const hasRows = Array.isArray(rows) && rows.length > 0

  return (
    <figure style={{ margin: 0 }}>
      {/* role="img" plus a label is what turns an anonymous SVG into something
          a screen reader can announce. aria-describedby points at the table when
          it is open, so the detail is reachable rather than merely present. */}
      <div role="img" aria-label={summary} aria-describedby={showTable ? tableId : undefined}>
        {children}
      </div>

      {hasRows && (
        <figcaption style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '3px 8px' }}
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable(v => !v)}
          >
            {showTable ? 'Hide data' : 'Show data'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '3px 8px' }}
            onClick={() => downloadCsv(filename, columns, rows)}
          >
            Export CSV
          </button>
        </figcaption>
      )}

      {/* Rendered but hidden rather than unmounted, so the aria-describedby
          above always resolves and the table is in the accessibility tree in the
          same order it appears visually. */}
      <div id={tableId} hidden={!showTable} style={{ marginTop: 10, overflowX: 'auto' }}>
        {hasRows && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <caption style={{ captionSide: 'top', textAlign: 'left', color: 'var(--text-muted)', paddingBottom: 6 }}>
              {title}
            </caption>
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c.key} scope="col" style={{
                    textAlign: c.numeric ? 'right' : 'left',
                    padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 600,
                  }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r[columns[0].key] ?? i}>
                  {columns.map((c, ci) => {
                    const Cell = ci === 0 ? 'th' : 'td'
                    return (
                      <Cell
                        key={c.key}
                        {...(ci === 0 ? { scope: 'row' } : {})}
                        style={{
                          textAlign: c.numeric ? 'right' : 'left',
                          padding: '4px 8px', borderBottom: '1px solid var(--border)',
                          fontWeight: ci === 0 ? 500 : 400,
                        }}
                      >{r[c.key] == null ? '—' : String(r[c.key])}</Cell>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </figure>
  )
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
  // Bar geometry is in viewBox units, and `meet` scales the whole drawing to
  // fit the SVG box while preserving its aspect ratio. At barW 34 the drawing
  // was 412 units wide against a card of roughly 1150px, so the histogram was
  // scaled down to about a third of the space it was given and floated in the
  // middle of an otherwise empty card. Sizing the drawing near the width it
  // will actually occupy lets it fill the card — and keeps the labels at their
  // intended size instead of shrinking them along with everything else.
  const chartH = 120, barW = 92, gap = 16
  const width = 10 * (barW + gap) - gap
  const thrX = Math.min((threshold / 100) * width, width)
  // Headroom above the plot, because the count sits ABOVE its bar at y - 5 and
  // the tallest bar is exactly chartH high — so its label landed at y = -5,
  // outside the viewBox, and was clipped. That silently blanked the label on the
  // one bar that most needs it: the tallest bar is the mode of the distribution
  // here and the best-converting band in the chart below, and it was the only
  // bar in either with no number on it.
  const topPad = 14

  return (
    <svg width="100%" height={chartH + 36 + topPad} viewBox={`0 ${-topPad} ${width} ${chartH + 36 + topPad}`} preserveAspectRatio="xMidYMax meet">
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

// How often each match-score band actually converted to an interview or offer.
// The histogram above shows how many jobs landed in each band; this shows
// whether that band was worth applying to — which is what the threshold should
// really be tuned against. Bands with too few applications to mean anything are
// greyed out rather than shown as a confident 0% or 100%.
const MIN_SAMPLE = 3

function ConversionChart({ bands, threshold }) {
  const withData = (bands || []).filter(b => b.applied > 0)
  if (withData.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        No submitted applications yet — conversion appears once replies start coming in.
      </div>
    )
  }

  // Bar geometry is in viewBox units, and `meet` scales the whole drawing to
  // fit the SVG box while preserving its aspect ratio. At barW 34 the drawing
  // was 412 units wide against a card of roughly 1150px, so the histogram was
  // scaled down to about a third of the space it was given and floated in the
  // middle of an otherwise empty card. Sizing the drawing near the width it
  // will actually occupy lets it fill the card — and keeps the labels at their
  // intended size instead of shrinking them along with everything else.
  const chartH = 120, barW = 92, gap = 16
  const width = 10 * (barW + gap) - gap
  const thrX = Math.min((threshold / 100) * width, width)
  // Headroom above the plot, because the count sits ABOVE its bar at y - 5 and
  // the tallest bar is exactly chartH high — so its label landed at y = -5,
  // outside the viewBox, and was clipped. That silently blanked the label on the
  // one bar that most needs it: the tallest bar is the mode of the distribution
  // here and the best-converting band in the chart below, and it was the only
  // bar in either with no number on it.
  const topPad = 14
  const maxRate = Math.max(...withData.map(b => b.conversionRate || 0), 1)

  return (
    <svg width="100%" height={chartH + 36 + topPad} viewBox={`0 ${-topPad} ${width} ${chartH + 36 + topPad}`} preserveAspectRatio="xMidYMax meet">
      {bands.map((b, i) => {
        const x = i * (barW + gap)
        const reliable = b.applied >= MIN_SAMPLE
        const rate = b.conversionRate ?? 0
        const h = b.applied === 0 ? 2 : Math.max((rate / maxRate) * chartH, 3)
        const y = chartH - h
        return (
          <g key={b.lo}>
            <title>
              {`${b.lo}–${b.hi}%: ${b.converted}/${b.applied} converted`}
              {reliable ? '' : ' (too few to be meaningful)'}
            </title>
            <rect x={x} y={y} width={barW} height={h} rx={3}
              fill={reliable ? 'var(--green)' : 'var(--text-muted)'}
              opacity={b.applied === 0 ? 0.2 : reliable ? 0.85 : 0.35} />
            {b.applied > 0 && (
              <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize={10}
                fill="var(--text-muted)" fontWeight="600">{rate}%</text>
            )}
            <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{b.lo}–{b.hi}</text>
            {b.applied > 0 && (
              <text x={x + barW / 2} y={chartH + 25} textAnchor="middle" fontSize={8} fill="var(--text-muted)" opacity={0.7}>
                n={b.applied}
              </text>
            )}
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

// Two-tone bar: how a segment's rejections split between "screened out" and
// "rejected after interviewing". The split is the whole point, so it is drawn
// as one bar rather than two numbers — the proportion is what reads.
function StageBar({ label, pre, post, max, sublabel }) {
  const total = pre + post
  const width = max > 0 ? (total / max) * 100 : 0
  const preShare = total > 0 ? (pre / total) * 100 : 0

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: 'var(--text)' }}>
          {label}
          {sublabel && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{sublabel}</span>}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{total}</span>
      </div>
      <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden', width: `${Math.max(width, 2)}%`, display: 'flex' }}>
        <div style={{ width: `${preShare}%`, background: 'var(--yellow)' }} title={`${pre} screened out`} />
        <div style={{ flex: 1, background: 'var(--red)' }} title={`${post} after interview`} />
      </div>
    </div>
  )
}

// Where applications die. The number of rejections is not actionable; the stage
// they happen at is, because screening losses and interview losses have
// completely different fixes.
function RejectionPanel({ data }) {
  if (!data) return null

  if (data.total === 0) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Where applications end</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No rejections recorded yet. Once employers start replying, this shows whether applications
          are being screened out or lost after interviewing — which point at different fixes.
        </div>
      </div>
    )
  }

  const staged = data.preInterview + data.postInterview
  const postShare = staged > 0 ? Math.round((data.postInterview / staged) * 100) : 0
  // Read through defaults, like `(experiment.arms || [])` below. The guards
  // above establish that `data` exists and has rejections in it; they say
  // nothing about these two fields, and a payload missing either used to throw
  // out of render — which, before this app had an error boundary, took the
  // whole window down rather than this one panel.
  const byResume = data.byResume || []
  const byBand = data.byBand || []
  const maxResume = Math.max(...byResume.map(r => r.total), 1)
  const maxBand = Math.max(...byBand.map(b => b.total), 1)

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Where applications end</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{data.total} rejection{data.total === 1 ? '' : 's'}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Screening losses point at the resume and targeting. Losses after an interview point somewhere else entirely.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
        <div style={{ padding: 12, background: 'var(--bg)', borderRadius: 6, borderLeft: '3px solid var(--yellow)' }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.preInterview}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>screened out — never interviewed</div>
        </div>
        <div style={{ padding: 12, background: 'var(--bg)', borderRadius: 6, borderLeft: '3px solid var(--red)' }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.postInterview}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>after interviewing ({postShare}%)</div>
        </div>
      </div>

      {data.medianDaysToRejection != null && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Median {data.medianDaysToRejection} day{data.medianDaysToRejection === 1 ? '' : 's'} from submission to rejection.
        </div>
      )}

      {byResume.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>By resume</div>
          {byResume.slice(0, 6).map(r => (
            <StageBar key={r.resume} label={r.resume} pre={r.preInterview} post={r.postInterview} max={maxResume} />
          ))}
        </div>
      )}

      {byBand.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>By match score</div>
          {byBand.slice(0, 6).map(b => (
            <StageBar key={b.band} label={b.band} pre={b.preInterview} post={b.postInterview} max={maxBand} />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--yellow)', borderRadius: 2, marginRight: 5 }} />screened out</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', borderRadius: 2, marginRight: 5 }} />after interview</span>
      </div>

      {(data.insights || []).map((i, n) => (
        <div key={n} style={{ padding: 10, background: 'var(--bg)', borderRadius: 6, marginTop: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{i.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{i.detail}</div>
        </div>
      ))}
    </div>
  )
}

// Which model's documents actually convert. The snapshot diff already showed
// what changed between versions; this is the part that says whether it mattered.
function VersionOutcomesPanel({ data }) {
  if (!data || data.length === 0) return null
  const rated = data.filter(v => v.interviewRate != null)
  const best = rated.length ? [...rated].sort((a, b) => b.interviewRate - a.interviewRate)[0] : null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Which version won</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Interview rate of the documents each model wrote. One application counts once per model,
        however many times it was re-drafted.
      </div>

      {data.map(v => (
        <div key={v.label} style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {v.label}
              {best && v.label === best.label && rated.length > 1 && (
                <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--green)', fontWeight: 700 }}>BEST</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {v.sent} sent · {v.interviews} interview{v.interviews === 1 ? '' : 's'} · {v.offers} offer{v.offers === 1 ? '' : 's'}
              {v.averageScore != null && ` · avg score ${v.averageScore}%`}
            </div>
          </div>
          <div style={{ textAlign: 'right', minWidth: 70 }}>
            {v.interviewRate == null ? (
              // Deliberately not a zero. Below the sample floor there is no rate
              // worth showing, and a "0%" would read as a verdict.
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>too few<br />to judge</div>
            ) : (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green)' }}>{v.interviewRate}%</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>reached interview</div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Analytics({ active }) {
  const [stats, setStats] = useState(null)
  const [resumeConv, setResumeConv] = useState([])
  const [aiUsage, setAiUsage] = useState(null)
  const [perDay, setPerDay] = useState([])
  const [allApps, setAllApps] = useState([])
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState(null)
  const [timeRange, setTimeRange] = useState(7)
  const [matchThreshold, setMatchThreshold] = useState(80)
  const [advice, setAdvice] = useState(null)
  // The outcome-based recommendation. `advice` above comes from the last Test
  // Scan and describes what the scrapers FIND; this describes what has actually
  // been CONVERTING. They answer different questions and can disagree, so both
  // are shown rather than one standing in for the other.
  const [thresholdRec, setThresholdRec] = useState(null)
  const [applyingAdvice, setApplyingAdvice] = useState(false)
  const [bands, setBands] = useState([])
  const [salary, setSalary] = useState(null)
  const [rejection, setRejection] = useState(null)
  const [versions, setVersions] = useState([])
  const [experiment, setExperiment] = useState(null)
  const [ghosts, setGhosts] = useState([])

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

  // Re-read on every visit to the page — spend and conversion move whenever a
  // scan runs, and a stale panel here is a panel nobody trusts.
  useEffect(() => {
    if (active === false) return
    window.api.getScoreBandConversion?.().then(b => setBands(b || [])).catch(() => {})
    window.api.getSalaryStats?.().then(s => setSalary(s || null)).catch(() => {})
    window.api.getResumeConversion?.().then(r => setResumeConv(r || [])).catch(() => {})
    window.api.getAiUsage?.().then(u => setAiUsage(u || null)).catch(() => {})
    window.api.getRejectionAnalysis?.().then(r => setRejection(r || null)).catch(() => {})
    window.api.getVersionOutcomes?.().then(v => setVersions(v || [])).catch(() => {})
    window.api.getResumeExperiment?.().then(e => setExperiment(e || null)).catch(() => {})
    window.api.getGhostJobs?.().then(g => setGhosts(g || [])).catch(() => {})
  }, [active])

  useEffect(() => {
    window.api.getConfig().then(c => setMatchThreshold(c.matchThreshold ?? 80))
    // Recommendation derived from the last Test Scan, if one has run this session.
    window.api.getThresholdAdvice?.().then(a => setAdvice(a?.available ? a : null)).catch(() => {})
    window.api.getThresholdRecommendation?.().then(r => setThresholdRec(r || null)).catch(() => {})
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
  const interviewRate = stats.interviewRate ?? 0
  const mostActive = byPlatform.reduce((a, b) => b.count > (a?.count || 0) ? b : a, null)

  // Computed metrics
  const avgMatch = allApps.length > 0
    ? Math.round(allApps.reduce((sum, a) => sum + (a.match_score || 0), 0) / allApps.length)
    : 0

  // 'held' is drafted-but-not-sent, same as 'skipped' as far as any rate goes.
  const UNSENT = ['skipped', 'held']
  const submittedCount = allApps.filter(a => !UNSENT.includes(a.status)).length
  const interviewCount = allApps.filter(a => a.status === 'interview').length
  const offerCount = allApps.filter(a => a.status === 'offer').length
  const rejectedCount = allApps.filter(a => a.status === 'rejected').length
  const pendingCount = allApps.filter(a => a.status === 'pending' || a.status === 'applied').length
  const skippedCount = allApps.filter(a => a.status === 'skipped').length
  const noResponseCount = allApps.filter(a => a.status === 'no_response').length
  // Any reply at all — matches RESPONDED_STATUSES on the backend.
  const respondedCount = interviewCount + offerCount + rejectedCount
    + allApps.filter(a => a.status === 'pending').length

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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Response Rate', value: `${responseRate}%`, sub: `${respondedCount} replied` },
          { label: 'Interview Rate', value: `${interviewRate}%`, sub: `${interviewCount + offerCount} reached interview` },
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
          <ChartFrame
            title={`Applications, last ${timeRange} days`}
            summary={`Bar chart: applications submitted per day over the last ${timeRange} days. `
              + `${perDay.reduce((n, d) => n + d.count, 0)} in total, `
              + `highest ${Math.max(0, ...perDay.map(d => d.count))} in a day.`}
            columns={[{ key: 'date', label: 'Date' }, { key: 'count', label: 'Applications', numeric: true }]}
            rows={perDay}
            filename={`hiro-applications-per-day-${timeRange}d.csv`}
          >
            <BarChart data={perDay} />
          </ChartFrame>
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>By Platform</div>
          <ChartFrame
            title="Applications by platform"
            summary={`Donut chart: applications by platform. `
              + (byPlatform.length
                ? byPlatform.map(p => `${p.platform} ${p.count}`).join(', ')
                : 'No applications yet.')}
            columns={[{ key: 'platform', label: 'Platform' }, { key: 'count', label: 'Applications', numeric: true }]}
            rows={byPlatform}
            filename="hiro-applications-by-platform.csv"
          >
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
          </ChartFrame>
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
        <ChartFrame
          title="Match score distribution"
          summary={`Histogram: how many scanned jobs fall in each 10-point match-score band, `
            + `with your ${matchThreshold}% apply threshold marked. `
            + `${allApps.filter(a => a.match_score != null).length} scored jobs.`}
          columns={[
            { key: 'band', label: 'Score band' },
            { key: 'count', label: 'Jobs', numeric: true },
            { key: 'clears', label: 'Clears threshold' },
          ]}
          rows={Array.from({ length: 10 }, (_, i) => {
            const lo = i * 10
            const hi = i === 9 ? 100 : i * 10 + 9
            return {
              band: `${lo}–${hi}%`,
              count: allApps.filter(a => a.match_score != null
                && Math.min(100, Math.max(0, a.match_score)) >= lo
                && Math.min(100, Math.max(0, a.match_score)) <= hi).length,
              clears: lo >= matchThreshold ? 'yes' : 'no',
            }
          })}
          filename="hiro-match-score-distribution.csv"
        >
          <ScoreHistogram apps={allApps} threshold={matchThreshold} />
        </ChartFrame>

        {/* What the OUTCOMES say the threshold should be — as opposed to the
            Test Scan panel below, which says what the scrapers are finding.
            Deliberately a recommendation and not a button that moves it: this
            decides which real employers receive real applications, and the
            reasoning belongs in front of the person making that call. */}
        {thresholdRec && (
          <div style={{
            marginTop: 16, padding: '14px 16px', borderRadius: 8,
            background: 'var(--surface2)',
            borderLeft: `3px solid ${thresholdRec.verdict === 'change' ? 'var(--yellow)' : 'var(--border)'}`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
              {thresholdRec.headline}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
              {thresholdRec.detail}
            </div>
            {thresholdRec.verdict === 'change' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Change it yourself in Settings — Hiro will not move it for you.
              </div>
            )}
          </div>
        )}

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
              {(advice.curve || []).map(c => (
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

      {/* Which score bands actually convert */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Interview Rate by Match Score</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            share of submitted applications in each band that reached interview or offer
          </span>
        </div>
        <ConversionChart bands={bands} threshold={matchThreshold} />
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
          The distribution above tells you where your threshold sits; this tells you whether it
          is in the right place. If bands below your threshold convert just as well, the
          threshold is costing you applications — if the bands just above it convert poorly,
          raise it. Greyed bars have fewer than {MIN_SAMPLE} applications and aren't
          meaningful yet.
        </p>
      </div>

      {/* Which resume actually converts. Routing rules send different jobs to
          different resumes; the score histogram can't tell them apart, so
          until now the rules were an untested assumption. */}
      {/* The randomised counterpart to "Which Resume Converts" below.
          That table groups by whichever resume happened to be used, and routing
          rules mean each resume saw a different slice of the market — so a gap
          between two rows can be the jobs rather than the documents. Here the
          jobs are split by hash, so the comparison is like-for-like and a
          surviving difference is caused by the resume. */}
      {experiment?.running && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{experiment.name}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              randomised A/B test{experiment.startedAt ? ` · since ${new Date(experiment.startedAt).toLocaleDateString()}` : ''}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            {(experiment.arms || []).map((arm, i) => {
              const leading = experiment.leader && experiment.leader === arm.resumeId
              return (
                <div key={arm.resumeId || i} style={{
                  border: `1px solid ${leading && experiment.confident ? 'var(--green)' : 'var(--border)'}`,
                  borderRadius: 8, padding: '12px 14px',
                }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                    {i === 0 ? 'A' : 'B'} · {arm.name}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 600 }}>
                    {arm.ratePct == null ? '—' : `${arm.ratePct}%`}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {arm.converted} of {arm.sent} reached interview or offer
                  </div>
                </div>
              )
            })}
          </div>
          <p style={{
            fontSize: 12, marginBottom: 0,
            color: experiment.confident ? 'var(--green)' : 'var(--text-muted)',
          }}>
            {experiment.verdict}
          </p>
        </div>
      )}

      {/* Listings that keep coming back. Each repost carries a new URL, so the
          duplicate check cannot see them and every reappearance costs another
          three model calls — the pattern only exists across scans, which is
          exactly what this database has been quietly recording all along. */}
      {ghosts.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Probably Not Real Vacancies</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              repeatedly reposted listings
            </span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                <th style={{ padding: '4px 8px 8px 0', fontWeight: 500 }}>Role</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500 }}>Company</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Postings</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Over</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Every</th>
                <th style={{ padding: '4px 0 8px 8px', fontWeight: 500, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {ghosts.slice(0, 12).map(g => (
                <tr key={`${g.jobTitle}|${g.company}`} style={{
                  borderTop: '1px solid var(--border)',
                  opacity: g.suppressed ? 0.5 : 1,
                }}>
                  <td style={{ padding: '8px 8px 8px 0' }}>{g.jobTitle}</td>
                  <td style={{ padding: '8px', color: 'var(--text-muted)' }}>{g.company}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }}>{g.postings}</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>{g.spanDays}d</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>
                    {g.averageGapDays == null ? '—' : `~${g.averageGapDays}d`}
                  </td>
                  {/* One role, not one company. Reversible from the same button,
                      because "they are just keeping a pipeline warm" is a guess
                      the user is entitled to change their mind about. */}
                  <td style={{ padding: '8px 0 8px 8px', textAlign: 'right' }}>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={async () => {
                        if (g.suppressed) await window.api.unsuppressRole?.(g.company, g.jobTitle)
                        else await window.api.suppressRole?.(g.company, g.jobTitle, `Reposted ${g.postings}x over ${g.spanDays} days`)
                        window.api.getGhostJobs?.().then(x => setGhosts(x || [])).catch(() => {})
                      }}>
                      {g.suppressed ? 'Resume scanning' : 'Stop drafting'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
            Each of these has been advertised at least three times under different URLs over more than
            six weeks. That usually means a pipeline being kept warm, an agency collecting CVs, or a
            policy requiring the role be posted — not a vacancy waiting for you. Nothing here is acted
            on automatically: &ldquo;probably a ghost&rdquo; is a judgement about an employer, and
            silently hiding real jobs on it would be worse than the cost it saves.
            <br /><br />
            <strong>Stop drafting</strong> is the narrow version of that decision. It skips this exact
            role at this exact company on future scans &mdash; before the description fetch and the three
            model calls, so it actually saves the spend &mdash; while every other opening at the same
            company keeps being scanned and applied to as normal. Blacklist the company from a job&rsquo;s
            detail panel if you want the broader version.
          </p>
        </div>
      )}

      {resumeConv.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Which Resume Converts</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              interview or offer rate per resume sent
            </span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                <th style={{ padding: '4px 8px 8px 0', fontWeight: 500 }}>Resume</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Sent</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Avg match</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Replied</th>
                <th style={{ padding: '4px 0 8px 8px', fontWeight: 500, textAlign: 'right' }}>Interview rate</th>
              </tr>
            </thead>
            <tbody>
              {resumeConv.map(r => (
                <tr key={r.resumeId || r.name} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 8px 8px 0' }}>{r.name}</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.applied}</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.avgMatchScore}%</td>
                  <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.responseRate}%</td>
                  <td style={{
                    padding: '8px 0 8px 8px', textAlign: 'right', fontWeight: 600,
                    // Below the sample floor a rate is noise — show it, but
                    // don't dress it up as a finding.
                    color: r.significant ? 'var(--text)' : 'var(--text-muted)',
                    opacity: r.significant ? 1 : 0.55,
                  }}>
                    {r.conversionRate}%{!r.significant && <span style={{ fontSize: 10, fontWeight: 400 }}> ?</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
            Rates marked “?” come from fewer than 10 applications and aren't meaningful yet. Once a
            resume has a real sample, this is the evidence for keeping or dropping the routing rule
            that sends jobs to it.
          </p>
        </div>
      )}

      {/* Model spend. Each scanned job costs several API calls, and until now
          the only place that showed up was the provider's monthly bill. */}
      {aiUsage && (aiUsage.month?.calls > 0 || aiUsage.today?.calls > 0) && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>AI Usage &amp; Cost</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              estimated from published token prices — indicative, not an invoice
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 16, marginBottom: 16 }}>
            {[
              { label: 'Today', value: `$${(aiUsage.today?.cost || 0).toFixed(2)}`, sub: `${aiUsage.today?.calls || 0} calls` },
              { label: 'This month', value: `$${(aiUsage.month?.cost || 0).toFixed(2)}`, sub: `${aiUsage.month?.calls || 0} calls` },
              { label: 'Input tokens', value: (aiUsage.month?.inputTokens || 0).toLocaleString(), sub: 'this month' },
              { label: 'Output tokens', value: (aiUsage.month?.outputTokens || 0).toLocaleString(), sub: 'this month' },
            ].map(m => (
              <div key={m.label}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{m.value}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.label} · {m.sub}</div>
              </div>
            ))}
          </div>
          {(aiUsage.byOperation || []).length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                  <th style={{ padding: '4px 8px 8px 0', fontWeight: 500 }}>Operation</th>
                  <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Calls</th>
                  <th style={{ padding: '4px 0 8px 8px', fontWeight: 500, textAlign: 'right' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {(aiUsage.byOperation || []).map(o => (
                  <tr key={o.operation} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px 6px 0' }}>{o.operation}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-muted)' }}>{o.calls}</td>
                    <td style={{ padding: '6px 0 6px 8px', textAlign: 'right' }}>${(o.cost || 0).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Advertised salary. Derived from the normalised annual columns, so a
          posting quoting an hourly rate is comparable with one quoting a
          package. Rows whose salary text couldn't be parsed are reported
          separately rather than folded in as zeros. */}
      {salary && salary.count > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Advertised Salary</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              annualised · from {salary.count} listing{salary.count === 1 ? '' : 's'}
              {salary.unparsed > 0 && ` · ${salary.unparsed} not stated`}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
            {[
              { label: 'Median', value: salary.median },
              { label: 'Average', value: salary.average },
              { label: 'Lowest', value: salary.min },
              { label: 'Highest', value: salary.max },
            ].map(m => (
              <div key={m.label}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{formatMoney(m.value)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Where applications die, and which generated version won. Both sit
          above the funnel: the funnel says what happened, these say what to
          do about it. */}
      <RejectionPanel data={rejection} />
      <VersionOutcomesPanel data={versions} />

      {/* Funnel + Status breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>Application Funnel</div>
          <FunnelBar label="Submitted" count={submittedCount} total={allApps.length} color="var(--accent)" />
          <FunnelBar label="Awaiting Response" count={pendingCount} total={allApps.length} color="var(--yellow)" />
          <FunnelBar label="Got Interview" count={interviewCount} total={allApps.length} color="var(--green)" />
          <FunnelBar label="Got Offer" count={offerCount} total={allApps.length} color="var(--green)" />
          <FunnelBar label="Rejected" count={rejectedCount} total={allApps.length} color="var(--red)" />
          <FunnelBar label="No Response" count={noResponseCount} total={allApps.length} color="var(--text-muted)" />
          <FunnelBar label="Skipped" count={skippedCount} total={allApps.length} color="var(--text-muted)" />
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>By Status</div>
          <ChartFrame
            title="Applications by status"
            summary={`Donut chart: applications by status. `
              + (byStatus.length
                ? byStatus.map(s => `${s.status} ${s.count}`).join(', ')
                : 'No applications yet.')}
            columns={[{ key: 'status', label: 'Status' }, { key: 'count', label: 'Applications', numeric: true }]}
            rows={byStatus}
            filename="hiro-applications-by-status.csv"
          >
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
          </ChartFrame>
        </div>
      </div>
    </div>
  )
}
