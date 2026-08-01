import { useState, useEffect, useRef } from 'react'
import HiroLogo from '../components/HiroLogo'

const ATS_PROVIDERS = [
  { id: 'greenhouse', label: 'Greenhouse', hint: 'boards.greenhouse.io/SLUG' },
  { id: 'lever', label: 'Lever', hint: 'jobs.lever.co/SLUG' },
  { id: 'ashby', label: 'Ashby', hint: 'jobs.ashbyhq.com/SLUG' },
]

// Company career boards. These serve structured JSON with no login and no bot
// defenses, which makes them far steadier than scraping the aggregators — but
// their application forms are custom per company, so matches are routed to
// Needs Attention with the documents already drafted rather than submitted.
function AtsBoards({ form, set, showToast }) {
  const [provider, setProvider] = useState('greenhouse')
  const [slug, setSlug] = useState('')
  const [label, setLabel] = useState('')
  const [testing, setTesting] = useState(false)

  const boards = Array.isArray(form.atsBoards) ? form.atsBoards : []
  const active = ATS_PROVIDERS.find(p => p.id === provider)

  async function addBoard() {
    const cleanSlug = slug.trim()
    if (!cleanSlug) return
    if (boards.some(b => b.provider === provider && b.slug.toLowerCase() === cleanSlug.toLowerCase())) {
      showToast?.('That board is already in the list', 'error')
      return
    }
    // Validate before saving — a typo caught here beats an empty scan three
    // days from now that looks like a quiet job market.
    setTesting(true)
    try {
      const res = await window.api.testAtsBoard(provider, cleanSlug)
      if (!res?.success) {
        showToast?.(`Could not read that board: ${res?.error || 'unknown error'}`, 'error')
        return
      }
      set('atsBoards', [...boards, {
        id: Date.now().toString(36),
        provider,
        slug: cleanSlug,
        label: label.trim() || cleanSlug,
      }])
      setSlug('')
      setLabel('')
      showToast?.(`Added — ${res.count} open role${res.count === 1 ? '' : 's'} on that board right now`, 'success')
    } catch (err) {
      showToast?.(`Could not read that board: ${err.message}`, 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Company Career Boards</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Watch specific employers directly on Greenhouse, Lever or Ashby. These have no bot defenses
        and don't change shape, so they're more reliable than the job aggregators. They can't be
        auto-submitted — matches land in Needs Attention with your tailored resume and cover letter
        ready to paste.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={!!form.enableAtsBoards}
          onChange={e => set('enableAtsBoards', e.target.checked)}
        />
        <span>Include career boards in scans</span>
      </label>

      {boards.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {boards.map(b => (
            <div key={b.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 6,
            }}>
              <div style={{ fontSize: 13 }}>
                {b.label}
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {' '}· {ATS_PROVIDERS.find(p => p.id === b.provider)?.label || b.provider} / {b.slug}
                </span>
              </div>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => set('atsBoards', boards.filter(x => x.id !== b.id))}
              >Remove</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
          <label>Provider</label>
          <select value={provider} onChange={e => setProvider(e.target.value)}>
            {ATS_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 150 }}>
          <label>Board slug</label>
          <input
            value={slug}
            onChange={e => setSlug(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addBoard() }}
            placeholder={active?.hint.split('/')[1] || 'company'}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 130 }}>
          <label>Display name (optional)</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Acme Corp" />
        </div>
        <button className="btn btn-primary" onClick={addBoard} disabled={testing || !slug.trim()}>
          {testing ? 'Checking…' : 'Add board'}
        </button>
      </div>
      <small style={{ color: 'var(--text-muted)', display: 'block', marginTop: 8 }}>
        The slug is the company name in their careers URL — {active?.hint}. The board is checked
        before it's added.
      </small>

      <div className="form-group" style={{ marginTop: 16, marginBottom: 0, maxWidth: 200 }}>
        <label>Daily application limit</label>
        <input
          type="number" min="1" max="50"
          value={form.dailyLimitAts ?? 10}
          onChange={e => set('dailyLimitAts', Number(e.target.value) || 10)}
        />
      </div>
    </div>
  )
}

// Auto-update. Downloading and installing are both explicit — an update that
// restarted the app mid-scan would abandon a half-submitted application.
function UpdatePanel({ form, set, showToast }) {
  const [status, setStatus] = useState(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.getUpdateStatus?.().then(setStatus).catch(() => {})
    window.api.onUpdateStatus?.(setStatus)
    return () => window.api.removeAllListeners?.('update:status')
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

function IndeedAccountCard() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [logging, setLogging] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.indeedStatus().then(s => setLoggedIn(s.loggedIn))
    window.api.onIndeedStatusUpdate(m => setMsg(m))
    return () => window.api.removeAllListeners('indeed:status-update')
  }, [])

  return (
    <div className="card">
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>Indeed Account</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Required for Indeed Easy Apply. Without logging in, applications won't be submitted under your account.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: loggedIn ? 'var(--green)' : 'var(--text-muted)', fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: loggedIn ? 'var(--green)' : 'var(--border)' }} />
          {loggedIn ? 'Logged in' : 'Not logged in'}
        </div>
        {loggedIn ? (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
            await window.api.indeedLogout()
            setLoggedIn(false)
            setMsg('')
          }}>Log Out</button>
        ) : (
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={logging} onClick={async () => {
            setLogging(true)
            setMsg('')
            const res = await window.api.indeedLogin()
            setLogging(false)
            if (res.success) { setLoggedIn(true); setMsg('Logged in successfully!') }
            else setMsg(res.error || 'Login failed')
          }}>
            {logging ? 'Waiting for login...' : 'Login to Indeed'}
          </button>
        )}
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: loggedIn ? 'var(--green)' : 'var(--red)' }}>{msg}</div>}
    </div>
  )
}

