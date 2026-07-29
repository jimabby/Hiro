import { useState, useEffect, useCallback } from 'react'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import NeedsAttention from './pages/NeedsAttention'
import Review from './pages/Review'
import Settings from './pages/Settings'
import Timeline from './pages/Timeline'
import Analytics from './pages/Analytics'
import HiroLogo from './components/HiroLogo'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', shortcut: '1' },
  { id: 'review', label: 'Review', icon: '◇', shortcut: '2' },
  { id: 'attention', label: 'Needs Attention', icon: '⚑', shortcut: '3' },
  { id: 'timeline', label: 'Timeline', icon: '◷', shortcut: '4' },
  { id: 'analytics', label: 'Analytics', icon: '◔', shortcut: '5' },
  { id: 'settings', label: 'Settings', icon: '⚙', shortcut: '6' },
]

export default function App() {
  const [page, setPage] = useState('dashboard')
  const [setupDone, setSetupDone] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])
  const [attentionCount, setAttentionCount] = useState(0)
  const [heldCount, setHeldCount] = useState(0)
  const [todayCount, setTodayCount] = useState(0)
  const [update, setUpdate] = useState(null)
  const [toast, setToast] = useState(null)
  const [logs, setLogs] = useState([])
  const [scanRunning, setScanRunning] = useState(false)
  const [resumeModal, setResumeModal] = useState(false)
  const [resumeUploading, setResumeUploading] = useState(false)
  const [question, setQuestion] = useState(null)
  const [questionAnswer, setQuestionAnswer] = useState('')
  const [scanMode, setScanMode] = useState('real') // 'real' | 'dry' — used by the resume-required flow

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }, [])

  useEffect(() => {
    window.api.getConfig().then(cfg => setSetupDone(cfg.setupComplete))

    window.api.getStats().then(s => {
      setAttentionCount(s.attentionCount || 0)
      setHeldCount(s.heldCount || 0)
      setTodayCount(s.totalToday || 0)
    })

    // A config file that failed to parse used to look exactly like a first run
    // — every setting gone with no explanation. Say what happened.
    window.api.getConfigLoadError?.().then(err => {
      if (err) showToast(err, 'error')
    }).catch(() => {})

    // Update availability, pushed from the main process as it changes.
    window.api.getUpdateStatus?.().then(setUpdate).catch(() => {})
    window.api.onUpdateStatus?.(setUpdate)

    // Seed the activity log from the persisted file so it survives a restart.
    window.api.getRecentLogs?.().then(lines => {
      if (Array.isArray(lines) && lines.length) setLogs(lines)
    })

    window.api.onNotification((data) => {
      if (data.type === 'attention') {
        setAttentionCount(c => c + 1)
        showToast(`New job needs attention: ${data.job?.job_title}`, 'info')
      }
      if (data.type === 'scan-complete') {
        setScanRunning(false)
        window.api.getStats().then(s => {
          setAttentionCount(s.attentionCount || 0)
          setHeldCount(s.heldCount || 0)
          setTodayCount(s.totalToday || 0)
        })
        // A scan that died partway used to report "Scan complete" like any
        // other — the error now rides along on the event.
        if (data.error) showToast(`Scan failed: ${data.error}`, 'error')
        // A platform that refused to serve results isn't a failure, but it
        // isn't a clean run either — say so rather than reporting success over
        // results that are missing. The dashboard banner has the detail.
        else if (data.blocked?.length) {
          showToast(`Scan complete — blocked on ${data.blocked.map(b => b.platform).join(', ')}`, 'error')
        }
        // Jobs the AI couldn't score weren't saved and will be retried. Saying
        // "Scan complete" over that would read as "nothing was worth applying to".
        else if (data.scoringFailures > 0) {
          showToast(`Scan complete — ${data.scoringFailures} job${data.scoringFailures === 1 ? '' : 's'} could not be scored and will be retried`, 'error')
        }
        else if (data.held > 0) {
          showToast(`${data.held} application${data.held === 1 ? '' : 's'} drafted and waiting in Review — nothing was sent`, 'info')
        }
        else showToast('Scan complete', 'success')
      }
    })

    window.api.onAutomationLog((msg) => {
      setLogs(prev => [...prev.slice(-200), msg])
      if (msg.includes('Starting')) setScanRunning(true)
    })

    window.api.onQuestionAsk((q) => {
      // Payload is { id, question } (id routes the answer back to the right
      // apply flow); tolerate a plain string from an older main process.
      setQuestion(typeof q === 'string' ? { id: null, question: q } : q)
      setQuestionAnswer('')
    })

    return () => {
      window.api.removeAllListeners('notification')
      window.api.removeAllListeners('automation:log')
      window.api.removeAllListeners('question:ask')
      window.api.removeAllListeners('update:status')
    }
  }, [showToast])

  // Safety net: while the UI thinks a scan is running, poll the main process
  // and clear the spinner if it disagrees (e.g. a missed scan-complete event).
  useEffect(() => {
    if (!scanRunning) return
    const t = setInterval(async () => {
      try {
        const status = await window.api.getAutomationStatus()
        if (status && !status.running) setScanRunning(false)
      } catch { /* main busy — try again next tick */ }
    }, 5000)
    return () => clearInterval(t)
  }, [scanRunning])

  // Global keyboard shortcuts for nav
  useEffect(() => {
    function handleGlobalKey(e) {
      // Don't fire when typing in inputs
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return

      const num = parseInt(e.key)
      if (num >= 1 && num <= NAV.length) {
        setPage(NAV[num - 1].id)
      }
    }
    window.addEventListener('keydown', handleGlobalKey)
    return () => window.removeEventListener('keydown', handleGlobalKey)
  }, [])

  if (setupDone === null) return null // loading

  if (!setupDone) {
    return <Setup onComplete={() => setSetupDone(true)} />
  }

  async function startScanIpc(mode) {
    // If the scan can't start (already running, setup incomplete, IPC error),
    // reset the spinner — otherwise "Scanning…" would be stuck until restart.
    try {
      const res = mode === 'dry' ? await window.api.startDryRun() : await window.api.startAutomation()
      if (res && res.success === false) {
        setScanRunning(false)
        showToast(res.error || 'Could not start scan', 'error')
      }
    } catch (err) {
      setScanRunning(false)
      showToast(`Could not start scan: ${err.message}`, 'error')
    }
  }

  async function beginScan(mode = 'real') {
    const cfg = await window.api.getConfig()
    const hasResume = (cfg.resumes || []).length > 0 || cfg.masterResume
    if (!hasResume) {
      setScanMode(mode)
      setResumeModal(true)
      return
    }
    setScanRunning(true)
    startScanIpc(mode)
  }

  function handleClearLogs() {
    window.api.clearLogs?.()
    setLogs([])
  }

  async function handleResumeUpload() {
    setResumeUploading(true)
    const res = await window.api.importResumeFile()
    setResumeUploading(false)
    if (res.canceled || !res.success) return
    const cfg = await window.api.getConfig()
    const id = Date.now().toString()
    const newResume = { id, name: res.fileName || 'My Resume', text: res.text, originalPath: res.originalPath, originalExt: res.originalExt }
    const resumes = [...(cfg.resumes || []), newResume]
    await window.api.saveConfig({ ...cfg, resumes, defaultResumeId: cfg.defaultResumeId || id })
    setResumeModal(false)
    setScanRunning(true)
    startScanIpc(scanMode)
  }

  const pages = {
    dashboard: <Dashboard active={page === 'dashboard'} logs={logs} scanRunning={scanRunning} onScanStart={() => beginScan('real')} onDryRun={() => beginScan('dry')} onClearLogs={handleClearLogs} showToast={showToast} />,
    review: <Review active={page === 'review'} onCountChange={setHeldCount} showToast={showToast} />,
    attention: <NeedsAttention onCountChange={setAttentionCount} showToast={showToast} />,
    timeline: <Timeline />,
    analytics: <Analytics active={page === 'analytics'} />,
    settings: <Settings active={page === 'settings'} showToast={showToast} />,
  }

  const badgeFor = (id) => (id === 'attention' ? attentionCount : id === 'review' ? heldCount : 0)

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <nav style={{
        width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', padding: '20px 12px', gap: 2, flexShrink: 0,
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 20px' }}>
          <HiroLogo size={28} />
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>Hiro</span>
        </div>

        {NAV.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            background: page === n.id ? 'var(--surface2)' : 'transparent',
            border: 'none', color: page === n.id ? 'var(--text)' : 'var(--text-muted)',
            padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
            textAlign: 'left', fontSize: 13, display: 'flex', alignItems: 'center',
            gap: 10, fontWeight: page === n.id ? 600 : 400,
            transition: 'all 0.15s',
          }}>
            <span style={{ fontSize: 15, width: 20, textAlign: 'center', opacity: page === n.id ? 1 : 0.6 }}>{n.icon}</span>
            <span style={{ flex: 1 }}>{n.label}</span>
            {badgeFor(n.id) > 0 && (
              <span style={{
                // Review is a queue waiting on the user, not a problem — amber
                // rather than the red used for jobs that failed to apply.
                background: n.id === 'review' ? 'var(--accent)' : 'var(--red)', color: '#fff', borderRadius: 10,
                fontSize: 10, padding: '1px 6px', fontWeight: 700, minWidth: 18, textAlign: 'center',
              }}>{badgeFor(n.id)}</span>
            )}
            <span className="kbd">{n.shortcut}</span>
          </button>
        ))}

        <div style={{ marginTop: 'auto', padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Quick stats */}
          <div style={{
            background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Today</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{todayCount} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>applied</span></div>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: scanRunning ? 'var(--green)' : 'var(--text-muted)', fontSize: 12,
          }}>
            <span className={scanRunning ? 'pulse' : ''} style={{
              width: 7, height: 7, borderRadius: '50%',
              background: scanRunning ? 'var(--green)' : 'var(--border)',
              flexShrink: 0,
            }} />
            {scanRunning ? 'Scanning...' : 'Idle'}
          </div>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-muted)', borderRadius: 8, padding: '6px 10px',
              cursor: 'pointer', fontSize: 12, textAlign: 'left',
              transition: 'all 0.15s',
            }}
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </nav>

      {/* Main content — all pages stay mounted so background tasks (AI improve) survive tab switches */}
      <main style={{ flex: 1, overflow: 'auto', padding: 28, transition: 'background 0.3s ease' }}>
        {/* Update banner. Downloading and installing are both explicit — an
            update that restarted the app mid-scan would abandon a
            half-submitted application. */}
        {update?.updateAvailable && (
          <div className="card" style={{
            marginBottom: 20, display: 'flex', alignItems: 'center', gap: 14,
            borderLeft: '3px solid var(--accent)',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Hiro {update.version} is available
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · you have {update.currentVersion}</span>
              </div>
              {update.downloading && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Downloading… {update.progress}%
                </div>
              )}
              {update.error && (
                <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{update.error}</div>
              )}
            </div>
            {update.downloaded ? (
              <button className="btn btn-primary" onClick={async () => {
                const res = await window.api.installUpdate()
                if (!res?.success) showToast(res?.error || 'Could not install', 'error')
              }}>Restart & install</button>
            ) : (
              <button className="btn btn-primary" disabled={update.downloading} onClick={async () => {
                const res = await window.api.downloadUpdate()
                if (!res?.success) showToast(res?.error || 'Could not download', 'error')
              }}>{update.downloading ? 'Downloading…' : 'Download'}</button>
            )}
          </div>
        )}

        {Object.entries(pages).map(([key, component]) => (
          <div key={key} style={{ display: key === page ? 'block' : 'none' }}>
            {component}
          </div>
        ))}
      </main>

      {/* Toast notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <span style={{ fontSize: 15 }}>
            {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✗' : 'ℹ'}
          </span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Resume required modal */}
      {resumeModal && (
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div className="card modal-content" style={{ width: 420 }}>
            <h2 style={{ fontSize: 18, marginBottom: 8 }}>Resume Required</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
              A resume is needed to match and apply to jobs. Upload yours to start scanning.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setResumeModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleResumeUpload} disabled={resumeUploading}>
                {resumeUploading ? 'Uploading...' : 'Upload Resume'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Screening question modal — shown mid-apply when AI is unsure */}
      {question && (
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }}>
          <div className="card modal-content" style={{ width: 500 }}>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Application Question</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
              The AI couldn't confidently answer this. Your answer will be saved for future applications.
            </p>
            <div style={{
              padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8,
              marginBottom: 14, fontSize: 14, borderLeft: '3px solid var(--accent)',
            }}>
              {question.question}
            </div>
            <textarea
              autoFocus
              value={questionAnswer}
              onChange={e => setQuestionAnswer(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  window.api.sendQuestionAnswer({ id: question.id, answer: questionAnswer })
                  setQuestion(null)
                }
              }}
              placeholder="Type your answer... (Ctrl+Enter to submit)"
              style={{
                width: '100%', minHeight: 80, resize: 'vertical',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 12px', color: 'var(--text)',
                fontSize: 13, marginBottom: 14, boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => {
                window.api.sendQuestionAnswer({ id: question.id, answer: '' })
                setQuestion(null)
              }}>Skip</button>
              <button className="btn btn-primary" onClick={() => {
                window.api.sendQuestionAnswer({ id: question.id, answer: questionAnswer })
                setQuestion(null)
              }}>Submit Answer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
