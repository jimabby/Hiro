import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import HiroLogo from './components/HiroLogo'

// Every page except the two that are needed immediately is its own chunk.
//
// The renderer shipped as a single 440 KB bundle, all ten pages parsed and
// evaluated before the first frame — including Settings, which is by some
// distance the largest and is opened least often. Dashboard is the landing page
// and Setup gates the whole app, so both stay in the main bundle; the rest load
// the first time they are opened.
//
// This does NOT change the "pages stay mounted" property that several effects in
// this app rely on (see the note on the Dashboard's scan-info effect). A page
// enters `mounted` the first time it is visited and never leaves — so its state,
// its scroll position and its subscriptions survive navigation exactly as they
// did before. The only thing that changed is that a page you have never opened
// costs nothing.
const Pipeline = lazy(() => import('./pages/Pipeline'))
const NeedsAttention = lazy(() => import('./pages/NeedsAttention'))
const Review = lazy(() => import('./pages/Review'))
const Settings = lazy(() => import('./pages/Settings'))
const Timeline = lazy(() => import('./pages/Timeline'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Workbench = lazy(() => import('./pages/Workbench'))
const Offers = lazy(() => import('./pages/Offers'))
import useModalFocus from './hooks/useModalFocus'
import ErrorBoundary from './components/ErrorBoundary'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', shortcut: '1' },
  // Sits second because it is the page with work on it: what is owed and when,
  // rather than what already happened.
  { id: 'pipeline', label: 'Pipeline', icon: '≡', shortcut: '2' },
  // Sits directly after Pipeline: it is the other page with a decision on it,
  // and the one with a deadline attached to that decision.
  { id: 'offers', label: 'Offers', icon: '★', shortcut: '3' },
  { id: 'review', label: 'Review', icon: '◇', shortcut: '4' },
  { id: 'attention', label: 'Needs Attention', icon: '⚑', shortcut: '5' },
  { id: 'timeline', label: 'Timeline', icon: '◷', shortcut: '6' },
  { id: 'analytics', label: 'Analytics', icon: '◔', shortcut: '7' },
  { id: 'settings', label: 'Settings', icon: '⚙', shortcut: '8' },
  { id: 'workbench', label: 'Workbench', icon: '+', shortcut: '9' },
]

export default function App() {
  // Traps and restores focus for every aria-modal dialog in the app, wherever
  // it is declared. Mounted here because App outlives every page.
  useModalFocus()

  const [page, setPage] = useState('dashboard')
  // Which pages have been opened at least once. A page enters this set and never
  // leaves, so it stays mounted for the rest of the session — the behaviour the
  // rest of the app assumes — while one that has never been opened is never
  // loaded at all. See the lazy() imports above.
  const [mounted, setMounted] = useState(() => new Set(['dashboard']))
  useEffect(() => {
    setMounted(prev => (prev.has(page) ? prev : new Set(prev).add(page)))
  }, [page])
  // Every page is rendered into this one scrolling column and merely hidden
  // when inactive, so there is a single shared scroll offset. Without resetting
  // it, switching from a scrolled-down Dashboard to a shorter page lands you
  // partway down that page — or, when the new page is shorter than the offset,
  // on the empty space below its content, which looks exactly like a page that
  // failed to load.
  const mainRef = useRef(null)
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0 }, [page])

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

    // A secret that is on disk but unreadable by this machine's keychain shows
    // as an empty field, which is indistinguishable from never having set one —
    // and the temptation is then to retype it, or to assume it was lost. Say
    // which secrets are affected and that they are still there.
    window.api.getConfigSecretError?.().then(err => {
      if (err) showToast(err, 'error')
    }).catch(() => {})

    // Update availability, pushed from the main process as it changes.
    window.api.getUpdateStatus?.().then(setUpdate).catch(() => {})
    const offUpdate = window.api.onUpdateStatus?.(setUpdate)

    // Seed the activity log from the persisted file so it survives a restart.
    window.api.getRecentLogs?.().then(lines => {
      if (Array.isArray(lines) && lines.length) setLogs(lines)
    })

    const offNotification = window.api.onNotification((data) => {
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

    const offLog = window.api.onAutomationLog((msg) => {
      setLogs(prev => [...prev.slice(-200), msg])
      if (msg.includes('Starting')) setScanRunning(true)
    })

    const offQuestion = window.api.onQuestionAsk((q) => {
      // Payload is { id, question } (id routes the answer back to the right
      // apply flow); tolerate a plain string from an older main process.
      setQuestion(typeof q === 'string' ? { id: null, question: q } : q)
      setQuestionAnswer('')
    })

    const offSubmitReview = window.api.onSubmitReview?.((payload) => setSubmitReview(payload))

    // Each subscription is torn down individually. Tearing down the whole
    // channel here would also unsubscribe Settings' own panels, which listen to
    // several of these — see the note on subscribe() in preload.js.
    return () => {
      offNotification?.()
      offLog?.()
      offQuestion?.()
      offSubmitReview?.()
      offUpdate?.()
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
    attention: <NeedsAttention active={page === 'attention'} onCountChange={setAttentionCount} showToast={showToast} />,
    timeline: <Timeline active={page === 'timeline'} />,
    analytics: <Analytics active={page === 'analytics'} />,
    offers: <Offers active={page === 'offers'} showToast={showToast} onOpenApplication={(id) => { setFocusApp(id); setPage('dashboard') }} />,
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
      {/* The sidebar is the app's primary glass surface: a fixed pane the whole
          scrolling column passes behind. It samples the ambient wash directly,
          which is the one place in the app where the material is unmistakable. */}
      <nav data-testid="nav" style={{
        width: 236, flexShrink: 0,
        background: 'var(--glass)',
        backdropFilter: 'var(--blur)',
        WebkitBackdropFilter: 'var(--blur)',
        borderRight: '1px solid var(--border)',
        boxShadow: 'var(--highlight)',
        display: 'flex', flexDirection: 'column', padding: '18px 12px', gap: 2,
        transition: 'background 0.4s var(--ease), border-color 0.4s var(--ease)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px 22px' }}>
          <HiroLogo size={28} />
          <span style={{
            fontSize: 19, fontWeight: 650, color: 'var(--text)', letterSpacing: '-0.03em',
          }}>Hiro</span>
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
                    background: n.id === 'review' ? 'var(--accent)' : 'var(--red)', color: '#fff',
                    borderRadius: 'var(--pill)',
                    fontSize: 10, padding: '1.5px 6px', fontWeight: 700, minWidth: 18, textAlign: 'center',
                    fontVariantNumeric: 'tabular-nums',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  }}
                >{count}</span>
              )}
              <span className="kbd" aria-hidden="true">{n.shortcut}</span>
            </button>
          )
        })}

        <div style={{ marginTop: 'auto', padding: '0 4px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Quick stats. Raised glass rather than a flat tint: it sits on the
              sidebar, so it needs a step of elevation to read as a distinct
              object rather than a lighter patch of the same pane. */}
          <div style={{
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '11px 13px',
            boxShadow: 'var(--highlight)',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <div style={{
              fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>Today</div>
            <div style={{
              fontSize: 24, fontWeight: 600, color: 'var(--text)',
              letterSpacing: '-0.035em', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums',
            }}>
              {todayCount}
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', letterSpacing: 0, marginLeft: 5 }}>applied</span>
            </div>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '0 2px',
            color: scanRunning ? 'var(--green)' : 'var(--text-muted)', fontSize: 12,
          }}>
            {/* The halo is what makes a 7px dot register in peripheral vision —
                it is the only live-status indicator in the chrome. */}
            <span className={scanRunning ? 'pulse' : ''} style={{
              width: 7, height: 7, borderRadius: '50%',
              background: scanRunning ? 'var(--green)' : 'var(--border-strong)',
              boxShadow: scanRunning ? '0 0 0 3px var(--green-soft)' : 'none',
              flexShrink: 0,
            }} />
            {scanRunning ? 'Scanning…' : 'Idle'}
          </div>
          {/* Three-way, because "follow the system" is a real preference and a
              two-state toggle cannot express it. */}
          <div role="group" aria-label="Colour theme" style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: 3,
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
                  // The selected segment is a raised chip inside the track —
                  // the platform's segmented control, which reads as a position
                  // rather than as three independently shaded buttons.
                  position: 'relative',
                  background: theme === opt.id ? 'var(--surface3)' : 'transparent',
                  border: 'none', borderRadius: 'var(--radius-sm)', padding: '5px 0',
                  boxShadow: theme === opt.id ? 'var(--shadow-sm), var(--highlight)' : 'none',
                  color: theme === opt.id ? 'var(--text)' : 'var(--text-faint)',
                  cursor: 'pointer', fontSize: 12, lineHeight: 1.3,
                  fontWeight: theme === opt.id ? 600 : 400,
                  transition: 'background 0.18s var(--ease), color 0.18s var(--ease), box-shadow 0.18s var(--ease)',
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
      {/* No background of its own — the ambient wash shows through here, and it
          is what the cards inside are blurring. Painting a surface colour on
          this column would flatten every card on every page at once. */}
      <main ref={mainRef} style={{ flex: 1, overflow: 'auto', padding: '30px 32px 44px', background: 'transparent' }}>
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

        {/* One boundary per page, not one around the shell. A render error used
            to unmount everything — sidebar, nav and all ten pages — leaving a
            blank window with no message. Scoped here, a page that cannot render
            says so in its own column and the rest of the app keeps working. */}
        {Object.entries(pages).filter(([key]) => mounted.has(key)).map(([key, component]) => (
          <div key={key} style={{ display: key === page ? 'block' : 'none' }}>
            <ErrorBoundary name={NAV.find(n => n.id === key)?.label || key}>
              {/* Per page rather than one boundary around the loop: a shared
                  Suspense would blank every mounted page while one chunk
                  loaded. The fallback is deliberately quiet — a chunk read off
                  local disk is not a wait worth announcing, and a spinner that
                  flashes for 20ms is worse than nothing. */}
              <Suspense fallback={<div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }} role="status">Loading…</div>}>
                {component}
              </Suspense>
            </ErrorBoundary>
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
            position: 'fixed', inset: 0, background: 'var(--scrim)',
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
          position: 'fixed', inset: 0, background: 'var(--scrim)',
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
          position: 'fixed', inset: 0, background: 'var(--scrim)',
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
