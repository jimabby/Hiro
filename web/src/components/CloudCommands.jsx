import { useEffect, useState } from 'react'

export default function CloudCommands() {
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function load() {
    try { setRows(await window.api.getCloudCommands()); setError('') } catch (err) { setError(err.message) }
  }
  useEffect(() => { load() }, [])
  return <section aria-label="Cloud command history" style={{ marginTop: 20 }}>
    <h3>Phone commands</h3>
    <button className="btn btn-ghost" onClick={load}>Refresh commands</button>
    {error && <p role="alert">{error}</p>}
    {!rows.length && !error && <p>No cloud commands yet.</p>}
    {rows.map(row => <div key={`${row.kind}:${row.id}`} style={{ padding: 8 }}>
      <strong>{row.kind === 'scan' ? `Scan: ${row.keywords || 'Saved search'}` : `${row.action}: ${row.jobTitle || row.application_cloud_id} ${row.company || ''}`}</strong> · {row.status}
      <div>{new Date(row.created_at).toLocaleString()}{row.claimed_by ? ` · Desktop ${row.claimed_by.slice(0, 8)}` : ''}</div>
      {row.error && <p>{row.error}</p>}
      {row.status === 'failed' && <button className="btn btn-ghost" disabled={busy} onClick={async () => {
        if (row.kind === 'review' && !window.confirm('Check the employer site first. Only retry if this application was not already submitted. Continue?')) return
        setBusy(true)
        try { await window.api.retryCloudCommand(row.kind, row.id); await load() }
        catch (err) { setError(err.message) } finally { setBusy(false) }
      }}>Retry command</button>}
    </div>)}
  </section>
}
