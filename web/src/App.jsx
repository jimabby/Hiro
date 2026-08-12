import { useState, useEffect, useCallback } from 'react'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import Pipeline from './pages/Pipeline'
import NeedsAttention from './pages/NeedsAttention'
import Review from './pages/Review'
import Settings from './pages/Settings'
import Timeline from './pages/Timeline'
import Analytics from './pages/Analytics'
import Workbench from './pages/Workbench'
import HiroLogo from './components/HiroLogo'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', shortcut: '1' },
  // Sits second because it is the page with work on it: what is owed and when,
  // rather than what already happened.
  { id: 'pipeline', label: 'Pipeline', icon: '≡', shortcut: '2' },
  { id: 'review', label: 'Review', icon: '◇', shortcut: '3' },
  { id: 'attention', label: 'Needs Attention', icon: '⚑', shortcut: '4' },
  { id: 'timeline', label: 'Timeline', icon: '◷', shortcut: '5' },
  { id: 'analytics', label: 'Analytics', icon: '◔', shortcut: '6' },
  { id: 'settings', label: 'Settings', icon: '⚙', shortcut: '7' },
  { id: 'workbench', label: 'Workbench', icon: '+', shortcut: '8' },
]

export default function App() {
  const [page, setPage] = useState('dashboard')
  // Set when another page asks the Dashboard to open a specific application.
  const [focusApp, setFocusApp] = useState(null)
  const [setupDone, setSetupDone] = useState(null)
  // Three states, not two. 'system' follows the OS appearance setting and is the
  // default for a fresh install — an app that opens dark on a machine set to
  // light looks broken before it has done anything. An explicit choice sticks.
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system')

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const resolve = () => (theme === 'system' ? (media.matches ? 'dark' : 'light') : theme)
    const paint = () => document.documentElement.setAttribute('data-theme', resolve())
    paint()
    localStorage.setItem('theme', theme)
    if (theme !== 'system') return
    // Following the OS means following it live, not only at startup.
    media.addEventListener('change', paint)
    return () => media.removeEventListener('change', paint)
  }, [theme])
  const [attentionCount, setAttentionCount] = useState(0)
  const [heldCount, setHeldCount] = useState(0)
  const [todayCount, setTodayCount] = useState(0)
  const [update, setUpdate] = useState(null)
  // A queue rather than a single slot: a scan can finish, a device can sign in
  // and an update can land within the same second, and the old single-toast
  // state silently dropped everything but the last one.
  const [toasts, setToasts] = useState([])
  const [logs, setLogs] = useState([])
  const [scanRunning, setScanRunning] = useState(false)
  const [resumeModal, setResumeModal] = useState(false)
  const [resumeUploading, setResumeUploading] = useState(false)
  const [question, setQuestion] = useState(null)
  const [questionAnswer, setQuestionAnswer] = useState('')
  // Final checkpoint before an approved draft reaches an employer.
  const [submitReview, setSubmitReview] = useState(null)
  const [scanMode, setScanMode] = useState('real') // 'real' | 'dry' — used by the resume-required flow

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const showToast = useCallback((msg, type = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Errors stay put until dismissed. A failed scan reported for four seconds
    // while the user was in another window is a failure they never saw.
    setToasts(prev => [...prev.slice(-3), { id, msg, type }])
    if (type !== 'error') setTimeout(() => dismissToast(id), 4500)
  }, [dismissToast])

  useEffect(() => {
    window.api.getConfig().then(cfg => setSetupDone(cfg.setupComplete))

    window.api.getStats().then(s => {
      setAttentionCount(s.attentionCount || 0)
      setHeldCount((s.heldCount || 0) + (s.followUpReviewCount || 0))
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
      // A device attaching itself to the cloud account is a security event, so it
      // is raised here rather than left in the activity log for nobody to read.
      if (data.type === 'new-device') {
        showToast(
          `New device signed in: ${data.device?.name || 'unknown device'} (${data.device?.platform || data.device?.kind || '?'}). `
          + 'Check Settings → Cloud Sync if this was not you.',
          'error'
        )
      }
      if (data.type === 'contact-reminder') {
        showToast(`Follow up with ${data.contact?.name || data.contact?.email || 'contact'} — due ${data.contact?.next_action_at}`, 'info')
      }
      if (data.type === 'backup-drill' && data.report?.success === false) {
        showToast(data.report.error || `${data.report.failed} backup recovery check(s) failed`, 'error')
      }
      if (data.type === 'scan-complete') {
        setScanRunning(false)
        window.api.getStats().then(s => {
          setAttentionCount(s.attentionCount || 0)
          setHeldCount((s.heldCount || 0) + (s.followUpReviewCount || 0))
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
        // A platform Hiro paused itself is worth saying, but it is the system
        // working — informational, and ranked below anything the user must act on.
        else if (data.paused?.length) {
          showToast(`Scan complete — ${data.paused.map(p => p.platform).join(', ')} paused by automation health`, 'info')
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

    window.api.onSubmitReview?.((payload) => setSubmitReview(payload))

    return () => {
      window.api.removeAllListeners('notification')
      window.api.removeAllListeners('automation:log')
      window.api.removeAllListeners('question:ask')
      window.api.removeAllListeners('submit:review')
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
  const modalOpen = !!(question || submitReview || resumeModal)
  useEffect(() => {
    function handleGlobalKey(e) {
      // Don't fire when typing in inputs
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return
      // Nor while a modal owns the screen — switching the page behind a
      // blocking question left the app showing a tab the user can't reach.
      if (modalOpen) return
      // Ctrl/Cmd/Alt+number belong to the OS and to Electron's own menu
      // accelerators; only a bare digit is ours.
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= NAV.length) {
        setPage(NAV[num - 1].id)
      }
    }
    window.addEventListener('keydown', handleGlobalKey)
    return () => window.removeEventListener('keydown', handleGlobalKey)
  }, [modalOpen])

  // Escape closes the resume prompt. The question and submit-confirmation
  // modals are deliberately excluded: both have an apply flow blocked on an
  // answer, and dismissing one by reflex would silently decline it.
  useEffect(() => {
    if (!resumeModal) return
    function onEsc(e) { if (e.key === 'Escape' && !resumeUploading) setResumeModal(false) }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [resumeModal, resumeUploading])

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
    dashboard: <Dashboard active={page === 'dashboard'} logs={logs} scanRunning={scanRunning} onScanStart={() => beginScan('real')} onDryRun={() => beginScan('dry')} onClearLogs={handleClearLogs} showToast={showToast} focusApplicationId={focusApp} onFocusHandled={() => setFocusApp(null)} />,
    // Clicking a card on the board opens that application on the Dashboard —
    // where the whole detail view already lives — rather than duplicating it.
    pipeline: <Pipeline active={page === 'pipeline'} onOpenApplication={(id) => { setFocusApp(id); setPage('dashboard') }} />,
    review: <Review active={page === 'review'} onCountChange={setHeldCount} showToast={showToast} />,
    attention: <NeedsAttention onCountChange={setAttentionCount} showToast={showToast} />,
    timeline: <Timeline />,
    analytics: <Analytics active={page === 'analytics'} />,
    workbench: <Workbench active={page === 'workbench'} showToast={showToast} />,
    settings: <Settings active={page === 'settings'} showToast={showToast} />,
  }

  const badgeFor = (id) => (id === 'attention' ? attentionCount : id === 'review' ? heldCount : 0)

  return (
    // The data-testid attributes on the shell and the nav are the only stable
    // hooks the app exposes: every style here is inline, so a test that selected
    // on class names or DOM shape would break on any visual change. Used by the
    // renderer tests and by the packaged smoke test (web/test/smoke).
    <div data-testid="app-shell" style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <nav data-testid="nav" style={{
        width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', padding: '20px 12px', gap: 2, flexShrink: 0,
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 20px' }}>
          <HiroLogo size={28} />
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>Hiro</span>
        </div>

        {NAV.map(n => {
          const count = badgeFor(n.id)
          return (
            <button
              key={n.id}
              data-testid={`nav-${n.id}`}
              onClick={() => setPage(n.id)}
              aria-current={page === n.id ? 'page' : undefined}
              title={`${n.label} — press ${n.shortcut}`}
              className={`nav-item${page === n.id ? ' nav-item-active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">{n.icon}</span>
              <span style={{ flex: 1 }}>{n.label}</span>
              {count > 0 && (
                <span
                  // Review is a queue waiting on the user, not a problem — the
                  // accent colour rather than the red used for jobs that failed.
                  aria-label={`${count} ${n.id === 'review' ? 'awaiting review' : 'needing attention'}`}
                  style={{
                    background: n.id === 'review' ? 'var(--accent)' : 'var(--red)', color: '#fff', borderRadius: 10,
                    fontSize: 10, padding: '1px 6px', fontWeight: 700, minWidth: 18, textAlign: 'center',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >{count}</span>
              )}
              <span className="kbd" aria-hidden="true">{n.shortcut}</span>
            </button>
          )
        })}

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
          {/* Three-way, because "follow the system" is a real preference and a
              two-state toggle cannot express it. */}
          <div role="group" aria-label="Colour theme" style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2,
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 2,
          }}>
            {[
              { id: 'light', icon: '☀', label: 'Light' },
              { id: 'dark', icon: '☾', label: 'Dark' },
              { id: 'system', icon: '◐', label: 'System' },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => setTheme(opt.id)}
                aria-pressed={theme === opt.id}
                title={`${opt.label} theme`}
                style={{
                  background: theme === opt.id ? 'var(--surface)' : 'transparent',
                  border: 'none', borderRadius: 6, padding: '5px 0',
                  color: theme === opt.id ? 'var(--text)' : 'var(--text-faint)',
                  cursor: 'pointer', fontSize: 12, lineHeight: 1.2,
                  fontWeight: theme === opt.id ? 600 : 400,
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                <span aria-hidden="true">{opt.icon}</span>
                <span style={{
                  position: 'absolute', width: 1, height: 1,
                  overflow: 'hidden', clip: 'rect(0 0 0 0)',
                }}>{opt.label}</span>
              </button>
            ))}
          </div>
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

      {/* Toast notifications. Newest sits closest to the corner (the stack is
          column-reverse), errors persist until dismissed. */}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-icon" aria-hidden="true">
              {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}
            </span>
            <span className="toast-msg">{t.msg}</span>
            <button className="toast-close" aria-label="Dismiss notification"
              onClick={() => dismissToast(t.id)}>×</button>
          </div>
        ))}
      </div>

      {/* Resume required modal */}
      {resumeModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="resume-modal-title"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
          }}>
          <div className="card modal-content" style={{ width: 420 }}>
            <h2 id="resume-modal-title" style={{ fontSize: 18, marginBottom: 8 }}>Resume Required</h2>
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

      {/* Final submission check. The browser is sitting on the employer's
          review step with the form filled in; nothing is sent until this is
          answered, and closing the app or walking away counts as "no". */}
      {submitReview && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="submit-review-title" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 310, padding: 24,
        }}>
          <div className="card modal-content" style={{ width: 620, maxHeight: '85vh', overflowY: 'auto' }}>
            <h2 id="submit-review-title" style={{ fontSize: 16, marginBottom: 8 }}>Send this application?</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
              The form is filled in and one click from being submitted
              {submitReview.platform ? ` on ${submitReview.platform}` : ''}. These are the answers that
              will go with it.
            </p>

            {submitReview.screeningQa?.length > 0 ? (
              <div style={{ marginBottom: 14 }}>
                {submitReview.screeningQa.map((qa, i) => (
                  <div key={i} style={{
                    padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8,
                    marginBottom: 8, fontSize: 13, borderLeft: '3px solid var(--accent)',
                  }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 4 }}>{qa.question}</div>
                    <div>
                      {qa.answer}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · answered by {qa.source}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 13, marginBottom: 14 }}>
                This application had no screening questions.
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => {
                window.api.sendSubmitConfirm({ id: submitReview.id, approved: false })
                setSubmitReview(null)
                showToast('Not sent — the draft is still held for review', 'info')
              }}>Don’t send</button>
              <button className="btn btn-primary" onClick={() => {
                window.api.sendSubmitConfirm({ id: submitReview.id, approved: true })
                setSubmitReview(null)
              }}>Send application</button>
            </div>
          </div>
        </div>
      )}

      {/* Screening question modal — shown mid-apply when AI is unsure */}
      {question && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="question-modal-title" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }}>
          <div className="card modal-content" style={{ width: 500 }}>
            <h2 id="question-modal-title" style={{ fontSize: 16, marginBottom: 8 }}>Application Question</h2>
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
