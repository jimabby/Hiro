import { useEffect, useState } from 'react'

export default function SyncHealth() {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    const read = async () => {
      try { const s = await window.api.cloudStatus(); if (live) { setStatus(s); setError('') } }
      catch (e) { if (live) setError(e.message) }
    }
    read(); const timer = setInterval(read, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  async function retry() {
    setBusy(true); setError('')
    try { const r = await window.api.cloudSyncNow(); if (r.status) setStatus(r.status); if (!r.success) setError(r.error || 'Sync could not finish.') }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const pending = status?.pendingChanges || []
  return <section aria-label="Sync health" style={{ marginBottom: 14 }}>
    <strong>Sync health</strong>
    <p aria-live="polite">{status?.syncing ? `Syncing: ${status.stage || 'Connecting'}` : status?.pendingFirstSync ? 'Waiting for your merge choice' : status?.error ? 'Needs attention' : pending.length || status?.pendingDeletions ? 'Changes waiting to sync' : status?.lastSyncAt ? 'Up to date' : 'Not synced yet'}</p>
    <p>Last successful sync: {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Never'}</p>
    {(error || status?.error) && <p role="alert" style={{ color: 'var(--red)' }}>{error || status.error}{status?.stage ? ` (${status.stage})` : ''}</p>}
    <p>{pending.length} application changes · {status?.pendingDeletions || 0} deletions pending</p>
    {!!pending.length && <details><summary>Pending applications</summary><ul>{pending.map(row => <li key={row.id}>{row.title} · {row.company}</li>)}</ul></details>}
    {!!status?.failedItems?.length && <details open><summary>Failed uploads</summary><ul>{status.failedItems.map(row => <li key={row.id}>{row.title}: {row.error}</li>)}</ul></details>}
    <button className="btn btn-ghost" disabled={busy || status?.syncing || !!status?.pendingFirstSync} onClick={retry}>{busy ? 'Retrying…' : 'Sync / retry pending changes'}</button>
  </section>
}
