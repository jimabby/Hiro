import { useState, useEffect } from 'react'

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
    <div className="card" style={{ marginBottom: 16 }}>
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
    <div className="card" style={{ marginBottom: 16 }}>
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

export default function Settings() {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [addingResume, setAddingResume] = useState(false)
  const [newResumeName, setNewResumeName] = useState('')
  const [newResumeText, setNewResumeText] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [improvingId, setImprovingId] = useState(null)
  const [improveModal, setImproveModal] = useState(null) // { sourceId, sourceName, text }
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

  async function saveResumes(resumes, defaultResumeId) {
    const cfg = await window.api.getConfig()
    await window.api.saveConfig({ ...cfg, resumes, defaultResumeId })
    setForm(f => ({ ...f, resumes, defaultResumeId }))
  }

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

      {/* Indeed */}
      <IndeedAccountCard />

      {/* Seek */}
      <SeekAccountCard />

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

      {/* Resumes */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Resumes <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 13 }}>({(form.resumes || []).length}/3)</span></h3>
          {(form.resumes || []).length < 3 && !addingResume && (
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
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => window.api.downloadResume(r.text, r.name)}>
                  Download
                </button>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <label style={{ fontSize: 12, marginBottom: 0 }}>Resume Text</label>
                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                  setUploadError('')
                  const res = await window.api.importResumeFile()
                  if (res.canceled) return
                  if (res.success) {
                    setNewResumeText(res.text)
                    if (!newResumeName) setNewResumeName(res.fileName)
                  } else {
                    setUploadError(res.error || 'Failed to read file')
                  }
                }}>
                  Upload File
                </button>
              </div>
              <textarea value={newResumeText} onChange={e => setNewResumeText(e.target.value)}
                placeholder="Paste resume text or upload a file..." style={{ minHeight: 120 }} />
              {uploadError && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{uploadError}</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setAddingResume(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ fontSize: 12 }}
                disabled={!newResumeName.trim() || !newResumeText.trim()}
                onClick={() => {
                  const id = Date.now().toString()
                  const resumes = [...(form.resumes || []), { id, name: newResumeName.trim(), text: newResumeText.trim() }]
                  const defaultResumeId = form.defaultResumeId || id
                  saveResumes(resumes, defaultResumeId)
                  setAddingResume(false)
                }}>
                Save Resume
              </button>
            </div>
          </div>
        )}
      </div>

      {improveModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div className="card" style={{ width: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
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
              {(form.resumes || []).length < 3 && (
                <button className="btn btn-ghost" onClick={() => {
                  const id = Date.now().toString()
                  const resumes = [...(form.resumes || []), { id, name: `${improveModal.sourceName} (Improved)`, text: improveModal.text }]
                  saveResumes(resumes, form.defaultResumeId)
                  setImproveModal(null)
                }}>
                  Save as New
                </button>
              )}
              <button className="btn btn-primary" onClick={() => {
                const resumes = (form.resumes || []).map(r => r.id === improveModal.sourceId ? { ...r, text: improveModal.text } : r)
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
