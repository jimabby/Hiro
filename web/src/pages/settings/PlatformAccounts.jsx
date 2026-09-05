// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// The stored browser sessions for the two platforms that need a logged-in one.
// One card each rather than a shared component: the two platforms fail
// differently and each says so in its own words.

import { useEffect, useState } from 'react'

export function IndeedAccountCard() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [logging, setLogging] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.indeedStatus().then(s => setLoggedIn(s.loggedIn))
    const off = window.api.onIndeedStatusUpdate(m => setMsg(m))
    return () => off?.()
  }, [])

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>Indeed Account</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Required for Indeed Easy Apply. Without logging in, applications won't be submitted under your account.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 'auto' }}>
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

export function SeekAccountCard() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [logging, setLogging] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.seekStatus().then(s => setLoggedIn(s.loggedIn))
    const off = window.api.onSeekStatusUpdate(m => setMsg(m))
    return () => off?.()
  }, [])

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>Seek Account</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Required for Seek applications. Without logging in, submitted applications won't be recorded and you won't receive confirmation emails.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 'auto' }}>
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
