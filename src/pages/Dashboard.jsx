import { useState, useEffect, useRef } from 'react'

function safeParseJSON(str) {
  try { return JSON.parse(str || '[]') } catch { return [] }
}

function stripMd(t) {
  return (t || '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^-{3,}\s*$/gm, '')
}

const STATUS_BADGE = {
  applied: { label: 'Applied', color: 'badge-blue' },
  interview: { label: 'Interview', color: 'badge-green' },
  rejected: { label: 'Rejected', color: 'badge-red' },
  pending: { label: 'Pending', color: 'badge-yellow' },
  skipped: { label: 'Skipped', color: 'badge-gray' },
}

export default function Dashboard({ logs, scanRunning, onScanStart }) {
  const [stats, setStats] = useState(null)
  const [apps, setApps] = useState([])
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState({ status: '', platform: '', search: '' })
  const [resumeExpanded, setResumeExpanded] = useState(false)
  const [interviewQuestions, setInterviewQuestions] = useState(null)
  const [loadingQuestions, setLoadingQuestions] = useState(false)
  const [keywordGap, setKeywordGap] = useState(null)
  const [loadingGap, setLoadingGap] = useState(false)
  const [pdfModal, setPdfModal] = useState(null) // { base64, title }
  const [pdfLoading, setPdfLoading] = useState(false)
  const [skippedApplying, setSkippedApplying] = useState(false)
  const [skippedApplyLog, setSkippedApplyLog] = useState([])
  const [skippedApplyResult, setSkippedApplyResult] = useState(null)
  const skippedLogEndRef = useRef(null)
  const logRef = useRef(null)
  const searchRef = useRef(null)

  useEffect(() => { loadData() }, [])

  // Auto-refresh data when scan finishes
  const prevScanRunning = useRef(scanRunning)
  useEffect(() => {
    if (prevScanRunning.current && !scanRunning) loadData()
    prevScanRunning.current = scanRunning
  }, [scanRunning])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    window.api.onSkippedApplyLog(msg => setSkippedApplyLog(prev => [...prev, msg]))
    return () => window.api.removeAllListeners('skipped:apply-log')
  }, [])

  useEffect(() => {
    skippedLogEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [skippedApplyLog])

  useEffect(() => {
    setInterviewQuestions(null)
    setKeywordGap(null)
  }, [selected?.id])

  async function viewPDF(text, title, isCoverLetter = false) {
    setPdfLoading(true)
    const res = isCoverLetter
      ? await window.api.getCoverLetterPDFBase64(text)
      : await window.api.getResumePDFBase64(text)
    setPdfLoading(false)
    if (res.success) setPdfModal({ base64: res.base64, title })
  }

  const filtered = apps.filter(a => {
    if (filter.status && a.status !== filter.status) return false
    if (filter.platform && a.platform !== filter.platform) return false
    if (filter.search) {
      const q = filter.search.toLowerCase()
      if (!a.job_title.toLowerCase().includes(q) && !a.company.toLowerCase().includes(q)) return false
    }
    return true
  })

  useEffect(() => {
    function handler(e) {
      if (e.key === 'Escape') {
        if (pdfModal) { setPdfModal(null); return }
        setSelected(null)
      }
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (selected) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const idx = filtered.findIndex(a => a.id === selected.id)
          if (idx < filtered.length - 1) { setSelected(filtered[idx + 1]); setResumeExpanded(false) }
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          const idx = filtered.findIndex(a => a.id === selected.id)
          if (idx > 0) { setSelected(filtered[idx - 1]); setResumeExpanded(false) }
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selected, filtered, pdfModal])

  async function loadData() {
    const [s, a] = await Promise.all([
      window.api.getStats(),
      window.api.getApplications({}),
    ])
    setStats(s)
    setApps(a)
  }

  async function stopScan() {
    await window.api.stopAutomation()
  }

  async function aiApplySkipped(job) {
    setSelected(null)
    setSkippedApplying(true)
    setSkippedApplyLog([`Starting AI apply for ${job.job_title} at ${job.company}...`])
    setSkippedApplyResult(null)
    const result = await window.api.applySkippedJob(job.id)
    setSkippedApplyResult(result)
    if (result.success) {
      setApps(prev => prev.map(a => a.id === job.id ? { ...a, status: 'applied' } : a))
      loadData()
    }
  }

  async function changeStatus(id, status, e) {
    e.stopPropagation()
    await window.api.updateApplicationStatus(id, status)
    setApps(prev => prev.map(a => a.id === id ? { ...a, status } : a))
    if (selected?.id === id) setSelected(s => ({ ...s, status }))
  }

  async function saveComment(id, comment) {
    await window.api.updateApplicationComment(id, comment)
    setApps(prev => prev.map(a => a.id === id ? { ...a, comment } : a))
    if (selected?.id === id) setSelected(s => ({ ...s, comment }))
  }

  async function saveRecruiterEmail(id, email) {
    await window.api.updateRecruiterEmail(id, email)
    setApps(prev => prev.map(a => a.id === id ? { ...a, recruiter_email: email } : a))
    if (selected?.id === id) setSelected(s => ({ ...s, recruiter_email: email }))
  }

  async function deleteApp(id, e) {
    e.stopPropagation()
    await window.api.deleteApplication(id)
    setApps(prev => prev.filter(a => a.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  async function clearAll() {
    if (!window.confirm('Delete all application history? This cannot be undone.')) return
    await window.api.clearAllApplications()
    setApps([])
    setSelected(null)
    loadData()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {scanRunning && (
            <button className="btn btn-danger" onClick={stopScan}>
              Stop Scan
            </button>
          )}
          <button className="btn btn-primary" onClick={onScanStart} disabled={scanRunning}>
            {scanRunning ? 'Scanning...' : 'Run Scan Now'}
          </button>
        </div>
      </div>

      {/* Stats */}
      {!stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="card stat-card" style={{ opacity: 0.5 }}>
              <div className="stat-value">—</div>
              <div className="stat-label">Loading...</div>
            </div>
          ))}
        </div>
      )}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
          {[
            { label: 'Today', value: stats.totalToday },
            { label: 'This Week', value: stats.totalThisWeek },
            { label: 'All Time', value: stats.totalAllTime },
            { label: 'Interviews', value: stats.interviews },
            { label: 'Response Rate', value: stats.responseRate != null ? `${stats.responseRate}%` : '—' },
          ].map(s => (
            <div key={s.label} className="card stat-card">
              <div className="stat-value">{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Activity Log</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{logs.length} entries</span>
          </div>
          <div className="log-box" ref={logRef}>{logs.join('\n')}</div>
        </div>
      )}

      {/* Applications */}
      <div className="card">
        {/* Status tabs */}
        {(() => {
          const TAB_STATUSES = [
            { value: '', label: 'All' },
            { value: 'applied', label: 'Applied' },
            { value: 'interview', label: 'Interview' },
            { value: 'pending', label: 'Pending' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'skipped', label: 'Skipped' },
          ]
          return (
            <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
              {TAB_STATUSES.map(tab => {
                const count = tab.value ? apps.filter(a => a.status === tab.value).length : apps.length
                const active = filter.status === tab.value
                return (
                  <button key={tab.value} onClick={() => setFilter(f => ({ ...f, status: tab.value }))}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '8px 14px', fontSize: 13, fontWeight: active ? 600 : 400,
                      color: active ? 'var(--accent)' : 'var(--text-muted)',
                      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                      marginBottom: -1, transition: 'color 0.15s',
                    }}>
                    {tab.label}
                    <span style={{
                      marginLeft: 6, fontSize: 11, background: active ? 'var(--accent)' : 'var(--surface2)',
                      color: active ? '#fff' : 'var(--text-muted)',
                      borderRadius: 10, padding: '1px 6px',
                    }}>{count}</span>
                  </button>
                )
              })}
            </div>
          )
        })()}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-muted)' }}>{filtered.length} job{filtered.length !== 1 ? 's' : ''}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={searchRef}
              value={filter.search}
              onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
              placeholder="Search... (/)"
              style={{ width: 150, padding: '5px 10px', fontSize: 12 }}
            />
            <select value={filter.platform} onChange={e => setFilter(f => ({ ...f, platform: e.target.value }))} style={{ width: 'auto' }}>
              <option value="">All Platforms</option>
              <option value="Seek">Seek</option>
              <option value="Indeed">Indeed</option>
              <option value="LinkedIn">LinkedIn</option>
            </select>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => window.api.exportCSV(filter)}>Export CSV</button>
            <button className="btn btn-ghost" onClick={loadData} style={{ whiteSpace: 'nowrap' }}>Refresh</button>
            {apps.length > 0 && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={clearAll}>Clear All</button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            No jobs yet. Run a scan to get started.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th><th>Company</th><th>Platform</th>
                  <th>Match</th><th>Comment</th><th>Status</th><th>Date</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => { setSelected(a); setResumeExpanded(false) }}>
                    <td style={{ fontWeight: 500 }}>{a.job_title}</td>
                    <td>{a.company}</td>
                    <td><span className="badge badge-blue">{a.platform}</span></td>
                    <td>
                      <span style={{
                        color: a.match_score >= 85 ? 'var(--green)' : a.match_score >= 70 ? 'var(--yellow)' : 'var(--text-muted)',
                        fontWeight: 600,
                      }}>{a.match_score}%</span>
                    </td>
                    <td onClick={e => e.stopPropagation()} style={{ minWidth: 140 }}>
                      <input
                        defaultValue={a.comment || ''}
                        placeholder="Add note..."
                        onBlur={e => saveComment(a.id, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                        style={{
                          background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                          color: 'var(--text)', fontSize: 12, width: '100%', padding: '2px 4px',
                          outline: 'none',
                        }}
                      />
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      {a.status === 'skipped' ? (
                        <span className="badge badge-gray">Skipped</span>
                      ) : (
                        <select value={a.status} style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
                          onChange={e => changeStatus(a.id, e.target.value, e)}>
                          <option value="applied">Applied</option>
                          <option value="interview">Interview</option>
                          <option value="rejected">Rejected</option>
                          <option value="pending">Pending</option>
                        </select>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {new Date(a.applied_at).toLocaleDateString()}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)', padding: '2px 6px' }}
                        onClick={e => deleteApp(a.id, e)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selected && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setSelected(null)}>
          <div className="card" style={{ width: '70vw', maxWidth: 900, maxHeight: '85vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <h2 style={{ fontSize: 18 }}>{selected.job_title}</h2>
                  <span className={`badge ${STATUS_BADGE[selected.status]?.color || 'badge-gray'}`}>
                    {STATUS_BADGE[selected.status]?.label || selected.status}
                  </span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {selected.company} · {selected.platform} {selected.salary ? `· ${selected.salary}` : ''}
                  {' · '}<span style={{ color: selected.match_score >= 80 ? 'var(--green)' : 'var(--yellow)' }}>
                    {selected.match_score}% match
                  </span>
                </div>
                {selected.match_explanation && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{selected.match_explanation}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={async () => {
                    await window.api.deleteApplication(selected.id)
                    setApps(prev => prev.filter(a => a.id !== selected.id))
                    setSelected(null)
                  }}>Delete</button>
                <button className="btn btn-ghost" onClick={() => setSelected(null)}>✕</button>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {selected.status === 'interview' && (
                <button className="btn btn-ghost" style={{ fontSize: 12 }}
                  disabled={loadingQuestions}
                  onClick={async () => {
                    setLoadingQuestions(true)
                    const cfg = await window.api.getConfig()
                    const resume = (cfg.resumes || []).find(r => r.id === cfg.defaultResumeId)?.text || cfg.masterResume || ''
                    const res = await window.api.generateInterviewQuestions(selected.job_description || '', resume)
                    setLoadingQuestions(false)
                    if (res.success) setInterviewQuestions(res.questions)
                  }}>
                  {loadingQuestions ? 'Generating...' : 'Interview Questions'}
                </button>
              )}
              {selected.job_description && (
                <button className="btn btn-ghost" style={{ fontSize: 12 }}
                  disabled={loadingGap}
                  onClick={async () => {
                    setLoadingGap(true)
                    const cfg = await window.api.getConfig()
                    const resume = (cfg.resumes || []).find(r => r.id === cfg.defaultResumeId)?.text || cfg.masterResume || ''
                    const res = await window.api.analyzeKeywordGap(selected.job_description, resume)
                    setLoadingGap(false)
                    if (res.success) setKeywordGap({ missing: res.missing || [], present: res.present || [] })
                  }}>
                  {loadingGap ? 'Analyzing...' : 'Keyword Gap'}
                </button>
              )}
              {selected.status === 'skipped' && (
                <button className="btn btn-primary" style={{ fontSize: 12 }}
                  onClick={() => aiApplySkipped(selected)}>
                  AI Apply
                </button>
              )}
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
                onClick={async () => {
                  if (!window.confirm(`Blacklist ${selected.company}? It will be excluded from future scans.`)) return
                  await window.api.blacklistCompany(selected.company)
                }}>
                Blacklist Company
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <a href={selected.job_url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', fontSize: 13 }}>View original posting →</a>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ marginBottom: 6 }}>Comment</label>
              <textarea
                defaultValue={selected.comment || ''}
                placeholder="Add a note about this application..."
                onBlur={e => saveComment(selected.id, e.target.value)}
                style={{ minHeight: 60, resize: 'vertical', fontSize: 13 }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ marginBottom: 6 }}>
                Recruiter Email
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                  (follow-up emails go here; leave blank to receive them yourself)
                </span>
              </label>
              <input
                type="email"
                key={selected.id}
                defaultValue={selected.recruiter_email || ''}
                placeholder="recruiter@company.com"
                onBlur={e => saveRecruiterEmail(selected.id, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                style={{ fontSize: 13 }}
              />
            </div>

            {selected.job_description && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8 }}>Job Description</label>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto',
                }}>{selected.job_description}</pre>
              </div>
            )}

            {selected.cover_letter && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ marginBottom: 0 }}>Cover Letter</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={pdfLoading}
                      onClick={() => viewPDF(selected.cover_letter, 'Cover Letter', true)}>
                      {pdfLoading ? 'Loading...' : 'View PDF'}
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => window.api.downloadResume(selected.cover_letter, `Cover Letter - ${selected.job_title} - ${selected.company}`, 'pdf', 'coverLetter')}>
                      Save PDF
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => window.api.downloadResume(selected.cover_letter, `Cover Letter - ${selected.job_title} - ${selected.company}`, 'docx', 'coverLetter')}>
                      Save DOCX
                    </button>
                  </div>
                </div>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
                }}>{stripMd(selected.cover_letter)}</pre>
              </div>
            )}

            {selected.tailored_resume && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ marginBottom: 0 }}>Tailored Resume</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={pdfLoading}
                      onClick={() => viewPDF(selected.tailored_resume, 'Tailored Resume')}>
                      {pdfLoading ? 'Loading...' : 'View PDF'}
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => window.api.downloadResume(selected.tailored_resume, `Resume - ${selected.job_title} - ${selected.company}`, 'pdf')}>
                      Save PDF
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => window.api.downloadResume(selected.tailored_resume, `Resume - ${selected.job_title} - ${selected.company}`, 'docx')}>
                      Save DOCX
                    </button>
                  </div>
                </div>
                <pre style={{
                  background: 'var(--surface2)', borderRadius: 8, padding: 12,
                  fontSize: 12, whiteSpace: 'pre-wrap',
                  maxHeight: resumeExpanded ? 'none' : 200, overflow: 'auto',
                }}>{stripMd(selected.tailored_resume)}</pre>
              </div>
            )}

            {safeParseJSON(selected.screening_qa).length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8 }}>Screening Q&A</label>
                {safeParseJSON(selected.screening_qa).map((qa, i) => (
                  <div key={i} style={{ marginBottom: 10, padding: 12, background: 'var(--surface2)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4, fontSize: 13 }}>Q: {qa.question}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>A: {qa.answer}</div>
                  </div>
                ))}
              </div>
            )}

            {interviewQuestions && interviewQuestions.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8 }}>Interview Questions & Sample Answers</label>
                {interviewQuestions.map((item, i) => {
                  const q = typeof item === 'string' ? item : item.question
                  const a = typeof item === 'string' ? null : item.answer
                  return (
                    <div key={i} style={{ marginBottom: 10, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                      <div style={{ padding: '8px 12px', background: 'var(--surface2)', fontSize: 13, fontWeight: 500, borderLeft: '3px solid var(--accent)' }}>
                        {i + 1}. {q}
                      </div>
                      {a && (
                        <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                          {a}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {keywordGap && (
              <div>
                <label style={{ marginBottom: 8 }}>Keyword Gap</label>
                {keywordGap.missing.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Missing from your resume:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {keywordGap.missing.map(k => <span key={k} className="badge badge-red">{k}</span>)}
                    </div>
                  </div>
                )}
                {keywordGap.present.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Present in your resume:</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {keywordGap.present.map(k => <span key={k} className="badge badge-green">{k}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {skippedApplying && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div className="card" style={{ width: 560, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16 }}>AI Applying...</h2>
              {skippedApplyResult && (
                <button className="btn btn-ghost" onClick={() => { setSkippedApplying(false); setSkippedApplyLog([]); setSkippedApplyResult(null) }}>Close</button>
              )}
            </div>
            <div style={{
              flex: 1, overflowY: 'auto', background: 'var(--surface2)',
              borderRadius: 8, padding: '12px 14px', fontFamily: 'monospace',
              fontSize: 12, minHeight: 160,
            }}>
              {skippedApplyLog.map((line, i) => (
                <div key={i} style={{ marginBottom: 4, color: 'var(--text-muted)' }}>{line}</div>
              ))}
              <div ref={skippedLogEndRef} />
            </div>
            {skippedApplyResult && (
              <div style={{
                marginTop: 16, padding: '12px 14px', borderRadius: 8,
                background: skippedApplyResult.success ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: skippedApplyResult.success ? 'var(--green)' : 'var(--red)',
                fontSize: 13, fontWeight: 600,
              }}>
                {skippedApplyResult.success ? 'Application submitted successfully!' : `Failed: ${skippedApplyResult.reason}`}
              </div>
            )}
            {!skippedApplyResult && (
              <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
                A browser window will open — please do not close it.
              </div>
            )}
          </div>
        </div>
      )}

      {pdfModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }}>
          <div style={{
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
    </div>
  )
}
