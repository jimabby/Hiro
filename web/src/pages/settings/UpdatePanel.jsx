// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// Application updates: what is available, and what stage a download is at.

import { useEffect, useState } from 'react'

export function UpdatePanel({ form, set, showToast }) {
  const [status, setStatus] = useState(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.getUpdateStatus?.().then(setStatus).catch(() => {})
    const off = window.api.onUpdateStatus?.(setStatus)
    return () => off?.()
  }, [])

  async function check() {
    setChecking(true)
    try {
      const res = await window.api.checkForUpdate()
      setStatus(res)
      if (res?.error) showToast?.(res.error, 'error')
      else if (!res?.updateAvailable) showToast?.('You are on the latest version', 'success')
    } catch (err) {
      showToast?.(`Update check failed: ${err.message}`, 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Updates</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Hiro checks for a new version daily. Nothing downloads or installs without you asking, and a
        restart is refused while a scan or apply is running.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={form.autoCheckUpdates !== false}
          onChange={e => set('autoCheckUpdates', e.target.checked)}
        />
        <span>Check for updates automatically</span>
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-ghost" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {status?.currentVersion && `Version ${status.currentVersion}`}
          {status?.updateAvailable && ` · ${status.version} available`}
          {status?.downloaded && ' · downloaded, restart to install'}
        </span>
      </div>
      {status?.error && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{status.error}</div>
      )}
    </div>
  )
}
