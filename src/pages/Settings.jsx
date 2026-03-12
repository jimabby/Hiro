import { useState, useEffect } from 'react'

export default function Settings() {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testingAi, setTestingAi] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)
  const [aiResult, setAiResult] = useState(null)
  const [emailResult, setEmailResult] = useState(null)
  const [linkedinLoggedIn, setLinkedinLoggedIn] = useState(false)
  const [linkedinLogging, setLinkedinLogging] = useState(false)
  const [linkedinMsg, setLinkedinMsg] = useState('')

  useEffect(() => {
    window.api.getConfig().then(cfg => {
      setForm({
        ...cfg,
        blacklistedCompanies: Array.isArray(cfg.blacklistedCompanies)
          ? cfg.blacklistedCompanies.join(', ')
          : cfg.blacklistedCompanies || '',
      })
    })
    window.api.linkedinStatus().then(s => setLinkedinLoggedIn(s.loggedIn))
    window.api.onLinkedInStatusUpdate(msg => setLinkedinMsg(msg))
    return () => window.api.removeAllListeners('linkedin:status-update')
  }, [])

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  async function save() {
    setSaving(true)
    setSaved(false)
    await window.api.saveConfig({
      ...form,
      salaryMin: parseInt(form.salaryMin) || 0,
      matchThreshold: parseInt(form.matchThreshold) || 80,
      dailyLimitSeek: parseInt(form.dailyLimitSeek) || 10,
      dailyLimitIndeed: parseInt(form.dailyLimitIndeed) || 10,
      dailyLimitLinkedIn: parseInt(form.dailyLimitLinkedIn) || 10,
      blacklistedCompanies: (form.blacklistedCompanies || '').split(',').map(s => s.trim()).filter(Boolean),
    })
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
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Settings</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {saved && <span style={{ color: 'var(--green)', fontSize: 13 }}>✓ Saved</span>}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

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

      {/* LinkedIn */}
      <div className="card" style={{ marginBottom: 16 }}>
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

      {/* Email */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>Gmail Notifications</h3>
        <div className="form-row">
          <div className="form-group">
            <label>Gmail Address</label>
            <input type="email" value={form.gmailAddress} onChange={e => set('gmailAddress', e.target.value)} />
          </div>
          <div className="form-group">
            <label>App Password</label>
            <input type="password" value={form.gmailAppPassword} onChange={e => set('gmailAppPassword', e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={testEmail} disabled={!form.gmailAddress || !form.gmailAppPassword || testingEmail}>
            {testingEmail ? 'Testing...' : 'Test Connection'}
          </button>
          {emailResult && (
            <span style={{ color: emailResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
              {emailResult.success ? '✓ Connected' : `✗ ${emailResult.error}`}
            </span>
          )}
        </div>
      </div>

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
          <label>Blacklisted Companies (comma-separated)</label>
          <input value={form.blacklistedCompanies} onChange={e => set('blacklistedCompanies', e.target.value)} />
        </div>
      </div>

      {/* Resume */}
      <div className="card">
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>Master Resume</h3>
        <div className="form-group">
          <textarea value={form.masterResume} onChange={e => set('masterResume', e.target.value)} style={{ minHeight: 240 }} />
        </div>
      </div>
    </div>
  )
}
