// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// Everything under Settings -> Data: the rotating backups, the portable export
// of the whole job search, the settings-only transfer, and what is on disk.
// Grouped rather than split four ways because they share formatBytes and are
// read as one section.

import { useEffect, useState } from 'react'

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export function BackupsCard({ showToast }) {
  const [backups, setBackups] = useState([])
  const [drill, setDrill] = useState(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const [items, status] = await Promise.all([window.api.listBackups(), window.api.getBackupDrillStatus()])
      setBackups(items || []); setDrill(status)
    } catch { setBackups([]) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>Backups</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            The database is backed up automatically once a day (last 7 kept) in ~/.hiro/backups.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const res = await window.api.drillBackups()
              await load()
              showToast?.(res.success ? `Recovery drill passed for ${res.checked} backup(s)` : (res.error || `${res.failed} backup(s) failed`), res.success ? 'success' : 'error')
            } finally { setBusy(false) }
          }}>Test Recovery</button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const res = await window.api.backupNow()
              if (res.success) { showToast?.('Backup created', 'success'); await load() }
              else showToast?.(res.error || 'Backup failed', 'error')
            } finally { setBusy(false) }
          }}>{busy ? 'Working…' : 'Back Up Now'}</button>
        </div>
      </div>
      {drill && <p style={{ color: drill.success ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
        Last recovery drill: {new Date(drill.checkedAt).toLocaleString()} · {drill.checked} checked · {drill.failed} failed
      </p>}
      {backups.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No backups yet — one is created automatically each day the app runs.</p>}
      {backups.map(b => (
        <div key={b.name} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '8px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 6,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(b.mtime).toLocaleString()} · {formatBytes(b.size)}</div>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
            if (!window.confirm(`Restore ${b.name}? Your current data will be replaced (a pre-restore snapshot is kept in the backups folder).`)) return
            setBusy(true)
            try {
              const res = await window.api.restoreBackup(b.name)
              if (res.success) {
                showToast?.('Backup restored — reloading', 'success')
                setTimeout(() => window.location.reload(), 800)
              } else {
                showToast?.(res.error || 'Restore failed', 'error')
              }
            } finally { setBusy(false) }
          }}>Restore</button>
        </div>
      ))}
    </div>
  )
}

