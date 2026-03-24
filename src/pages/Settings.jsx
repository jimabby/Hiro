import { useState, useEffect } from 'react'
import HiroLogo from '../components/HiroLogo'

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

export default function Settings({ showToast }) {
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
  const [inboxResult, setInboxResult] = useState(null)

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
    window.api.onGmailStatusUpdate(msg => setGmailMsg(msg))
    return () => {
      window.api.removeAllListeners('linkedin:status-update')
      window.api.removeAllListeners('gmail:status-update')
    }
  }, [])

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  async function viewPDF(text, title, originalPath, originalExt) {
    setPdfLoading(title)
    const res = await window.api.getResumePDFBase64(text, originalPath || null, originalExt || null)
    setPdfLoading(false)
    if (res.success) setPdfModal({ base64: res.base64, title })
  }

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
      followUpDays: parseInt(form.followUpDays) || 7,
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
              Auto-check inbox for recruiter replies (every 2 hours)
            </label>
          </div>
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
      </div>} {/* end accounts tab */}

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
                  disabled={pdfLoading === r.name}
                  onClick={() => viewPDF(r.text, r.name, r.originalPath, r.originalExt)}>
                  {pdfLoading === r.name ? 'Loading...' : 'View PDF'}
                </button>
                {r.originalExt === 'docx' || r.originalExt === 'doc' ? (
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    disabled={pdfLoading === r.name + '_docx'}
                    onClick={async () => {
                      setPdfLoading(r.name + '_docx')
                      await window.api.openResumeDocx(r.text, r.originalPath || null)
                      setPdfLoading(false)
                    }}>
                    {pdfLoading === r.name + '_docx' ? 'Opening...' : 'Preview DOCX'}
                  </button>
                ) : null}
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => window.api.downloadResume(r.text, r.name, 'pdf')}>
                  Save PDF
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => window.api.downloadResume(r.text, r.name, 'docx')}>
                  Save DOCX
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
              {newResumeOriginalPath ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6, border: '1px solid var(--border)' }}>
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
                          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4, color: 'var(--text)' }}>Q: {ca.question}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>A: {ca.answer}</div>
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
