import { useEffect, useState } from 'react'

// Skills employers keep asking for, and whether the résumé names them
// (services/skillsGap.js). Counted locally from the ads Hiro has read — free,
// and every number can be checked by opening those ads. "Not in your résumé"
// is not "you lack it": the decision to add a skill is the user's.

const RANGES = [30, 60, 90, 180]

function Row({ row, tone }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '4px 0' }}>
      <span style={{ width: 150, flexShrink: 0, fontWeight: 600 }}>{row.skill}</span>
      <div aria-hidden="true" style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(row.share * 100)}%`, height: '100%', background: tone }} />
      </div>
      <span style={{ width: 110, textAlign: 'right', color: 'var(--text-muted)' }}
        title={row.examples.map(e => `${e.job_title} — ${e.company}`).join('\n')}>
        {row.jobs} ad{row.jobs === 1 ? '' : 's'} ({Math.round(row.share * 100)}%)
      </span>
    </li>
  )
}

export default function SkillsGap({ active }) {
  const [days, setDays] = useState(90)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (active === false || typeof window.api?.getSkillsGap !== 'function') return
    let live = true
    Promise.resolve(window.api.getSkillsGap({ days }))
      .then(res => { if (live) { setData(res); setError(null) } })
      .catch(err => live && setError(err.message))
    return () => { live = false }
  }, [active, days])

  if (typeof window.api?.getSkillsGap !== 'function') return null

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Skills employers ask for</span>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Ads from the last{' '}
          <select aria-label="Time range for skills" value={days} onChange={e => setDays(Number(e.target.value))}>
            {RANGES.map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{error}</p>}
      {!data && !error && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Reading recent ads…</p>}
      {data && !data.enoughData && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {data.sample} ad{data.sample === 1 ? '' : 's'} with a description in this period — too few to call anything a trend.
          This fills in as scans run.
        </p>
      )}
      {data?.enoughData && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            From {data.sample} ads. A skill missing here may simply be one you have not written down — add it to your
            résumé only if it is true. Track more skills in Settings → Job criteria.
          </p>
          {!data.hasResume && <p style={{ fontSize: 13 }}>Add a résumé in Settings to see which of these it covers.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Not in your résumé</div>
              {data.missing.length === 0
                ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Every frequently requested skill is in a résumé.</p>
                : <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{data.missing.map(r => <Row key={r.skill} row={r} tone="var(--amber, var(--yellow))" />)}</ul>}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Already covered</div>
              {data.covered.length === 0
                ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>None of the frequently requested skills appear in a résumé yet.</p>
                : <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{data.covered.map(r => <Row key={r.skill} row={r} tone="var(--green)" />)}</ul>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
