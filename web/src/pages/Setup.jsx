import { useState } from 'react'
import HiroLogo from '../components/HiroLogo'

const STEPS = ['AI Provider', 'Email', 'Job Criteria', 'Resume', 'Review']

export default function Setup({ onComplete }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({
    aiProvider: 'claude',
    aiApiKey: '',
    geminiModel: '',
    // Ollama's default OpenAI-compatible endpoint, so choosing "local" with a
    // stock install needs no typing at all.
    localAiBaseUrl: 'http://localhost:11434/v1',
    localAiModel: 'llama3.1:8b',
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
  const [validationErrors, setValidationErrors] = useState([])

  const set = (key, val) => { setForm(f => ({ ...f, [key]: val })); setTestResult(null); setValidationErrors([]) }

  function validateStep(stepNum) {
    const errors = []
    if (stepNum === 0) {
      // A local server authenticates nothing — requiring a key there would block
      // setup on a credential that does not exist. It needs an address instead.
      if (form.aiProvider === 'local') {
        if (!String(form.localAiBaseUrl || '').trim()) errors.push('A server address is required for a local model.')
        if (!String(form.localAiModel || '').trim()) errors.push('A model name is required for a local model.')
      } else if (!form.aiApiKey.trim()) {
        errors.push('API key is required to use AI features.')
      }
    }
    if (stepNum === 2) {
      if (!form.jobKeywords.trim()) errors.push('At least one job keyword is required.')
      if (!form.enableSeek && !form.enableIndeed && !form.enableLinkedIn) errors.push('Enable at least one platform.')
    }
    return errors
  }

  // Steps 0 and 1 share one testResult slot, and it used to survive the move
  // between them — so a successful AI key test left a green "✓ Connected" sitting
  // beside the *email* Test Connection button on a step with nothing filled in.
  function goToStep(fn) {
    setValidationErrors([])
    setTestResult(null)
    setStep(fn)
  }

  function nextStep() {
    const errors = validateStep(step)
    if (errors.length > 0) {
      setValidationErrors(errors)
      return
    }
    goToStep(s => s + 1)
  }

  async function testAI() {
    setTesting(true)
    setTestResult(null)
    const model = form.aiProvider === 'local' ? form.localAiModel : form.geminiModel
    const res = await window.api.testAiConnection(form.aiProvider, form.aiApiKey, model)
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
    setValidationErrors([])
    const resumes = form.masterResume
      ? [{ id: Date.now().toString(), name: 'My Resume', text: form.masterResume }]
      : []
    // A save that threw used to leave the button reading "Saving…" forever with
    // no message — the last step of setup, and the wizard simply stopped.
    try {
      const res = await window.api.saveConfig({
        ...form,
        resumes,
        defaultResumeId: resumes[0]?.id || '',
        salaryMin: parseInt(form.salaryMin) || 0,
        matchThreshold: parseInt(form.matchThreshold) || 80,
        dailyLimitSeek: parseInt(form.dailyLimitSeek) || 10,
        dailyLimitIndeed: parseInt(form.dailyLimitIndeed) || 10,
        dailyLimitLinkedIn: parseInt(form.dailyLimitLinkedIn) || 10,
        blacklistedCompanies: form.blacklistedCompanies.split(',').map(s => s.trim()).filter(Boolean),
        setupComplete: true,
      })
      if (res?.success === false) {
        setValidationErrors([res.error || 'Could not save your settings. Please try again.'])
        return
      }
      onComplete()
    } catch (err) {
      setValidationErrors([`Could not save your settings: ${err.message}`])
    } finally {
      setSaving(false)
    }
  }

  // Step 0 is satisfied by a key, or — for a local model — by an address and a
  // model name. Used for the progress ticks, the review page and the warning.
  const aiConfigured = form.aiProvider === 'local'
    ? !!(String(form.localAiBaseUrl || '').trim() && String(form.localAiModel || '').trim())
    : !!form.aiApiKey

  const completedSteps = (() => {
    const done = []
    if (aiConfigured) done.push(0)
    if (form.gmailAddress && form.gmailAppPassword) done.push(1)
    if (form.jobKeywords) done.push(2)
    if (form.masterResume) done.push(3)
    return done
  })()

  return (
    // Deliberately transparent, not `var(--bg)`: the ambient wash is painted on
    // the document behind this, and repainting the flat floor here would cover
    // it — the wizard would be the one screen in the app with no depth to it,
    // and it is the first screen anyone sees.
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'transparent', overflowY: 'auto', padding: '32px 0',
    }}>
      <div style={{ width: 540 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 4 }}>
            <HiroLogo size={36} />
            <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>Hiro</span>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>Setup Wizard — {STEPS[step]} ({step + 1}/{STEPS.length})</div>
        </div>

        {/* Progress */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 28 }}>
          {STEPS.map((label, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                height: 3, borderRadius: 2, width: '100%',
                background: i <= step ? 'var(--accent)' : completedSteps.includes(i) ? 'var(--green)' : 'var(--border)',
                transition: 'background 0.3s',
              }} />
              <span style={{ fontSize: 9, color: i <= step ? 'var(--accent)' : 'var(--text-muted)' }}>{label}</span>
            </div>
          ))}
        </div>

        <div className="card">
          {/* Step 0: AI Provider */}
          {step === 0 && (
            <div>
              <h2 style={{ marginBottom: 20, fontSize: 18 }}>Choose Your AI Provider</h2>
              <div className="form-group">
                <label htmlFor="sup-f0">AI Provider</label>
                <select id="sup-f0" value={form.aiProvider} onChange={e => set('aiProvider', e.target.value)}>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="chatgpt">ChatGPT (OpenAI)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="gemini">Gemini (Google)</option>
                  <option value="local">Local model (Ollama / LM Studio)</option>
                </select>
              </div>
              {form.aiProvider === 'local' ? (
                <>
                  <div style={{
                    fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-subtle)',
                    border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', marginBottom: 12,
                  }}>
                    Your résumé and every job description stay on this machine. No API key, no bill,
                    and no provider sees your job search — in exchange for weaker tailoring than a
                    frontier model gives.
                  </div>
                  <div className="form-group">
                    <label htmlFor="sup-f1">Server address</label>
                    <input id="sup-f1"
                      value={form.localAiBaseUrl || ''}
                      onChange={e => set('localAiBaseUrl', e.target.value)}
                      placeholder="http://localhost:11434/v1"
                    />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1
                    </span>
                  </div>
                  <div className="form-group">
                    <label htmlFor="sup-f2">Model</label>
                    <input id="sup-f2"
                      value={form.localAiModel || ''}
                      onChange={e => set('localAiModel', e.target.value)}
                      placeholder="e.g. llama3.1:8b"
                    />
                  </div>
                </>
              ) : (
                <div className="form-group">
                  <label htmlFor="sup-f3">API Key</label>
                  <input id="sup-f3"
                    type="password" value={form.aiApiKey}
                    onChange={e => set('aiApiKey', e.target.value)}
                    placeholder="Paste your API key here..."
                  />
                </div>
              )}
              {form.aiProvider === 'gemini' && (
                <div className="form-group">
                  <label htmlFor="sup-f4">Gemini Model Name</label>
                  <input id="sup-f4"
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
                <button className="btn btn-ghost" onClick={testAI} disabled={!aiConfigured || testing}>
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
              <h2 style={{ marginBottom: 8, fontSize: 18 }}>Email Notifications</h2>
              <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13 }}>
                Used to send you job alerts and daily reports. Create an App Password in your email provider's security settings.
              </p>
              <div className="form-group">
                <label htmlFor="sup-f5">Email Address</label>
                <input id="sup-f5" type="email" value={form.gmailAddress} onChange={e => set('gmailAddress', e.target.value)} placeholder="you@gmail.com / outlook.com / yahoo.com" />
              </div>
              <div className="form-group">
                <label htmlFor="sup-f6">App Password</label>
                <input id="sup-f6" type="password" value={form.gmailAppPassword} onChange={e => set('gmailAppPassword', e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
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
                <label htmlFor="sup-f7">Job Keywords</label>
                <input id="sup-f7" value={form.jobKeywords} onChange={e => set('jobKeywords', e.target.value)} placeholder="e.g. Software Engineer, React Developer" />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="sup-f8">Location</label>
                  <input id="sup-f8" value={form.jobLocation} onChange={e => set('jobLocation', e.target.value)} placeholder="e.g. Melbourne, Australia" />
                </div>
                <div className="form-group">
                  <label htmlFor="sup-f9">Min Salary (AUD/year)</label>
                  <input id="sup-f9" type="number" value={form.salaryMin} onChange={e => set('salaryMin', e.target.value)} placeholder="e.g. 80000" />
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
                  <label htmlFor="sup-f10">Daily Limit — Seek</label>
                  <input id="sup-f10" type="number" min={1} max={50} value={form.dailyLimitSeek} onChange={e => set('dailyLimitSeek', e.target.value)} />
                </div>
                <div className="form-group">
                  <label htmlFor="sup-f11">Daily Limit — Indeed</label>
                  <input id="sup-f11" type="number" min={1} max={50} value={form.dailyLimitIndeed} onChange={e => set('dailyLimitIndeed', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="sup-f12">Daily Limit — LinkedIn</label>
                <input id="sup-f12" type="number" min={1} max={50} value={form.dailyLimitLinkedIn} onChange={e => set('dailyLimitLinkedIn', e.target.value)} style={{ width: '50%' }} />
              </div>
              <div className="form-group">
                <label htmlFor="sup-f13">Blacklisted Companies (comma-separated)</label>
                <input id="sup-f13" value={form.blacklistedCompanies} onChange={e => set('blacklistedCompanies', e.target.value)} placeholder="Company A, Company B" />
              </div>
            </div>
          )}

          {/* Step 3: Resume */}
          {step === 3 && (
            <div>
              <h2 style={{ marginBottom: 8, fontSize: 18 }}>Your Master Resume</h2>
              <p style={{ color: 'var(--text-muted)', marginBottom: 16, fontSize: 13 }}>
                Upload or paste your resume. The AI will tailor it per job without changing facts.
              </p>
              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ marginBottom: 0 }}>Resume Text</label>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
                    const res = await window.api.importResumeFile()
                    if (res.success) set('masterResume', res.text)
                  }}>
                    Upload File (PDF / DOCX / TXT)
                  </button>
                </div>
                <textarea
                  value={form.masterResume}
                  onChange={e => set('masterResume', e.target.value)}
                  placeholder="Paste your resume here, or upload a file above..."
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
                ['AI Provider', form.aiProvider, aiConfigured],
                ...(form.aiProvider === 'local'
                  ? [['Server', form.localAiBaseUrl || 'Not set', !!form.localAiBaseUrl],
                     ['Model', form.localAiModel || 'Not set', !!form.localAiModel]]
                  : [['API Key', form.aiApiKey ? '••••••••' : 'Not set', !!form.aiApiKey]]),
                ...(form.aiProvider === 'gemini' ? [['Gemini Model', form.geminiModel || 'Not set', !!form.geminiModel]] : []),
                ['Email', form.gmailAddress || 'Skipped (optional)', !!form.gmailAddress],
                ['Keywords', form.jobKeywords || 'Not set', !!form.jobKeywords],
                ['Location', form.jobLocation || 'Not set', !!form.jobLocation],
                ['Min Salary', form.salaryMin ? `$${Number(form.salaryMin).toLocaleString()}` : 'Any', true],
                ['Match Threshold', `${form.matchThreshold}%`, true],
                ['Platforms', [form.enableSeek && 'Seek', form.enableIndeed && 'Indeed', form.enableLinkedIn && 'LinkedIn'].filter(Boolean).join(', ') || 'None', form.enableSeek || form.enableIndeed || form.enableLinkedIn],
                ['Resume', form.masterResume ? `${form.masterResume.slice(0, 60)}...` : 'Not set (can add later)', true],
              ].map(([k, v, ok]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                  <span style={{ color: ok ? 'var(--text)' : 'var(--yellow)' }}>{v}</span>
                </div>
              ))}
              {!aiConfigured && (
                <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(234,179,8,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--yellow)' }}>
                  {form.aiProvider === 'local'
                    ? "Warning: the local model isn't fully configured. AI features won't work until the server address and model are set in Settings."
                    : "Warning: No AI API key set. AI features won't work until you add one in Settings."}
                </div>
              )}
            </div>
          )}

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.15)', borderRadius: 8 }}>
              {validationErrors.map((err, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--red)', marginBottom: i < validationErrors.length - 1 ? 4 : 0 }}>{err}</div>
              ))}
            </div>
          )}

          {/* Navigation */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <button className="btn btn-ghost" onClick={() => goToStep(s => s - 1)} disabled={step === 0}>
              Back
            </button>
            {step < STEPS.length - 1 ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {step === 1 && (
                  <button className="btn btn-ghost" style={{ color: 'var(--text-muted)', fontSize: 13 }}
                    onClick={() => { set('gmailAddress', ''); set('gmailAppPassword', ''); goToStep(s => s + 1) }}>
                    Skip for now
                  </button>
                )}
                {step === 3 && (
                  <button className="btn btn-ghost" style={{ color: 'var(--text-muted)', fontSize: 13 }}
                    onClick={() => { set('masterResume', ''); goToStep(s => s + 1) }}>
                    Skip for now
                  </button>
                )}
                <button className="btn btn-primary" onClick={nextStep}>
                  Continue
                </button>
              </div>
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
