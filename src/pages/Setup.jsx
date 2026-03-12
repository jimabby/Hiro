import { useState } from 'react'

const STEPS = ['AI Provider', 'Email', 'Job Criteria', 'Resume', 'Review']

export default function Setup({ onComplete }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({
    aiProvider: 'claude',
    aiApiKey: '',
    geminiModel: '',
    gmailAddress: '',
    gmailAppPassword: '',
    jobKeywords: '',
    jobLocation: '',
    salaryMin: '',
    masterResume: '',
    matchThreshold: 80,
    dailyLimitSeek: 10,
    dailyLimitIndeed: 10,
    dailyLimitLinkedIn: 10,
    enableSeek: true,
    enableIndeed: true,
    enableLinkedIn: true,
    blacklistedCompanies: '',
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [saving, setSaving] = useState(false)

  const set = (key, val) => { setForm(f => ({ ...f, [key]: val })); setTestResult(null) }

  async function testAI() {
    setTesting(true)
    setTestResult(null)
    const res = await window.api.testAiConnection(form.aiProvider, form.aiApiKey, form.geminiModel)
    setTesting(false)
    setTestResult(res)
  }

  async function testEmail() {
    setTesting(true)
    setTestResult(null)
    const res = await window.api.testEmailConnection(form.gmailAddress, form.gmailAppPassword)
    setTesting(false)
    setTestResult(res)
  }

  async function finish() {
    setSaving(true)
    await window.api.saveConfig({
      ...form,
      salaryMin: parseInt(form.salaryMin) || 0,
      matchThreshold: parseInt(form.matchThreshold) || 80,
      dailyLimitSeek: parseInt(form.dailyLimitSeek) || 10,
      dailyLimitIndeed: parseInt(form.dailyLimitIndeed) || 10,
      dailyLimitLinkedIn: parseInt(form.dailyLimitLinkedIn) || 10,
      blacklistedCompanies: form.blacklistedCompanies.split(',').map(s => s.trim()).filter(Boolean),
      setupComplete: true,
    })
    setSaving(false)
    onComplete()
  }

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{ width: 540 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>Hiro</div>
          <div style={{ color: 'var(--text-muted)' }}>Setup Wizard — {STEPS[step]} ({step + 1}/{STEPS.length})</div>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 28 }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 3, borderRadius: 2,
              background: i <= step ? 'var(--accent)' : 'var(--border)',
              transition: 'background 0.3s',
            }} />
          ))}
        </div>

        <div className="card">
          {/* Step 0: AI Provider */}
          {step === 0 && (
            <div>
              <h2 style={{ marginBottom: 20, fontSize: 18 }}>Choose Your AI Provider</h2>
              <div className="form-group">
                <label>AI Provider</label>
                <select value={form.aiProvider} onChange={e => set('aiProvider', e.target.value)}>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="chatgpt">ChatGPT (OpenAI)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="gemini">Gemini (Google)</option>
                </select>
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password" value={form.aiApiKey}
                  onChange={e => set('aiApiKey', e.target.value)}
                  placeholder="Paste your API key here..."
                />
              </div>
              {form.aiProvider === 'gemini' && (
                <div className="form-group">
                  <label>Gemini Model Name</label>
                  <input
                    value={form.geminiModel}
                    onChange={e => set('geminiModel', e.target.value)}
                    placeholder="e.g. gemini-2.5-flash"
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Find available models at aistudio.google.com or run: curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <button className="btn btn-ghost" onClick={testAI} disabled={!form.aiApiKey || testing}>
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                {testResult && (
                  <span style={{ color: testResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
                    {testResult.success ? '✓ Connected' : `✗ ${testResult.error}`}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Step 1: Email */}
          {step === 1 && (
            <div>
              <h2 style={{ marginBottom: 8, fontSize: 18 }}>Gmail Notifications</h2>
              <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13 }}>
                Used to send you job alerts and daily reports. Create a Gmail App Password at myaccount.google.com → Security → App Passwords.
              </p>
              <div className="form-group">
                <label>Gmail Address</label>
                <input type="email" value={form.gmailAddress} onChange={e => set('gmailAddress', e.target.value)} placeholder="you@gmail.com" />
              </div>
              <div className="form-group">
                <label>Gmail App Password</label>
                <input type="password" value={form.gmailAppPassword} onChange={e => set('gmailAppPassword', e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-ghost" onClick={testEmail} disabled={!form.gmailAddress || !form.gmailAppPassword || testing}>
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                {testResult && (
                  <span style={{ color: testResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
                    {testResult.success ? '✓ Connected' : `✗ ${testResult.error}`}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Job Criteria */}
          {step === 2 && (
            <div>
              <h2 style={{ marginBottom: 20, fontSize: 18 }}>Job Search Criteria</h2>
              <div className="form-group">
                <label>Job Keywords</label>
                <input value={form.jobKeywords} onChange={e => set('jobKeywords', e.target.value)} placeholder="e.g. Software Engineer, React Developer" />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Location</label>
                  <input value={form.jobLocation} onChange={e => set('jobLocation', e.target.value)} placeholder="e.g. Melbourne, Australia" />
                </div>
                <div className="form-group">
                  <label>Min Salary (AUD/year)</label>
                  <input type="number" value={form.salaryMin} onChange={e => set('salaryMin', e.target.value)} placeholder="e.g. 80000" />
                </div>
              </div>
              <div className="form-group">
                <label>Match Threshold (%)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input type="range" min={50} max={100} value={form.matchThreshold}
                    onChange={e => set('matchThreshold', e.target.value)}
                    style={{ flex: 1, padding: 0, border: 'none', background: 'transparent' }} />
                  <span style={{ color: 'var(--accent)', fontWeight: 600, minWidth: 36 }}>{form.matchThreshold}%</span>
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8, display: 'block' }}>Platforms to scan</label>
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
              <div className="form-row">
                <div className="form-group">
                  <label>Daily Limit — Seek</label>
                  <input type="number" min={1} max={50} value={form.dailyLimitSeek} onChange={e => set('dailyLimitSeek', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Daily Limit — Indeed</label>
                  <input type="number" min={1} max={50} value={form.dailyLimitIndeed} onChange={e => set('dailyLimitIndeed', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>Blacklisted Companies (comma-separated)</label>
                <input value={form.blacklistedCompanies} onChange={e => set('blacklistedCompanies', e.target.value)} placeholder="Company A, Company B" />
              </div>
            </div>
          )}

          {/* Step 3: Resume */}
          {step === 3 && (
            <div>
              <h2 style={{ marginBottom: 8, fontSize: 18 }}>Your Master Resume</h2>
              <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: 13 }}>
                Paste your full resume as plain text. The AI will tailor it per job without changing facts.
              </p>
              <div className="form-group">
                <label>Resume Text</label>
                <textarea
                  value={form.masterResume}
                  onChange={e => set('masterResume', e.target.value)}
                  placeholder="Paste your resume here..."
                  style={{ minHeight: 280 }}
                />
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div>
              <h2 style={{ marginBottom: 20, fontSize: 18 }}>Review & Start</h2>
              {[
                ['AI Provider', form.aiProvider],
                ['API Key', form.aiApiKey ? '••••••••' : 'Not set'],
                ...(form.aiProvider === 'gemini' ? [['Gemini Model', form.geminiModel || 'Not set']] : []),
                ['Gmail', form.gmailAddress || 'Not set'],
                ['Keywords', form.jobKeywords || 'Not set'],
                ['Location', form.jobLocation || 'Not set'],
                ['Min Salary', form.salaryMin ? `$${form.salaryMin}` : 'Any'],
                ['Match Threshold', `${form.matchThreshold}%`],
                ['Platforms', [form.enableSeek && 'Seek', form.enableIndeed && 'Indeed', form.enableLinkedIn && 'LinkedIn'].filter(Boolean).join(', ')],
                ['Resume', form.masterResume ? `${form.masterResume.slice(0, 60)}...` : 'Not set'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          )}

          {/* Navigation */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <button className="btn btn-ghost" onClick={() => setStep(s => s - 1)} disabled={step === 0}>
              Back
            </button>
            {step < STEPS.length - 1 ? (
              <button className="btn btn-primary" onClick={() => setStep(s => s + 1)}>
                Continue
              </button>
            ) : (
              <button className="btn btn-primary" onClick={finish} disabled={saving}>
                {saving ? 'Saving...' : 'Start Hiro'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