function SeekAccountCard() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [logging, setLogging] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.seekStatus().then(s => setLoggedIn(s.loggedIn))
    window.api.onSeekStatusUpdate(m => setMsg(m))
    return () => window.api.removeAllListeners('seek:status-update')
  }, [])

  return (
    <div className="card">
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>Seek Account</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Required for Seek applications. Without logging in, submitted applications won't be recorded and you won't receive confirmation emails.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: loggedIn ? 'var(--green)' : 'var(--text-muted)', fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: loggedIn ? 'var(--green)' : 'var(--border)' }} />
          {loggedIn ? 'Logged in' : 'Not logged in'}
        </div>
        {loggedIn ? (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
            await window.api.seekLogout()
            setLoggedIn(false)
            setMsg('')
          }}>Log Out</button>
        ) : (
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={logging} onClick={async () => {
            setLogging(true)
            setMsg('')
            const res = await window.api.seekLogin()
            setLogging(false)
            if (res.success) { setLoggedIn(true); setMsg('Logged in successfully!') }
            else setMsg(res.error || 'Login failed')
          }}>
            {logging ? 'Waiting for login...' : 'Login to Seek'}
          </button>
        )}
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: loggedIn ? 'var(--green)' : 'var(--red)' }}>{msg}</div>}
    </div>
  )
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function BackupsCard({ showToast }) {
  const [backups, setBackups] = useState([])
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setBackups(await window.api.listBackups() || []) } catch { setBackups([]) }
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
        <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
          setBusy(true)
          try {
            const res = await window.api.backupNow()
            if (res.success) { showToast?.('Backup created', 'success'); await load() }
            else showToast?.(res.error || 'Backup failed', 'error')
          } finally { setBusy(false) }
        }}>{busy ? 'Working…' : 'Back Up Now'}</button>
      </div>
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
function SettingsTransferCard({ showToast, onImported }) {
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
            <label style={{ fontSize: 12 }}>Passphrase</label>
            <input type="password" value={passphrase} autoFocus
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

function StorageCard() {
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

export default function Settings({ showToast, active }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [addingResume, setAddingResume] = useState(false)
  const [cachedAnswers, setCachedAnswers] = useState([])
  const [cachedSearch, setCachedSearch] = useState('')
  const [newBlacklist, setNewBlacklist] = useState('')
  const [newResumeName, setNewResumeName] = useState('')
  const [newResumeText, setNewResumeText] = useState('')
  const [newResumeOriginalPath, setNewResumeOriginalPath] = useState(null)
  const [newResumeOriginalExt, setNewResumeOriginalExt] = useState(null)
  const [uploadError, setUploadError] = useState('')
  const [clUploadError, setClUploadError] = useState('')
  const [settingsTab, setSettingsTab] = useState('accounts')
  const [pdfModal, setPdfModal] = useState(null) // { base64, title }
  const [pdfLoading, setPdfLoading] = useState(false)
  const [improvingId, setImprovingId] = useState(null)
  const [improveModal, setImproveModal] = useState(null) // { sourceId, sourceName, text }
  const [testingAi, setTestingAi] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)
  const [aiResult, setAiResult] = useState(null)
  const [emailResult, setEmailResult] = useState(null)
  const [linkedinLoggedIn, setLinkedinLoggedIn] = useState(false)
  const [linkedinLogging, setLinkedinLogging] = useState(false)
  const [linkedinMsg, setLinkedinMsg] = useState('')
  const [gmailLogging, setGmailLogging] = useState(false)
  const [gmailMsg, setGmailMsg] = useState('')
  const [checkingInbox, setCheckingInbox] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [sweepResult, setSweepResult] = useState(null)
  const [inboxResult, setInboxResult] = useState(null)
  const [mobileInfo, setMobileInfo] = useState(null)
  const [mobileBusy, setMobileBusy] = useState(false)
  const [cloudStatus, setCloudStatus] = useState(null)
  const [cloudUrl, setCloudUrl] = useState('')
  const [cloudKey, setCloudKey] = useState('')
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudPassword, setCloudPassword] = useState('')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudMsg, setCloudMsg] = useState('')

  // Every page stays mounted for the app's lifetime, so this form is a snapshot
  // that would otherwise go stale: blacklisting a company from the Dashboard,
  // or importing a resume that auto-fills personalLinks, writes config behind
  // our back — and saving the stale form silently reverted it. Refetch whenever
  // Settings becomes visible again.
  useEffect(() => {
    if (active === false) return
    window.api.getConfig().then(cfg => {
      setForm(f => ({
        ...cfg,
        blacklistedCompanies: Array.isArray(cfg.blacklistedCompanies)
          ? cfg.blacklistedCompanies.join(', ')
          : cfg.blacklistedCompanies || '',
        // Preserve fields the user is mid-edit so a tab switch doesn't discard
        // unsaved typing; only unedited values are refreshed from disk.
        ...(dirtyRef.current ? f : {}),
      }))
    })
  }, [active])

  useEffect(() => {
    window.api.linkedinStatus().then(s => setLinkedinLoggedIn(s.loggedIn))
    window.api.getMobileInfo?.().then(setMobileInfo)
    window.api.cloudStatus?.().then(s => {
      setCloudStatus(s)
      if (s?.email) setCloudEmail(s.email)
    })
    window.api.getConfig().then(cfg => {
      setCloudUrl(cfg.supabaseUrl || '')
      setCloudKey(cfg.supabaseAnonKey || '')
    })
    window.api.onLinkedInStatusUpdate(msg => setLinkedinMsg(msg))
    window.api.onGmailStatusUpdate(msg => setGmailMsg(msg))
    return () => {
      window.api.removeAllListeners('linkedin:status-update')
      window.api.removeAllListeners('gmail:status-update')
    }
  }, [])

  // Tracks whether the form has edits the user hasn't saved yet, so refetching
  // on tab-focus never throws away typing in progress.
  const dirtyRef = useRef(false)

  const set = (key, val) => {
    dirtyRef.current = true
    setForm(f => ({ ...f, [key]: val }))
  }

  async function viewPDF(text, title, originalPath, originalExt) {
    setPdfLoading(title)
    try {
      const res = await window.api.getResumePDFBase64(text, originalPath || null, originalExt || null)
      if (res.success) setPdfModal({ base64: res.base64, title })
    } finally {
      setPdfLoading(false)
    }
  }

  async function saveResumes(resumes, defaultResumeId) {
    const cfg = await window.api.getConfig()
    await window.api.saveConfig({ ...cfg, resumes, defaultResumeId })
    setForm(f => ({ ...f, resumes, defaultResumeId }))
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    const clamp = (v, min, max, fallback) => { const n = parseInt(v); return isNaN(n) ? fallback : Math.min(max, Math.max(min, n)) }
    await window.api.saveConfig({
      ...form,
      salaryMin: Math.max(0, parseInt(form.salaryMin) || 0),
      matchThreshold: clamp(form.matchThreshold, 0, 100, 80),
      dailyLimitSeek: clamp(form.dailyLimitSeek, 1, 100, 10),
      dailyLimitIndeed: clamp(form.dailyLimitIndeed, 1, 100, 10),
      dailyLimitLinkedIn: clamp(form.dailyLimitLinkedIn, 1, 100, 10),
      blacklistedCompanies: (form.blacklistedCompanies || '').split(',').map(s => s.trim()).filter(Boolean),
      followUpDays: clamp(form.followUpDays, 1, 30, 7),
      companyCooldownDays: clamp(form.companyCooldownDays, 0, 365, 30),
      smartScheduleBatchSize: clamp(form.smartScheduleBatchSize, 1, 20, 3),
      smartScheduleJitter: clamp(form.smartScheduleJitter, 0, 60, 15),
      // MAX_PAGES in the scrapers is 10; anything higher is silently capped
      // there, so clamp here to keep the form honest about what will happen.
      scrapePages: clamp(form.scrapePages, 1, 10, 3),
      // 0 is meaningful (disables the sweep), so the floor is 0, not 1.
      staleAfterDays: clamp(form.staleAfterDays, 0, 365, 45),
      inboxCheckHours: clamp(form.inboxCheckHours, 1, 24, 2),
      // Drop rules whose resume was deleted, or the applicator would silently
      // fall through to the default for a rule the user thinks is active.
      resumeRules: (form.resumeRules || []).filter(r =>
        r?.keywords?.trim() && (form.resumes || []).some(x => x.id === r.resumeId)),
    })
    dirtyRef.current = false // saved state now matches disk — safe to refetch
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function testAI() {
    setTestingAi(true); setAiResult(null)
    const res = await window.api.testAiConnection(form.aiProvider, form.aiApiKey, form.geminiModel)
    setTestingAi(false); setAiResult(res)
  }

  async function testEmail() {
    setTestingEmail(true); setEmailResult(null)
    const res = await window.api.testEmailConnection(form.gmailAddress, form.gmailAppPassword)
    setTestingEmail(false); setEmailResult(res)
  }

  if (!form) return <div style={{ color: 'var(--text-muted)' }}>Loading...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Settings</h1>
        {settingsTab !== 'about' && settingsTab !== 'data' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {saved && <span style={{ color: 'var(--green)', fontSize: 13 }}>✓ Saved</span>}
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      {(() => {
        const TABS = [
          { id: 'accounts', label: 'Accounts & Schedule' },
          { id: 'criteria', label: 'Job, Resume & Cover Letter' },
          { id: 'automation', label: 'Automation & Boards' },
          { id: 'notifications', label: 'Notifications' },
          { id: 'data', label: 'Data Management' },
          { id: 'about', label: 'About' },
        ]
        return (
          <div style={{ display: 'flex', gap: 2, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => setSettingsTab(tab.id)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 18px', fontSize: 14, fontWeight: settingsTab === tab.id ? 600 : 400,
                color: settingsTab === tab.id ? 'var(--text)' : 'var(--text-muted)',
                borderBottom: settingsTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
              }}>
                {tab.label}
              </button>
            ))}
          </div>
        )
      })()}

      {settingsTab === 'accounts' && <div>
      {/* AI */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>AI Provider</h3>
        <div className="form-group">
          <label>Provider</label>
          <select value={form.aiProvider} onChange={e => set('aiProvider', e.target.value)}>
            <option value="claude">Claude (Anthropic)</option>
            <option value="chatgpt">ChatGPT (OpenAI)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="gemini">Gemini (Google)</option>
          </select>
        </div>
        <div className="form-group">
          <label>API Key</label>
          <input type="password" value={form.aiApiKey} onChange={e => set('aiApiKey', e.target.value)} />
        </div>
        {form.aiProvider === 'gemini' && (
          <div className="form-group">
            <label>Gemini Model Name</label>
            <input
              value={form.geminiModel || ''}
              onChange={e => set('geminiModel', e.target.value)}
              placeholder="e.g. gemini-2.5-flash"
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Find your available models at aistudio.google.com
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={testAI} disabled={!form.aiApiKey || testingAi}>
            {testingAi ? 'Testing...' : 'Test Connection'}
          </button>
          {aiResult && (
            <span style={{ color: aiResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
              {aiResult.success ? '✓ Connected' : `✗ ${aiResult.error}`}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
      {/* LinkedIn */}
      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>LinkedIn Account</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Required for LinkedIn Easy Apply. A browser window will open — log in normally, it closes automatically.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: linkedinLoggedIn ? 'var(--green)' : 'var(--text-muted)', fontSize: 13,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: linkedinLoggedIn ? 'var(--green)' : 'var(--border)',
            }} />
            {linkedinLoggedIn ? 'Logged in' : 'Not logged in'}
          </div>
          {linkedinLoggedIn ? (
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
              await window.api.linkedinLogout()
              setLinkedinLoggedIn(false)
              setLinkedinMsg('')
            }}>
              Log Out
            </button>
          ) : (
            <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={linkedinLogging} onClick={async () => {
              setLinkedinLogging(true)
              setLinkedinMsg('')
              const res = await window.api.linkedinLogin()
              setLinkedinLogging(false)
              if (res.success) {
                setLinkedinLoggedIn(true)
                setLinkedinMsg('Logged in successfully!')
              } else {
                setLinkedinMsg(res.error || 'Login failed')
              }
            }}>
              {linkedinLogging ? 'Waiting for login...' : 'Login to LinkedIn'}
            </button>
          )}
        </div>
        {linkedinMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: linkedinLoggedIn ? 'var(--green)' : 'var(--red)' }}>
            {linkedinMsg}
          </div>
        )}
      </div>

      {/* Indeed */}
      <IndeedAccountCard />

      {/* Seek */}
      <SeekAccountCard />
      </div> {/* end account cards grid */}

      {/* Email Notifications */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Email Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Used to send job alerts, daily reports, follow-up emails, and check your inbox for recruiter replies. Supports Gmail, Outlook, Yahoo, and iCloud.
        </p>

        {/* App Password helper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={gmailLogging} onClick={async () => {
            setGmailLogging(true); setGmailMsg('')
            const res = await window.api.gmailLogin(form.gmailAddress)
            setGmailLogging(false)
            if (!res.success) setGmailMsg(res.error || 'Failed to open browser')
          }}>
            {gmailLogging ? 'Opening...' : 'Open App Passwords Page ↗'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Opens the correct page for your email provider
          </span>
        </div>
        {gmailMsg && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, padding: '8px 12px', background: 'var(--surface2)', borderRadius: 6 }}>
            {gmailMsg}
          </div>
        )}

        <div className="form-row">
          <div className="form-group">
            <label>Email Address</label>
            <input type="email" value={form.gmailAddress} onChange={e => set('gmailAddress', e.target.value)} placeholder="you@gmail.com / outlook.com / yahoo.com" />
          </div>
          <div className="form-group">
            <label>App Password <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(generated in your email provider's security settings)</span></label>
            <input type="password" value={form.gmailAppPassword} onChange={e => set('gmailAppPassword', e.target.value)} placeholder="App-specific password" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={testEmail} disabled={!form.gmailAddress || !form.gmailAppPassword || testingEmail}>
            {testingEmail ? 'Testing...' : 'Test Connection'}
          </button>
          {emailResult && (
            <span style={{ color: emailResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
              {emailResult.success ? '✓ Connected' : `✗ ${emailResult.error}`}
            </span>
          )}
        </div>

        {/* Inbox check */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableInboxCheck} onChange={e => set('enableInboxCheck', e.target.checked)} />
              Auto-check inbox for recruiter replies
            </label>
          </div>
          {form.enableInboxCheck && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 12 }}>Check every</label>
                <select value={form.inboxCheckHours ?? 2} onChange={e => set('inboxCheckHours', e.target.value)}
                  style={{ width: 130, padding: '6px 10px', fontSize: 12 }}>
                  {[1, 2, 3, 4, 6, 8, 12, 24].map(h => (
                    <option key={h} value={h}>{h === 1 ? 'hour' : `${h} hours`}</option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 6, fontSize: 12 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!form.inboxCheckWeekdaysOnly}
                  onChange={e => set('inboxCheckWeekdaysOnly', e.target.checked)} />
                Weekdays only
              </label>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px', flex: '1 1 220px', minWidth: 200 }}>
                Checks run every day by default — a Friday-evening reply otherwise
                waits until Monday. Applications marked Pending or No Response are
                re-checked too, so a later email can still move them forward.
              </p>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}
              disabled={checkingInbox || !form.gmailAddress || !form.gmailAppPassword}
              onClick={async () => {
                setCheckingInbox(true); setInboxResult(null)
                const res = await window.api.checkInboxNow()
                setCheckingInbox(false); setInboxResult(res)
              }}>
              {checkingInbox ? 'Checking...' : 'Check Inbox Now'}
            </button>
            {inboxResult && (
              <span style={{ fontSize: 12, color: inboxResult.success ? 'var(--green)' : 'var(--red)' }}>
                {inboxResult.success
                  ? `✓ Scanned ${inboxResult.checked} emails — ${inboxResult.updated?.length || 0} status${inboxResult.updated?.length === 1 ? '' : 'es'} updated`
                  : `✗ ${inboxResult.error}`}
              </span>
            )}
          </div>
          {form.lastInboxCheck && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Last checked: {new Date(form.lastInboxCheck).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Automation Schedule */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>Automation Schedule</h3>
        <div className="form-row">
          <div className="form-group">
            <label>Daily Scan Time (Mon–Fri)</label>
            <input type="time" value={form.scheduledScanTime || '09:00'} onChange={e => set('scheduledScanTime', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Daily Report Time (Mon–Fri)</label>
            <input type="time" value={form.dailyReportTime || '18:00'} onChange={e => set('dailyReportTime', e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableFollowUp} onChange={e => set('enableFollowUp', e.target.checked)} />
            Auto follow-up emails for unanswered applications
          </label>
        </div>
        {form.enableFollowUp && (
          <div className="form-group">
            <label>Send follow-up email after how many days of no response</label>
            <input type="number" min={1} max={30} value={form.followUpDays || 7} onChange={e => set('followUpDays', e.target.value)} />
          </div>
        )}
      </div>
      {/* Smart Scheduling */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Smart Scheduling</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Spread applications in natural-looking batches throughout the day instead of all at once.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableSmartScheduling} onChange={e => set('enableSmartScheduling', e.target.checked)} />
            Enable smart scheduling
          </label>
        </div>
        {form.enableSmartScheduling && (
          <div>
            <div className="form-row">
              <div className="form-group">
                <label>Start Time</label>
                <input type="time" value={form.smartScheduleStartTime || '09:00'} onChange={e => set('smartScheduleStartTime', e.target.value)} />
              </div>
              <div className="form-group">
                <label>End Time</label>
                <input type="time" value={form.smartScheduleEndTime || '17:00'} onChange={e => set('smartScheduleEndTime', e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Applications per batch</label>
                <input type="number" min={1} max={20} value={form.smartScheduleBatchSize || 3} onChange={e => set('smartScheduleBatchSize', parseInt(e.target.value) || 3)} />
              </div>
              <div className="form-group">
                <label>Jitter (± minutes)</label>
                <input type="number" min={0} max={60} value={form.smartScheduleJitter || 15} onChange={e => set('smartScheduleJitter', parseInt(e.target.value) || 15)} />
              </div>
            </div>
          </div>
        )}
      </div>
      </div>} {/* end accounts tab */}

      {settingsTab === 'notifications' && <div>
      {/* Webhook Notifications */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Webhook Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Get notified on Discord or Slack when jobs need attention, scans complete, or inbox replies arrive.
        </p>
        {(form.webhooks || []).map((wh, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0, fontSize: 13 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={!!wh.enabled} onChange={e => {
                    const webhooks = [...(form.webhooks || [])]
                    webhooks[i] = { ...webhooks[i], enabled: e.target.checked }
                    set('webhooks', webhooks)
                  }} />
                  Enabled
                </label>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)' }} onClick={() => {
                const webhooks = (form.webhooks || []).filter((_, j) => j !== i)
                set('webhooks', webhooks)
              }}>Remove</button>
            </div>
            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label>Provider</label>
                <select value={wh.provider || 'discord'} onChange={e => {
                  const webhooks = [...(form.webhooks || [])]
                  webhooks[i] = { ...webhooks[i], provider: e.target.value }
                  set('webhooks', webhooks)
                }}>
                  <option value="discord">Discord</option>
                  <option value="slack">Slack</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 3 }}>
                <label>Webhook URL</label>
                <input value={wh.url || ''} placeholder="https://discord.com/api/webhooks/..." onChange={e => {
                  const webhooks = [...(form.webhooks || [])]
                  webhooks[i] = { ...webhooks[i], url: e.target.value }
                  set('webhooks', webhooks)
                }} />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label>Events</label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {['attention', 'scan-complete', 'inbox-reply', 'weekly-report'].map(evt => (
                  <label key={evt} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, marginBottom: 0 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={(wh.events || ['attention', 'scan-complete', 'inbox-reply', 'weekly-report']).includes(evt)} onChange={e => {
                      const webhooks = [...(form.webhooks || [])]
                      const currentEvents = webhooks[i].events || ['attention', 'scan-complete', 'inbox-reply', 'weekly-report']
                      webhooks[i] = { ...webhooks[i], events: e.target.checked ? [...currentEvents, evt] : currentEvents.filter(x => x !== evt) }
                      set('webhooks', webhooks)
                    }} />
                    {evt.replace('-', ' ')}
                  </label>
                ))}
              </div>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
              try {
                const res = await window.api.testWebhook(wh.provider || 'discord', wh.url)
                showToast?.(res.success ? 'Test notification sent!' : 'Failed to send test notification', res.success ? 'success' : 'error')
              } catch { showToast?.('Error testing webhook', 'error') }
            }}>Send Test</button>
          </div>
        ))}
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => {
          const webhooks = [...(form.webhooks || []), { provider: 'discord', url: '', enabled: true, events: ['attention', 'scan-complete', 'inbox-reply', 'weekly-report'] }]
          set('webhooks', webhooks)
        }}>+ Add Webhook</button>
      </div>

      {/* Desktop Notifications */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Desktop Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Show a system notification when a scan finishes, a job needs attention, or a recruiter replies —
          only while Hiro is in the background.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.enableDesktopNotifications !== false} onChange={e => set('enableDesktopNotifications', e.target.checked)} />
          Enable desktop notifications
        </label>
      </div>

      {/* Weekly Report */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Weekly Report</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Automatically send a weekly application summary to your webhooks every Monday at 9am.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableWeeklyReport} onChange={e => set('enableWeeklyReport', e.target.checked)} />
          Enable weekly report
        </label>
      </div>

      {/* Mobile App */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Mobile App</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Pair the Hiro mobile app to check stats and update application statuses from your phone.
          The phone connects directly to this computer over your local network — no data leaves your machine.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!mobileInfo?.enabled} disabled={mobileBusy} onChange={async e => {
            setMobileBusy(true)
            const info = await window.api.setMobileEnabled(e.target.checked)
            setMobileInfo(info)
            setMobileBusy(false)
          }} />
          Enable mobile companion server
        </label>
        {mobileInfo?.enabled && (
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: 14, fontSize: 13 }}>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Status: </span>
              <span style={{ color: mobileInfo.running ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                {mobileInfo.running ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Server address: </span>
              {(mobileInfo.addresses || []).length
                ? mobileInfo.addresses.map(a => <code key={a} style={{ marginRight: 8 }}>{a}:{mobileInfo.port}</code>)
                : <span style={{ color: 'var(--text-muted)' }}>no network connection found</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)' }}>Pairing token: </span>
              <code style={{ wordBreak: 'break-all' }}>{mobileInfo.token}</code>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => {
                navigator.clipboard.writeText(mobileInfo.token)
                showToast?.('Token copied', 'success')
              }}>Copy</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                const info = await window.api.regenerateMobileToken()
                setMobileInfo(info)
                showToast?.('New token generated — re-pair your phone', 'info')
              }}>Regenerate</button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              In the mobile app, enter the server address and token above to connect.
            </p>
            {/* The token and the data it returns cross the network unencrypted,
                so the choice of network is a security decision the user has to
                be able to make knowingly. */}
            <p style={{ color: 'var(--amber, #d98324)', fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              ⚠ This connection is not encrypted. Use it only on networks you trust —
              on shared or public Wi-Fi, anyone watching the traffic can capture the
              token and read your application data. Turn this off when you're away
              from home, or use cloud sync instead.
            </p>
          </div>
        )}
      </div>

      {/* Cloud Sync */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Cloud Sync</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Sign in with a Supabase account to sync your applications to the cloud, so the
          mobile app can see them from anywhere — not just your home Wi-Fi. Your local
          database stays the source of truth; the cloud is a private mirror.{' '}
          See <code>supabase/SETUP.md</code> for the one-time project setup.
        </p>

        {cloudStatus?.signedIn ? (
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: 14, fontSize: 13 }}>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Signed in as </span>
              <strong>{cloudStatus.email}</strong>
            </div>
            <div style={{ marginBottom: 10 }}>
              <span style={{ color: 'var(--text-muted)' }}>Status: </span>
              <span style={{ color: cloudStatus.error ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                {cloudStatus.syncing ? 'Syncing…' : cloudStatus.error ? `Error: ${cloudStatus.error}` : 'Synced'}
              </span>
              {cloudStatus.lastSyncAt && !cloudStatus.error && (
                <span style={{ color: 'var(--text-muted)' }}> · last {new Date(cloudStatus.lastSyncAt).toLocaleString()}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={cloudBusy} onClick={async () => {
                setCloudBusy(true)
                const r = await window.api.cloudSyncNow()
                if (r.status) setCloudStatus(r.status)
                setCloudBusy(false)
                showToast?.(r.success ? 'Synced' : `Sync failed: ${r.error}`, r.success ? 'success' : 'error')
              }}>Sync now</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={cloudBusy} onClick={async () => {
                setCloudBusy(true)
                const r = await window.api.cloudSignOut()
                setCloudStatus(r.status)
                setCloudPassword('')
                setCloudBusy(false)
              }}>Sign out</button>
            </div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label>Supabase Project URL</label>
              <input value={cloudUrl} onChange={e => setCloudUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
            </div>
            <div className="form-group">
              <label>Supabase anon key</label>
              <input value={cloudKey} onChange={e => setCloudKey(e.target.value)} placeholder="anon / public key" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Email</label>
                <input value={cloudEmail} onChange={e => setCloudEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" value={cloudPassword} onChange={e => setCloudPassword(e.target.value)} placeholder="password" />
              </div>
            </div>
            {!!cloudMsg && <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 4 }}>{cloudMsg}</p>}
            <button className="btn" disabled={cloudBusy} onClick={async () => {
              setCloudMsg('')
              if (!cloudUrl.trim() || !cloudKey.trim() || !cloudEmail.trim() || !cloudPassword) {
                setCloudMsg('Project URL, anon key, email and password are all required.')
                return
              }
              setCloudBusy(true)
              // Persist the URL + key so the sign-in can build the Supabase client.
              const cfg = await window.api.getConfig()
              await window.api.saveConfig({ ...cfg, supabaseUrl: cloudUrl.trim(), supabaseAnonKey: cloudKey.trim() })
              // Keep the main form in sync — its snapshot still holds the old
              // values and a later "Save Changes" would clobber these.
              setForm(f => ({ ...f, supabaseUrl: cloudUrl.trim(), supabaseAnonKey: cloudKey.trim() }))
              const r = await window.api.cloudSignIn(cloudEmail.trim(), cloudPassword)
              setCloudBusy(false)
              if (r.success) {
                setCloudStatus(r.status)
                setCloudPassword('')
                showToast?.('Signed in — syncing to the cloud', 'success')
              } else {
                setCloudMsg(r.error)
              }
            }}>{cloudBusy ? 'Signing in…' : 'Sign in & sync'}</button>
          </>
        )}
      </div>
      </div>} {/* end notifications tab */}

      {settingsTab === 'criteria' && <div>
      {/* Job Criteria */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>Job Criteria</h3>
        <div className="form-group">
          <label>Keywords</label>
          <input value={form.jobKeywords} onChange={e => set('jobKeywords', e.target.value)} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Location</label>
            <input value={form.jobLocation} onChange={e => set('jobLocation', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Min Salary</label>
            <input type="number" value={form.salaryMin} onChange={e => set('salaryMin', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label>Match Threshold: {form.matchThreshold}%</label>
          <input type="range" min={50} max={100} value={form.matchThreshold}
            onChange={e => set('matchThreshold', e.target.value)}
            style={{ padding: 0, border: 'none', background: 'transparent' }} />
        </div>
        <div className="form-group">
          <label>Company Cooldown (days)</label>
          <input type="number" min={0} max={365}
            value={form.companyCooldownDays ?? 30}
            onChange={e => set('companyCooldownDays', e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            After applying to a company, wait this many days before applying to another
            role there. Set to 0 to allow multiple roles at the same company right away.
            Duplicate listings and cross-platform repeats are always skipped regardless.
          </div>
        </div>
        <div className="form-group">
          <label>Pages per scan</label>
          <input type="number" min={1} max={10}
            value={form.scrapePages ?? 3}
            onChange={e => set('scrapePages', e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            How many pages of search results to walk on each platform. One page is
            roughly 20 listings, and because already-seen jobs are skipped, a single
            page stops turning up anything new within a few days. More pages find more
            work but take longer and raise the chance of being rate-limited — if scans
            start reporting blocks, lower this.
          </div>
        </div>
        <div className="form-group">
          <label>Mark as No Response after (days)</label>
          <input type="number" min={0} max={365}
            value={form.staleAfterDays ?? 45}
            onChange={e => set('staleAfterDays', e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            An application with no reply after this long moves to No Response, so it
            stops dragging down your response rate. Nothing is deleted, and the inbox
            check keeps watching it in case a late reply arrives. Set to 0 to leave
            everything at Applied indefinitely.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}
              disabled={sweeping}
              onClick={async () => {
                setSweeping(true); setSweepResult(null)
                const res = await window.api.sweepStaleApplications()
                setSweeping(false); setSweepResult(res)
              }}>
              {sweeping ? 'Sweeping...' : 'Run Now'}
            </button>
            {sweepResult && (
              <span style={{ fontSize: 12, color: sweepResult.success ? 'var(--green)' : 'var(--red)' }}>
                {sweepResult.success
                  ? `✓ ${sweepResult.updated || 0} application${sweepResult.updated === 1 ? '' : 's'} marked No Response`
                  : `✗ ${sweepResult.error}`}
              </span>
            )}
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ marginBottom: 8 }}>Platforms</label>
          <div style={{ display: 'flex', gap: 16 }}>
            {['Seek', 'Indeed', 'LinkedIn'].map(p => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
                <input type="checkbox" style={{ width: 'auto' }}
                  checked={form[`enable${p}`]}
                  onChange={e => set(`enable${p}`, e.target.checked)} />
                {p}
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {['Seek', 'Indeed', 'LinkedIn'].map(p => (
            <div className="form-group" key={p}>
              <label>Daily Limit — {p}</label>
              <input type="number" min={1} max={50}
                value={form[`dailyLimit${p}`]}
                onChange={e => set(`dailyLimit${p}`, e.target.value)} />
            </div>
          ))}
        </div>
        <div className="form-group">
          <label>Blacklisted Companies</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {(form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean).map(company => (
              <span key={company} className="chip">
                {company}
                <button className="chip-remove" onClick={() => {
                  const list = (form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean).filter(c => c !== company)
                  set('blacklistedCompanies', list.join(', '))
                  window.api.removeBlacklistCompany(company)
                }}>✕</button>
              </span>
            ))}
            {!(form.blacklistedCompanies || '').trim() && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No companies blacklisted</span>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newBlacklist}
              onChange={e => setNewBlacklist(e.target.value)}
              placeholder="Add company to blacklist..."
              onKeyDown={e => {
                if (e.key === 'Enter' && newBlacklist.trim()) {
                  const existing = (form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean)
                  if (!existing.map(c => c.toLowerCase()).includes(newBlacklist.trim().toLowerCase())) {
                    set('blacklistedCompanies', [...existing, newBlacklist.trim()].join(', '))
                  }
                  setNewBlacklist('')
                }
              }}
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }} onClick={() => {
              if (!newBlacklist.trim()) return
              const existing = (form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean)
              if (!existing.map(c => c.toLowerCase()).includes(newBlacklist.trim().toLowerCase())) {
                set('blacklistedCompanies', [...existing, newBlacklist.trim()].join(', '))
              }
              setNewBlacklist('')
            }}>Add</button>
          </div>
        </div>
      </div>

      {/* Resumes */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Resumes <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 13 }}>({(form.resumes || []).length}/5)</span></h3>
          {(form.resumes || []).length < 5 && !addingResume && (
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setAddingResume(true); setNewResumeName(''); setNewResumeText(''); setUploadError('') }}>
              + Add Resume
            </button>
          )}
        </div>

        {(form.resumes || []).length === 0 && !addingResume && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
            No resumes added yet.
          </div>
        )}

        {(form.resumes || []).map(r => (
          <div key={r.id} style={{
            border: `1px solid ${r.id === form.defaultResumeId ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 8, padding: 12, marginBottom: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</span>
                {r.id === form.defaultResumeId && (
                  <span style={{ fontSize: 11, background: 'var(--accent)', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>Default</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {r.id !== form.defaultResumeId && (
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => saveResumes(form.resumes, r.id)}>
                    Set Default
                  </button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  disabled={improvingId === r.id}
                  onClick={async () => {
                    setImprovingId(r.id)
                    const res = await window.api.improveResume(r.text)
                    setImprovingId(null)
                    if (res.success) setImproveModal({ sourceId: r.id, sourceName: r.name, text: res.text })
                  }}>
                  {improvingId === r.id ? 'Improving...' : 'Improve with AI'}
                </button>
                {r.originalExt === 'docx' || r.originalExt === 'doc' ? (<>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    disabled={pdfLoading === r.name + '_docx'}
                    onClick={async () => {
                      setPdfLoading(r.name + '_docx')
                      await window.api.openResumeDocx(r.text, r.originalPath || null)
                      setPdfLoading(false)
                    }}>
                    {pdfLoading === r.name + '_docx' ? 'Opening...' : 'Preview DOCX'}
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => window.api.downloadResume(r.text, r.name, 'docx')}>
                    Save DOCX
                  </button>
                </>) : (<>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    disabled={pdfLoading === r.name}
                    onClick={() => viewPDF(r.text, r.name, r.originalPath, r.originalExt)}>
                    {pdfLoading === r.name ? 'Loading...' : 'View PDF'}
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => window.api.downloadResume(r.text, r.name, 'pdf')}>
                    Save PDF
                  </button>
                </>)}
                <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)' }} onClick={() => {
                  const resumes = (form.resumes || []).filter(x => x.id !== r.id)
                  const defaultResumeId = form.defaultResumeId === r.id ? (resumes[0]?.id || '') : form.defaultResumeId
                  saveResumes(resumes, defaultResumeId)
                }}>
                  Delete
                </button>
              </div>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6 }}>
              {r.text.slice(0, 120).replace(/\n/g, ' ')}…
            </div>
          </div>
        ))}

        {addingResume && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12 }}>Name</label>
              <input value={newResumeName} onChange={e => setNewResumeName(e.target.value)} placeholder="e.g. Software Engineer Resume" />
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              {newResumeOriginalPath ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 20 }}>{newResumeOriginalExt === 'pdf' ? '📄' : '📝'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{newResumeName || 'Resume'}.{newResumeOriginalExt}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>File uploaded — AI can tailor this for each job</div>
                  </div>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                    setUploadError('')
                    const res = await window.api.importResumeFile()
                    if (res.canceled) return
                    if (res.success) {
                      setNewResumeText(res.text)
                      if (!newResumeName) setNewResumeName(res.fileName)
                      setNewResumeOriginalPath(res.originalPath || null)
                      setNewResumeOriginalExt(res.originalExt || null)
                    } else { setUploadError(res.error || 'Failed to read file') }
                  }}>Replace</button>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: 12, marginBottom: 0 }}>Resume</label>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                      setUploadError('')
                      const res = await window.api.importResumeFile()
                      if (res.canceled) return
                      if (res.success) {
                        setNewResumeText(res.text)
                        if (!newResumeName) setNewResumeName(res.fileName)
                        setNewResumeOriginalPath(res.originalPath || null)
                        setNewResumeOriginalExt(res.originalExt || null)
                      } else { setUploadError(res.error || 'Failed to read file') }
                    }}>Upload File (PDF / DOCX)</button>
                  </div>
                  <textarea value={newResumeText} onChange={e => setNewResumeText(e.target.value)}
                    placeholder="Paste resume text or upload a file..." style={{ minHeight: 120 }} />
                </>
              )}
              {uploadError && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{uploadError}</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setAddingResume(false); setNewResumeName(''); setNewResumeText(''); setNewResumeOriginalPath(null); setNewResumeOriginalExt(null) }}>Cancel</button>
              <button className="btn btn-primary" style={{ fontSize: 12 }}
                disabled={!newResumeName.trim() || !newResumeText.trim()}
                onClick={() => {
                  const id = Date.now().toString()
                  const resumes = [...(form.resumes || []), { id, name: newResumeName.trim(), text: newResumeText.trim(), originalPath: newResumeOriginalPath, originalExt: newResumeOriginalExt }]
                  const defaultResumeId = form.defaultResumeId || id
                  saveResumes(resumes, defaultResumeId)
                  setAddingResume(false)
                  setNewResumeName(''); setNewResumeText(''); setNewResumeOriginalPath(null); setNewResumeOriginalExt(null)
                }}>
                Save Resume
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resume routing rules — pick a different base resume per job type */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Resume Routing</h3>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}
            disabled={(form.resumes || []).length < 2}
            onClick={() => set('resumeRules', [
              ...(form.resumeRules || []),
              { id: Date.now().toString(), keywords: '', resumeId: form.resumes?.[0]?.id || '' },
            ])}>
            + Add Rule
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
          Route jobs to a different base resume by keyword. The first rule whose keywords
          appear in the job title or description wins; anything unmatched uses your default
          resume. Rules are checked top to bottom.
        </p>

        {(form.resumes || []).length < 2 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Add a second resume above to start routing.
          </p>
        )}

        {(form.resumeRules || []).length === 0 && (form.resumes || []).length >= 2 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            No rules yet — every job uses your default resume.
          </p>
        )}

        {(form.resumeRules || []).map((rule, i) => (
          <div key={rule.id} style={{
            display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8,
            border: '1px solid var(--border)', borderRadius: 8, padding: 10,
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 9, width: 16, flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1 }}>
              <input
                value={rule.keywords}
                placeholder="data, analytics, sql"
                onChange={e => set('resumeRules', (form.resumeRules || []).map(r =>
                  r.id === rule.id ? { ...r, keywords: e.target.value } : r))}
              />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Comma-separated. Matches anywhere in the title or description.
              </div>
            </div>
            <select
              value={rule.resumeId}
              style={{ width: 190, flexShrink: 0 }}
              onChange={e => set('resumeRules', (form.resumeRules || []).map(r =>
                r.id === rule.id ? { ...r, resumeId: e.target.value } : r))}>
              {(form.resumes || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="btn btn-ghost" style={{ fontSize: 11, flexShrink: 0 }}
              onClick={() => set('resumeRules', (form.resumeRules || []).filter(r => r.id !== rule.id))}>
              Remove
            </button>
          </div>
        ))}
      </div>

      {/* Personal Links */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 4, fontSize: 15 }}>Personal Links</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
          Used in resume PDFs as clickable links. Auto-detected from DOCX uploads, or enter manually here. Settings override DOCX-extracted links.
        </p>
        <div className="form-group" style={{ marginBottom: 10 }}>
          <label>Portfolio URL</label>
          <input
            placeholder="https://yourportfolio.com"
            value={(form.personalLinks || {}).portfolio || ''}
            onChange={e => set('personalLinks', { ...(form.personalLinks || {}), portfolio: e.target.value })}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 10 }}>
          <label>GitHub URL</label>
          <input
            placeholder="https://github.com/username"
            value={(form.personalLinks || {}).github || ''}
            onChange={e => set('personalLinks', { ...(form.personalLinks || {}), github: e.target.value })}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>LinkedIn URL</label>
          <input
            placeholder="https://linkedin.com/in/username"
            value={(form.personalLinks || {}).linkedin || ''}
            onChange={e => set('personalLinks', { ...(form.personalLinks || {}), linkedin: e.target.value })}
          />
        </div>
      </div>

      {/* Cover Letter */}
      <div className="card">
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Cover Letter</h3>
        <div className="form-group">
          <label>Tone</label>
          <select value={form.coverLetterTone || 'professional'} onChange={e => set('coverLetterTone', e.target.value)}>
            <option value="professional">Professional (default)</option>
            <option value="casual">Casual &amp; Warm</option>
            <option value="confident">Confident &amp; Direct</option>
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label style={{ marginBottom: 0 }}>Template <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>(optional)</span></label>
            <div style={{ display: 'flex', gap: 6 }}>
            {form.coverLetterTemplate && (
              <button className="btn btn-ghost" style={{ fontSize: 11 }}
                disabled={pdfLoading === 'cl'}
                onClick={async () => {
                  setPdfLoading('cl')
                  const res = await window.api.getCoverLetterPDFBase64(form.coverLetterTemplate)
                  setPdfLoading(false)
                  if (res.success) setPdfModal({ base64: res.base64, title: 'Cover Letter Template' })
                }}>
                {pdfLoading === 'cl' ? 'Loading...' : 'Preview PDF'}
              </button>
            )}
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
              setClUploadError('')
              const res = await window.api.importResumeFile()
              if (res.canceled) return
              if (res.success) set('coverLetterTemplate', res.text)
              else setClUploadError(res.error || 'Failed to read file')
            }}>
              Upload File
            </button>
            </div>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            AI will use this as a structural base. Leave blank for fully AI-generated letters. Supports .txt, .docx, .pdf
          </p>
          <textarea value={form.coverLetterTemplate || ''} onChange={e => set('coverLetterTemplate', e.target.value)}
            placeholder="Leave blank to let AI write freely..." style={{ minHeight: 120, fontSize: 12, fontFamily: 'monospace' }} />
          {clUploadError && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{clUploadError}</div>}
        </div>
      </div>
      </div>} {/* end criteria tab */}

      {settingsTab === 'data' && <div>
        {/* Storage Info */}
        <StorageCard />

        {/* Rotating database backups */}
        <BackupsCard showToast={showToast} />

        {/* Encrypted settings export / import */}
        <SettingsTransferCard showToast={showToast} onImported={() => window.location.reload()} />

        {/* Screening Answer Cache */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ fontSize: 15, margin: 0 }}>Screening Answer Cache</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Answers saved from previous applications. These are reused automatically when the same question appears.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
                const data = await window.api.getCachedAnswers()
                setCachedAnswers(data)
              }}>Load Cache</button>
              {cachedAnswers.length > 0 && (
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={async () => {
                  if (!window.confirm('Delete all cached screening answers? This cannot be undone.')) return
                  await window.api.clearAllCachedAnswers()
                  setCachedAnswers([])
                  showToast?.('Screening cache cleared', 'success')
                }}>Clear All</button>
              )}
            </div>
          </div>

          {cachedAnswers.length > 0 && (
            <>
              <input
                value={cachedSearch}
                onChange={e => setCachedSearch(e.target.value)}
                placeholder="Search questions..."
                style={{ marginBottom: 12, fontSize: 12 }}
              />
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                {cachedAnswers
                  .filter(ca => !cachedSearch || ca.question.toLowerCase().includes(cachedSearch.toLowerCase()) || ca.answer.toLowerCase().includes(cachedSearch.toLowerCase()))
                  .map((ca, i) => (
                    <div key={i} style={{
                      padding: 12, background: 'var(--surface2)', borderRadius: 8,
                      marginBottom: 8, border: '1px solid var(--border)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: 'var(--text)' }}>Q: {ca.question}</div>
                          <textarea
                            defaultValue={ca.answer}
                            onBlur={async (e) => {
                              const newAnswer = e.target.value.trim()
                              if (newAnswer && newAnswer !== ca.answer) {
                                await window.api.updateCachedAnswer(ca.question, newAnswer)
                                setCachedAnswers(prev => prev.map((c, j) => j === i ? { ...c, answer: newAnswer } : c))
                                showToast?.('Answer updated', 'success')
                              }
                            }}
                            style={{ width: '100%', fontSize: 12, minHeight: 40, padding: '6px 8px', resize: 'vertical' }}
                          />
                        </div>
                        <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)', padding: '2px 6px', flexShrink: 0 }}
                          onClick={async () => {
                            await window.api.deleteCachedAnswer(ca.question)
                            setCachedAnswers(prev => prev.filter((_, j) => j !== i))
                          }}>✕</button>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                        Last used: {new Date(ca.updated_at).toLocaleDateString()}
                      </div>
                    </div>
                  ))
                }
              </div>
            </>
          )}

          {cachedAnswers.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              Click "Load Cache" to view saved screening answers.
            </div>
          )}
        </div>

        {/* Data Actions */}
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 16 }}>Data Actions</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>Export Application History</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Download all applications as CSV</div>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => window.api.exportCSV({})}>Export CSV</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--red)' }}>Clear All Application History</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Permanently delete all application records</div>
              </div>
              <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={async () => {
                if (!window.confirm('Delete ALL application history? This cannot be undone.')) return
                await window.api.clearAllApplications()
                showToast?.('Application history cleared', 'success')
              }}>Clear All</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--red)' }}>Clear Needs Attention Queue</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Remove all jobs from the attention queue</div>
              </div>
              <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={async () => {
                if (!window.confirm('Clear all attention jobs? This cannot be undone.')) return
                await window.api.clearAllAttentionJobs()
                showToast?.('Attention queue cleared', 'success')
              }}>Clear All</button>
            </div>
          </div>
        </div>
      </div>}

      {settingsTab === 'automation' && <div>
        {/* Review before submit — the mitigation for this product's core risk:
            a bad tailoring pass reaching ten employers before anyone looks. */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>Review Before Submit</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Draft everything, send nothing. Jobs that clear your match threshold are fully prepared —
            resume tailored, cover letter written — then held on the Review page until you approve them.
            Approving costs no extra AI calls.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!form.reviewBeforeSubmit}
              onChange={e => set('reviewBeforeSubmit', e.target.checked)}
            />
            <span>Hold applications for review instead of submitting automatically</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginTop: 10 }}>
            <input
              type="checkbox"
              checked={!!form.confirmBeforeSubmit}
              onChange={e => set('confirmBeforeSubmit', e.target.checked)}
            />
            <span>Show me the screening answers before each one is sent</span>
          </label>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, marginLeft: 28 }}>
            Screening answers are written while the employer’s form is being filled in, so they cannot
            be shown on the Review page — there is nothing to show until then. With this on, approving
            pauses at the last step and asks. Only applies to submissions you start; a scheduled scan
            never waits on it.
          </p>

          {form.reviewBeforeSubmit && (
            <div className="form-group" style={{ marginTop: 14 }}>
              <label>Auto-submit jobs scoring at least (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                placeholder="Leave empty to review everything"
                value={form.autoSubmitThreshold ?? ''}
                onChange={e => {
                  const raw = e.target.value.trim()
                  if (raw === '') return set('autoSubmitThreshold', null)
                  const n = Number(raw)
                  set('autoSubmitThreshold', Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null)
                }}
              />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                {form.autoSubmitThreshold == null
                  ? 'Empty — every draft waits for your approval.'
                  : <>Jobs at <strong>{form.autoSubmitThreshold}%</strong> or above are sent without review. Anything
                     lower, or a job that could not be scored, still waits for you.</>}
              </p>
            </div>
          )}
        </div>

        {/* AI budget & reliability */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>AI Budget &amp; Reliability</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Each scanned job costs several model calls. The cap is checked before every call, so it
            stops work rather than reporting an overrun after the money is spent. See the Analytics
            page for what you have actually used.
          </p>
          <div className="form-group">
            <label>Monthly spend cap (USD)</label>
            <input
              type="number" min="0" step="1"
              value={form.aiMonthlyBudgetUsd ?? 0}
              onChange={e => set('aiMonthlyBudgetUsd', Number(e.target.value) || 0)}
            />
            <small style={{ color: 'var(--text-muted)' }}>0 disables the cap. Costs are estimated from published token prices.</small>
          </div>
          <div className="form-group">
            <label>Retries on a failed AI call</label>
            <input
              type="number" min="0" max="6"
              value={form.aiMaxRetries ?? 3}
              onChange={e => set('aiMaxRetries', Math.max(0, Math.min(6, Number(e.target.value) || 0)))}
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Retried with exponential backoff. A job that still can't be scored is left unsaved and
              retried on the next scan, rather than recorded with a guessed score.
            </small>
          </div>
        </div>

        {/* Company career boards */}
        <AtsBoards form={form} set={set} showToast={showToast} />

        {/* Background operation */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>Background Operation</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Scheduled scans, inbox checks, follow-ups and the stale sweep only run while Hiro is
            running. With these on, closing the window keeps it working in the tray instead of quitting.
          </p>
          {[
            { key: 'minimizeToTray', label: 'Keep running in the tray when the window is closed' },
            { key: 'launchOnLogin', label: 'Start Hiro when I log in' },
            { key: 'startMinimised', label: 'Start minimised to the tray' },
          ].map(opt => (
            <label key={opt.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" checked={!!form[opt.key]} onChange={e => set(opt.key, e.target.checked)} />
              <span>{opt.label}</span>
            </label>
          ))}
          <small style={{ color: 'var(--text-muted)' }}>
            Launch-on-login applies to the installed app only — it has no effect in a development run.
          </small>
        </div>

        {/* Recruiter contact extraction */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>Recruiter Contact</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Auto follow-up needs an address to write to. With this on, Hiro reads one out of the job ad
            and out of any recruiter reply. Platform, no-reply and placeholder addresses are ignored,
            and an ambiguous ad yields nothing rather than a guess — you can always set it by hand in
            the job detail panel.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.extractRecruiterEmail !== false}
              onChange={e => set('extractRecruiterEmail', e.target.checked)}
            />
            <span>Find a follow-up address automatically</span>
          </label>
        </div>

        {/* Updates */}
        <UpdatePanel form={form} set={set} showToast={showToast} />
      </div>}

      {settingsTab === 'about' && <div>
        {/* About */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <HiroLogo size={48} style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>Hiro</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Version 1.0.0</div>
            </div>
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text-muted)', marginBottom: 16 }}>
            Hiro is an AI-powered desktop app that automatically finds and applies to jobs for you. It scrapes Seek, Indeed, and LinkedIn on a schedule, uses AI to score each job against your resume, tailors your application, and submits — all while you sleep.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[
              { label: 'Desktop', value: 'Electron' },
              { label: 'Frontend', value: 'React + Vite' },
              { label: 'Database', value: 'SQLite (sql.js)' },
              { label: 'Scraping', value: 'Playwright' },
              { label: 'Scheduling', value: 'node-cron' },
              { label: 'AI', value: 'Claude / GPT / DeepSeek / Gemini' },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Privacy Policy */}
        <div className="card">
          <h3 style={{ marginBottom: 16, fontSize: 15 }}>Privacy Policy</h3>
          {[
            {
              title: 'Local-only data storage',
              body: 'All your data — config, resume text, application history, session cookies — is stored exclusively on your local machine under ~/.hiro/. Nothing is uploaded to any Hiro server.',
            },
            {
              title: 'AI API calls',
              body: 'When AI features are used (resume tailoring, cover letter generation, match scoring, etc.), your resume text and job descriptions are sent to the AI provider you configured (Anthropic, OpenAI, DeepSeek, or Google). This is governed by that provider\'s own privacy policy. Hiro does not store or forward this data.',
            },
            {
              title: 'Job platforms',
              body: 'Hiro interacts with Seek, Indeed, and LinkedIn on your behalf using your saved session. Your credentials are never stored by Hiro — only the browser session state (cookies) needed to stay logged in.',
            },
            {
              title: 'Email notifications',
              body: 'If you configure Gmail notifications, your Gmail address and App Password are stored locally in your config file. Emails are sent directly via Gmail SMTP — no third-party relay is involved.',
            },
            {
              title: 'No telemetry',
              body: 'Hiro collects no analytics, crash reports, or usage data of any kind. The app operates entirely offline except for the AI API calls and job platform interactions you explicitly trigger.',
            },
          ].map(({ title, body }) => (
            <div key={title} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{title}</div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, margin: 0 }}>{body}</p>
            </div>
          ))}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Last updated: March 2026
          </p>
        </div>
      </div>} {/* end about tab */}

      {pdfModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }} onClick={() => setPdfModal(null)} onKeyDown={e => { if (e.key === 'Escape') setPdfModal(null) }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: '82vw', height: '92vh', display: 'flex', flexDirection: 'column',
            background: 'var(--surface)', borderRadius: 12, overflow: 'hidden',
            boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{pdfModal.title}</span>
              <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setPdfModal(null)}>✕ Close</button>
            </div>
            <iframe
              src={`data:application/pdf;base64,${pdfModal.base64}`}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title={pdfModal.title}
            />
          </div>
        </div>
      )}

      {improveModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }} onClick={() => setImproveModal(null)} onKeyDown={e => { if (e.key === 'Escape') setImproveModal(null) }}>
          <div className="card" style={{ width: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 17 }}>AI-Improved Resume</h2>
              <button className="btn btn-ghost" onClick={() => setImproveModal(null)}>✕</button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
              Review the improved version below. Replace the original or save as a new resume.
            </p>
            <textarea
              value={improveModal.text}
              onChange={e => setImproveModal(m => ({ ...m, text: e.target.value }))}
              style={{ flex: 1, minHeight: 340, marginBottom: 16, fontFamily: 'monospace', fontSize: 12 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setImproveModal(null)}>Cancel</button>
              {(form.resumes || []).length < 5 && (
                <button className="btn btn-ghost" onClick={() => {
                  const id = Date.now().toString()
                  const source = (form.resumes || []).find(r => r.id === improveModal.sourceId)
                  const resumes = [...(form.resumes || []), { id, name: `${improveModal.sourceName} (Improved)`, text: improveModal.text, originalExt: source?.originalExt || null, originalPath: source?.originalPath || null }]
                  saveResumes(resumes, form.defaultResumeId)
                  setImproveModal(null)
                }}>
                  Save as New
                </button>
              )}
              <button className="btn btn-primary" onClick={() => {
                const resumes = (form.resumes || []).map(r => {
                  if (r.id !== improveModal.sourceId) return r
                  // For PDF originals, the old file no longer reflects improved text — clear it so View PDF regenerates
                  const keepOriginal = r.originalExt === 'docx' || r.originalExt === 'doc'
                  return { ...r, text: improveModal.text, originalPath: keepOriginal ? r.originalPath : null, originalExt: keepOriginal ? r.originalExt : null }
                })
                saveResumes(resumes, form.defaultResumeId)
                setImproveModal(null)
              }}>
                Replace Original
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
