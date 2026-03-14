import { useState, useEffect } from 'react'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import NeedsAttention from './pages/NeedsAttention'
import Settings from './pages/Settings'
import Timeline from './pages/Timeline'
import Analytics from './pages/Analytics'

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'attention', label: 'Needs Attention' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' },
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
  const [toast, setToast] = useState(null)
  const [logs, setLogs] = useState([])
  const [scanRunning, setScanRunning] = useState(false)
  const [resumeModal, setResumeModal] = useState(false)
  const [resumeUploading, setResumeUploading] = useState(false)
  const [question, setQuestion] = useState(null)
  const [questionAnswer, setQuestionAnswer] = useState('')

  useEffect(() => {
    window.api.getConfig().then(cfg => setSetupDone(cfg.setupComplete))

    window.api.getStats().then(s => setAttentionCount(s.attentionCount || 0))

    window.api.onNotification((data) => {
      if (data.type === 'attention') {
        setAttentionCount(c => c + 1)
        showToast(`New job needs attention: ${data.job?.job_title}`)
      }
      if (data.type === 'scan-complete') {
        setScanRunning(false)
        window.api.getStats().then(s => setAttentionCount(s.attentionCount || 0))
        showToast('Scan complete')
      }
    })

    window.api.onAutomationLog((msg) => {
      setLogs(prev => [...prev.slice(-200), msg])
      if (msg.includes('Starting')) setScanRunning(true)
    })

    window.api.onQuestionAsk((q) => {
      setQuestion(q)
      setQuestionAnswer('')
    })

    return () => {
      window.api.removeAllListeners('notification')
      window.api.removeAllListeners('automation:log')
      window.api.removeAllListeners('question:ask')
    }
  }, [])

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  if (setupDone === null) return null // loading

  if (!setupDone) {
    return <Setup onComplete={() => setSetupDone(true)} />
  }

  async function handleScanStart() {
    const cfg = await window.api.getConfig()
    const hasResume = (cfg.resumes || []).length > 0 || cfg.masterResume
    if (!hasResume) {
      setResumeModal(true)
      return
    }
    setScanRunning(true)
    window.api.startAutomation()
  }

  async function handleResumeUpload() {
    setResumeUploading(true)
    const res = await window.api.importResumeFile()
    setResumeUploading(false)
    if (res.canceled || !res.success) return
    const cfg = await window.api.getConfig()
    const id = Date.now().toString()
    const newResume = { id, name: res.fileName || 'My Resume', text: res.text }
    const resumes = [...(cfg.resumes || []), newResume]
    await window.api.saveConfig({ ...cfg, resumes, defaultResumeId: cfg.defaultResumeId || id })
    setResumeModal(false)
    setScanRunning(true)
    window.api.startAutomation()
  }

  const pages = {
    dashboard: <Dashboard logs={logs} scanRunning={scanRunning} onScanStart={handleScanStart} />,
    attention: <NeedsAttention onCountChange={setAttentionCount} />,
    timeline: <Timeline />,
    analytics: <Analytics />,
    settings: <Settings />,
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <nav style={{
        width: 200, background: 'var(--surface)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', padding: '20px 12px', gap: 4, flexShrink: 0
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)', padding: '8px 12px 20px' }}>
          Hiro
        </div>
        {NAV.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            background: page === n.id ? 'var(--surface2)' : 'transparent',
            border: 'none', color: page === n.id ? 'var(--text)' : 'var(--text-muted)',
            padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
            textAlign: 'left', fontSize: 14, display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', fontWeight: page === n.id ? 600 : 400,
            transition: 'all 0.15s',
          }}>
            {n.label}
            {n.id === 'attention' && attentionCount > 0 && (
              <span style={{
                background: 'var(--red)', color: '#fff', borderRadius: 10,
                fontSize: 11, padding: '1px 6px', fontWeight: 700,
              }}>{attentionCount}</span>
            )}
          </button>
        ))}

        <div style={{ marginTop: 'auto', padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: scanRunning ? 'var(--green)' : 'var(--text-muted)', fontSize: 12,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: scanRunning ? 'var(--green)' : 'var(--border)',
              flexShrink: 0,
            }} />
            {scanRunning ? 'Scanning...' : 'Idle'}
          </div>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-muted)', borderRadius: 8, padding: '6px 10px',
              cursor: 'pointer', fontSize: 12, textAlign: 'left',
            }}
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'auto', padding: 28 }}>
        {pages[page]}
      </main>

      {toast && <div className="toast">{toast}</div>}

      {resumeModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div className="card" style={{ width: 420 }}>
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
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }}>
          <div className="card" style={{ width: 500 }}>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Application Question</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
              The AI couldn't confidently answer this. Your answer will be saved for future applications.
            </p>
            <div style={{
              padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8,
              marginBottom: 14, fontSize: 14, borderLeft: '3px solid var(--accent)',
            }}>
              {question}
            </div>
            <textarea
              autoFocus
              value={questionAnswer}
              onChange={e => setQuestionAnswer(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  window.api.sendQuestionAnswer(questionAnswer)
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
                window.api.sendQuestionAnswer('')
                setQuestion(null)
              }}>Skip</button>
              <button className="btn btn-primary" onClick={() => {
                window.api.sendQuestionAnswer(questionAnswer)
                setQuestion(null)
              }}>Submit Answer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