// Encrypted export/import of settings — resumes, criteria, blacklists, rules.
// The database backups above cover applications; this covers everything else,
// which otherwise had to be re-entered by hand on a new machine.
// The whole job search as portable data.
//
// Deliberately separate from Settings Transfer above it and from the database
// backups: those cover the other two thirds of the problem and neither covers
// this one. A backup is the SQLite file, which on an encrypted profile cannot be
// opened without this machine's keychain entry — right for a backup, and exactly
// wrong for the case where the keychain is what was lost.
export function DataTransferCard({ showToast, onImported }) {
  const [mode, setMode] = useState(null) // 'export' | 'import'
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState(null)
  const [preview, setPreview] = useState(null)

  function reset() { setMode(null); setPassphrase(''); setStaged(null) }

  async function openExport() {
    setMode('export')
    // Say what is about to be written before it is written.
    try {
      const res = await window.api.exportDataPreview?.()
      if (res?.success) setPreview(res.counts)
    } catch { /* the summary is a courtesy, not a precondition */ }
  }

  async function doExport() {
    setBusy(true)
    try {
      const res = await window.api.exportData(passphrase)
      if (res.canceled) return
      if (res.success) {
        showToast?.(res.encrypted ? 'Data exported (encrypted)' : 'Data exported as plain JSON', 'success')
        reset()
      } else showToast?.(res.error || 'Export failed', 'error')
    } finally { setBusy(false) }
  }

  async function doChoose() {
    setBusy(true)
    try {
      const res = await window.api.chooseDataImport()
      if (res.canceled) return
      if (res.success) setStaged(res)
      else showToast?.(res.error || 'Could not read that file', 'error')
    } finally { setBusy(false) }
  }

  async function doImport() {
    setBusy(true)
    try {
      const res = await window.api.importData(passphrase)
      if (res.success) {
        const added = Object.entries(res.added || {}).filter(([, n]) => n > 0)
        showToast?.(res.total > 0
          ? `Imported ${added.map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ')}`
          : 'Nothing new — everything in that file is already here', 'success')
        reset()
        onImported?.()
      } else showToast?.(res.reason || res.error || 'Import failed', 'error')
    } finally { setBusy(false) }
  }

  const summarise = (counts) => Object.entries(counts || {})
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${n} ${table.replace(/_/g, ' ')}`)
    .join(' · ')

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>Data Export</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            Every application with the résumé and cover letter that went out, the replies that came
            back, interviews, contacts and notes — as one portable file. Unlike the backups above,
            this does not need this machine&apos;s keychain to read, so it is the copy that survives a
            lost profile. Importing only ever adds; nothing here is deleted or overwritten.
          </p>
        </div>
        {!mode && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={openExport}>Export</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode('import')}>Import</button>
          </div>
        )}
      </div>

      {mode === 'export' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          {preview && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              This will write {summarise(preview) || 'nothing — there is no history yet'}.
            </div>
          )}
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label htmlFor="set-f2" style={{ fontSize: 12 }}>Passphrase (optional)</label>
            <input id="set-f2" type="password" value={passphrase} autoFocus
              onChange={e => setPassphrase(e.target.value)}
              placeholder="Leave blank to write readable JSON" />
            <div style={{ fontSize: 11, color: passphrase ? 'var(--text-muted)' : 'var(--yellow)', marginTop: 4 }}>
              {passphrase
                ? 'Encrypted with this passphrase. There is no recovery if you lose it.'
                : 'Without a passphrase the file is plain JSON — readable by any tool, and by anyone '
                  + 'who finds it. It contains every résumé, cover letter and recruiter address.'}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doExport} disabled={busy}>
              {busy ? 'Exporting…' : 'Choose file and export'}
            </button>
          </div>
        </div>
      )}

      {mode === 'import' && !staged && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doChoose} disabled={busy}>
            {busy ? 'Reading…' : 'Choose a file'}
          </button>
        </div>
      )}

      {mode === 'import' && staged && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 10 }}>
            {staged.exportedAt && (
              <div style={{ color: 'var(--text-muted)' }}>Exported {new Date(staged.exportedAt).toLocaleString()}</div>
            )}
            <div style={{ color: 'var(--text-muted)' }}>Contains {summarise(staged.counts) || 'nothing'}.</div>
            <div style={{ marginTop: 6 }}>
              Anything already here is left exactly as it is — only what is missing gets added.
            </div>
          </div>
          {staged.encrypted && (
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label htmlFor="set-f3" style={{ fontSize: 12 }}>Passphrase</label>
              <input id="set-f3" type="password" value={passphrase} autoFocus
                onChange={e => setPassphrase(e.target.value)}
                placeholder="Passphrase used at export" />
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doImport}
              disabled={busy || (staged.encrypted && !passphrase)}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function SettingsTransferCard({ showToast, onImported }) {
  const [mode, setMode] = useState(null) // 'export' | 'import'
  const [passphrase, setPassphrase] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState(null)

  function reset() {
    setMode(null); setPassphrase(''); setIncludeSecrets(false); setStaged(null)
  }

  async function doExport() {
    setBusy(true)
    try {
      const res = await window.api.exportConfig(passphrase, includeSecrets)
      if (res.canceled) return
      if (res.success) { showToast?.('Settings exported', 'success'); reset() }
      else showToast?.(res.error || 'Export failed', 'error')
    } finally { setBusy(false) }
  }

  async function doInspect() {
    setBusy(true)
    try {
      const res = await window.api.inspectConfigImport(passphrase)
      if (res.canceled) return
      if (res.success) setStaged(res)
      else showToast?.(res.error || 'Import failed', 'error')
    } finally { setBusy(false) }
  }

  async function doApply() {
    setBusy(true)
    try {
      const res = await window.api.applyConfigImport()
      if (res.success) {
        showToast?.('Settings imported', 'success')
        reset()
        onImported?.()
      } else showToast?.(res.error || 'Import failed', 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>Settings Transfer</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            Export your resumes, job criteria, blacklist, routing rules, and templates to an
            encrypted file — then restore them on another machine. Applications live in the
            database backups above, not here.
          </p>
        </div>
        {!mode && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode('export')}>Export</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode('import')}>Import</button>
          </div>
        )}
      </div>

      {mode && !staged && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label htmlFor="set-f4" style={{ fontSize: 12 }}>Passphrase</label>
            <input id="set-f4" type="password" value={passphrase} autoFocus
              onChange={e => setPassphrase(e.target.value)}
              placeholder={mode === 'export' ? 'At least 8 characters' : 'Passphrase used at export'} />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              {mode === 'export'
                ? 'The file is encrypted with this passphrase. There is no recovery if you lose it.'
                : 'Enter the passphrase this file was exported with.'}
            </div>
          </div>

          {mode === 'export' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" style={{ width: 'auto' }}
                checked={includeSecrets} onChange={e => setIncludeSecrets(e.target.checked)} />
              Include API key and email app password
            </label>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }}
              disabled={busy || passphrase.length < 8}
              onClick={mode === 'export' ? doExport : doInspect}>
              {busy ? 'Working…' : mode === 'export' ? 'Choose File & Export' : 'Choose File'}
            </button>
          </div>
        </div>
      )}

      {staged && (
        <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Ready to import</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Exported {staged.createdAt ? new Date(staged.createdAt).toLocaleString() : 'at an unknown time'} ·
            {' '}{staged.summary.keys} settings · {staged.summary.resumes} resume{staged.summary.resumes === 1 ? '' : 's'} ·
            {' '}{staged.summary.resumeRules} routing rule{staged.summary.resumeRules === 1 ? '' : 's'} ·
            {' '}{staged.summary.blacklistedCompanies} blacklisted
            {staged.includesSecrets ? ' · includes credentials' : ' · no credentials'}
            <br />
            This replaces your current settings. Applications and history are untouched.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doApply} disabled={busy}>
              {busy ? 'Importing…' : 'Replace My Settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function StorageCard() {
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)

  async function loadInfo() {
    setLoading(true)
    const data = await window.api.getStorageInfo()
    setInfo(data)
    setLoading(false)
  }

  useEffect(() => { loadInfo() }, [])

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Storage</h3>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={loadInfo} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {info ? (
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>{formatBytes(info.dbSize)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            {[
              { label: 'Applications', count: info.counts.applications },
              { label: 'Attention Jobs', count: info.counts.attentionJobs },
              { label: 'Cached Answers', count: info.counts.cachedAnswers },
              { label: 'Interview Preps', count: info.counts.interviewPreps },
              { label: 'Interviews', count: info.counts.interviewEvents ?? 0 },
            ].map(({ label, count }) => (
              <div key={label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{count}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
            Database size will decrease after clearing history, cache, or attention queue below.
          </p>
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
      )}
    </div>
  )
}
