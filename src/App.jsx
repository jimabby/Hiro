import { useState, useEffect } from 'react'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import NeedsAttention from './pages/NeedsAttention'
import Settings from './pages/Settings'

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'attention', label: 'Needs Attention' },
  { id: 'settings', label: 'Settings' },
]

export default function App() {
  const [page, setPage] = useState('dashboard')
  const [setupDone, setSetupDone] = useState(null)
  const [attentionCount, setAttentionCount] = useState(0)
  const [toast, setToast] = useState(null)
  const [logs, setLogs] = useState([])
  const [scanRunning, setScanRunning] = useState(false)

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

    return () => {
      window.api.removeAllListeners('notification')
      window.api.removeAllListeners('automation:log')
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

  const pages = {
    dashboard: <Dashboard logs={logs} scanRunning={scanRunning} onScanStart={() => { setScanRunning(true); window.api.startAutomation() }} />,
    attention: <NeedsAttention onCountChange={setAttentionCount} />,
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

        <div style={{ marginTop: 'auto', padding: '0 12px' }}>
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
        </div>
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'auto', padding: 28 }}>
        {pages[page]}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
