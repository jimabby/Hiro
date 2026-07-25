import { useState, useEffect, useRef, useMemo } from 'react'

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
  offer: { label: 'Offer', color: 'badge-green' },
  rejected: { label: 'Rejected', color: 'badge-red' },
  pending: { label: 'Pending', color: 'badge-yellow' },
  skipped: { label: 'Skipped', color: 'badge-gray' },
}

const PAGE_SIZE = 25

const CATEGORY_COLORS = {
  behavioral: 'var(--accent)',
  technical: 'var(--green)',
  situational: 'var(--yellow)',
  'role-specific': 'var(--red)',
}

function InterviewPrepPanel({ questions, applicationId, jobDescription }) {
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [revealedAnswers, setRevealedAnswers] = useState(new Set())
  const [practiceMode, setPracticeMode] = useState(false)
  const [followUps, setFollowUps] = useState({})
  const [loadingFollowUp, setLoadingFollowUp] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const categories = ['all', ...new Set(questions.map(q => (typeof q === 'string' ? 'general' : q.category || 'general')))]

  // Carry the original index along — keying reveal/follow-up state by
  // indexOf(item) broke when two questions were identical strings.
  const filtered = questions
    .map((item, globalIdx) => ({ item, globalIdx }))
    .filter(({ item }) => {
      if (categoryFilter === 'all') return true
      const cat = typeof item === 'string' ? 'general' : item.category || 'general'
      return cat === categoryFilter
    })

  const toggleReveal = (i) => {
    setRevealedAnswers(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  const revealAll = () => setRevealedAnswers(new Set(questions.map((_, i) => i)))
  const hideAll = () => setRevealedAnswers(new Set())

  const generateFollowUp = async (i, question, answer) => {
    setLoadingFollowUp(i)
    try {
      const res = await window.api.generateInterviewFollowUp(question, answer, jobDescription)
      if (res.success) setFollowUps(prev => ({ ...prev, [i]: res.question }))
    } catch { /* ignore */ }
    setLoadingFollowUp(null)
  }

  const savePrep = async () => {
    setSaving(true)
    await window.api.saveInterviewPrep(applicationId, questions)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <label style={{ marginBottom: 0 }}>Interview Prep</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => { setPracticeMode(!practiceMode); practiceMode ? revealAll() : hideAll() }}>
            {practiceMode ? 'Show Answers' : 'Practice Mode'}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={saving} onClick={savePrep}>
            {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {categories.map(cat => (
          <button key={cat} onClick={() => setCategoryFilter(cat)} style={{
            background: categoryFilter === cat ? 'var(--accent)' : 'var(--surface2)',
            color: categoryFilter === cat ? '#fff' : 'var(--text-muted)',
            border: 'none', borderRadius: 12, padding: '3px 10px', fontSize: 11, cursor: 'pointer', textTransform: 'capitalize',
          }}>
            {cat}
          </button>
        ))}
      </div>

      {filtered.map(({ item, globalIdx }) => {
        const q = typeof item === 'string' ? item : item.question
        const a = typeof item === 'string' ? null : item.answer
        const cat = typeof item === 'string' ? 'general' : item.category || 'general'
        const isRevealed = revealedAnswers.has(globalIdx)

        return (
          <div key={globalIdx} style={{ marginBottom: 10, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div style={{ padding: '8px 12px', background: 'var(--surface2)', fontSize: 13, fontWeight: 500, borderLeft: `3px solid ${CATEGORY_COLORS[cat] || 'var(--accent)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <span>{globalIdx + 1}. {q}</span>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: CATEGORY_COLORS[cat] || 'var(--accent)', color: '#fff', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {cat}
              </span>
            </div>
            {a && (
              <div style={{ padding: '8px 12px' }}>
                {practiceMode && !isRevealed ? (
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => toggleReveal(globalIdx)}>
                    Reveal Answer
                  </button>
                ) : (
                  <div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 6 }}>{a}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {practiceMode && <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => toggleReveal(globalIdx)}>Hide</button>}
                      {!followUps[globalIdx] && (
                        <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={loadingFollowUp === globalIdx}
                          onClick={() => generateFollowUp(globalIdx, q, a)}>
                          {loadingFollowUp === globalIdx ? 'Generating...' : 'Follow-up Question'}
                        </button>
                      )}
                    </div>
                    {followUps[globalIdx] && (
                      <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, border: '1px dashed var(--border)' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Follow-up:</div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{followUps[globalIdx]}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function Dashboard({ active = true, logs, scanRunning, onScanStart, onDryRun, onClearLogs, showToast }) {
  const [stats, setStats] = useState(null)
  const [apps, setApps] = useState([])
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState({ status: '', platform: '', search: '' })
  const [sort, setSort] = useState({ key: 'applied_at', dir: 'desc' })
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [resumeExpanded, setResumeExpanded] = useState(false)
  const [interviewQuestions, setInterviewQuestions] = useState(null)
  const [loadingQuestions, setLoadingQuestions] = useState(false)
  const [keywordGap, setKeywordGap] = useState(null)
  const [statusHistory, setStatusHistory] = useState([])
  const [loadingGap, setLoadingGap] = useState(false)
  const [pdfModal, setPdfModal] = useState(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [skippedApplying, setSkippedApplying] = useState(false)
  const [skippedApplyLog, setSkippedApplyLog] = useState([])
  const [skippedApplyResult, setSkippedApplyResult] = useState(null)
  const [logCollapsed, setLogCollapsed] = useState(false)
  const [scanInfo, setScanInfo] = useState(null)
  const [interviews, setInterviews] = useState([])
  const [appInterviews, setAppInterviews] = useState([])
  const [newInterviewAt, setNewInterviewAt] = useState('')
  // Which failure the user dismissed, keyed by its timestamp — a plain boolean
  // would be undone by the next refetch, and a later failure must reappear.
  const [dismissedScanAt, setDismissedScanAt] = useState(null)
  const skippedLogEndRef = useRef(null)
  const logRef = useRef(null)
  const searchRef = useRef(null)

  useEffect(() => { loadData() }, [])

  const prevScanRunning = useRef(scanRunning)
  useEffect(() => {
    if (prevScanRunning.current && !scanRunning) loadData()
    prevScanRunning.current = scanRunning
  }, [scanRunning])

  // Refresh the scan outcome on mount, whenever a scan ends, and each time the
  // Dashboard is revisited (pages stay mounted, so there's no remount to rely on).
  useEffect(() => {
    if (!active && scanInfo) return
    window.api.getScanInfo?.().then(setScanInfo).catch(() => {})
  }, [active, scanRunning])

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
    setStatusHistory([])
    setAppInterviews([])
    setNewInterviewAt('')
    if (selected?.id) {
      window.api.getInterviewPrep(selected.id).then(saved => {
        if (saved?.questions) {
          try { setInterviewQuestions(JSON.parse(saved.questions)) } catch { /* ignore */ }
        }
      })
      window.api.getStatusHistory?.(selected.id).then(h => setStatusHistory(h || [])).catch(() => {})
      window.api.getInterviewEvents?.(selected.id).then(e => setAppInterviews(e || [])).catch(() => {})
    }
  }, [selected?.id])

  async function viewPDF(text, title, isCoverLetter = false) {
    setPdfLoading(true)
    try {
      const res = isCoverLetter
        ? await window.api.getCoverLetterPDFBase64(text)
        : await window.api.getResumePDFBase64(text)
      if (res.success) setPdfModal({ base64: res.base64, title })
      else showToast?.(res.error || 'Could not build the PDF', 'error')
    } catch (err) {
      showToast?.(`Could not build the PDF: ${err.message}`, 'error')
    } finally {
      setPdfLoading(false)
    }
  }

  // Sort + filter logic
  const filtered = useMemo(() => {
    let result = apps.filter(a => {
      if (filter.status && a.status !== filter.status) return false
      if (filter.platform && a.platform !== filter.platform) return false
      if (filter.search) {
        const q = filter.search.toLowerCase()
        if (!(a.job_title || '').toLowerCase().includes(q) && !(a.company || '').toLowerCase().includes(q)) return false
      }
      return true
    })

    // Sort
    result.sort((a, b) => {
      let va = a[sort.key], vb = b[sort.key]
      if (sort.key === 'match_score') { va = va || 0; vb = vb || 0 }
      if (sort.key === 'applied_at') { va = va || ''; vb = vb || '' }
      if (typeof va === 'number' && typeof vb === 'number') {
        return sort.dir === 'asc' ? va - vb : vb - va
      }
      va = String(va || '').toLowerCase()
      vb = String(vb || '').toLowerCase()
      return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    })

    return result
  }, [apps, filter, sort])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  // Reset page when filters change
  useEffect(() => { setCurrentPage(1) }, [filter, sort])

  function toggleSort(key) {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'desc' }
    )
  }

  function sortIndicator(key) {
    if (sort.key !== key) return ''
    return sort.dir === 'asc' ? ' ▲' : ' ▼'
  }

  // Bulk selection. Selection persists across pages, so both the header
  // checkbox state and the toggle must look at THIS page's rows only —
  // comparing raw set size to page length showed "all selected" on pages
  // where nothing was selected.
  const allPagedSelected = paged.length > 0 && paged.every(a => selectedIds.has(a.id))

  function toggleSelectAll() {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allPagedSelected) paged.forEach(a => next.delete(a.id))
      else paged.forEach(a => next.add(a.id))
      return next
    })
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function bulkChangeStatus(newStatus) {
    for (const id of selectedIds) {
      await window.api.updateApplicationStatus(id, newStatus)
    }
    setApps(prev => prev.map(a => selectedIds.has(a.id) ? { ...a, status: newStatus } : a))
    showToast?.(`${selectedIds.size} jobs updated to ${newStatus}`, 'success')
    setSelectedIds(new Set())
  }

  async function bulkDelete() {
    if (!window.confirm(`Delete ${selectedIds.size} selected applications? This cannot be undone.`)) return
    for (const id of selectedIds) {
      await window.api.deleteApplication(id)
    }
    setApps(prev => prev.filter(a => !selectedIds.has(a.id)))
    showToast?.(`${selectedIds.size} applications deleted`, 'success')
    setSelectedIds(new Set())
    setCurrentPage(1)
    if (selected && selectedIds.has(selected.id)) setSelected(null)
  }

  useEffect(() => {
    // The Dashboard stays mounted (hidden) on other pages — without the
    // `active` gate its shortcuts kept swallowing "/" and arrows everywhere.
    if (!active) return
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
          const idx = paged.findIndex(a => a.id === selected.id)
          if (idx < paged.length - 1) { setSelected(paged[idx + 1]); setResumeExpanded(false) }
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          const idx = paged.findIndex(a => a.id === selected.id)
          if (idx > 0) { setSelected(paged[idx - 1]); setResumeExpanded(false) }
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, selected, paged, pdfModal])

  async function loadData() {
    const [s, a, iv] = await Promise.all([
      window.api.getStats(),
      window.api.getApplications({}),
      window.api.getUpcomingInterviews?.(10).catch(() => []) ?? [],
    ])
    setStats(s)
    setApps(a)
    setInterviews(iv || [])
  }

  async function stopScan() {
    await window.api.stopAutomation()
  }

  async function aiApplySkipped(job) {
    setSelected(null)
    setSkippedApplying(true)
    setSkippedApplyLog([`Starting AI apply for ${job.job_title} at ${job.company}...`])
    setSkippedApplyResult(null)
    // Always set a result — the modal's only Close button is gated on it, so
    // an unhandled rejection here trapped the user in the modal forever.
    let result
    try {
      result = await window.api.applySkippedJob(job.id)
    } catch (err) {
      result = { success: false, reason: err.message }
    }
    setSkippedApplyResult(result)
    if (result.success) {
      setApps(prev => prev.map(a => a.id === job.id ? { ...a, status: 'applied' } : a))
      loadData()
    }
  }

  async function changeStatus(id, status, e) {
    e.stopPropagation()
    const prev = apps.find(a => a.id === id)?.status
    await window.api.updateApplicationStatus(id, status)
    setApps(prev => prev.map(a => a.id === id ? { ...a, status } : a))
    if (selected?.id === id) {
      setSelected(s => ({ ...s, status }))
      window.api.getStatusHistory?.(id).then(h => setStatusHistory(h || [])).catch(() => {})
    }
    if (prev && prev !== status) {
      showToast?.(`Status changed to ${status}`, 'info')
    }
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
          <button className="btn btn-ghost" onClick={onDryRun} disabled={scanRunning}
            title="Score and tailor every found job without submitting — useful for tuning the match threshold">
            Test Scan
          </button>
          <button className="btn btn-primary" onClick={onScanStart} disabled={scanRunning}>
            {scanRunning ? 'Scanning...' : 'Run Scan Now'}
          </button>
        </div>
      </div>

      {/* Last-scan outcome. A toast is easy to miss and disappears — a failed
          overnight scan should still be visible the next morning. */}
      {scanInfo?.lastScanError && !scanRunning && scanInfo.lastScanAt !== dismissedScanAt && (
        <div className="card" style={{
          marginBottom: 16, padding: '12px 16px', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', gap: 12,
          borderLeft: '3px solid var(--red)',
        }}>
          <div style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--red)', fontWeight: 600 }}>Last scan failed</span>
            <span style={{ color: 'var(--text-muted)' }}>
              {scanInfo.lastScanAt ? ` · ${new Date(scanInfo.lastScanAt).toLocaleString()}` : ''}
              {' — '}{scanInfo.lastScanError}
            </span>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
            onClick={() => setDismissedScanAt(scanInfo.lastScanAt)}>
            Dismiss
          </button>
        </div>
      )}

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
            {
              label: 'This Week',
              value: stats.totalThisWeek,
              ...(stats.totalLastWeek != null && (stats.totalLastWeek > 0 || stats.totalThisWeek > 0) ? {
                sub: `${stats.totalThisWeek >= stats.totalLastWeek ? '▲' : '▼'} ${Math.abs(stats.totalThisWeek - stats.totalLastWeek)} vs last week`,
                subColor: stats.totalThisWeek >= stats.totalLastWeek ? 'var(--green)' : 'var(--red)',
              } : {}),
            },
            { label: 'All Time', value: stats.totalAllTime },
            { label: 'Interviews', value: stats.interviews },
            { label: 'Response Rate', value: stats.responseRate != null ? `${stats.responseRate}%` : '—' },
          ].map(s => (
            <div key={s.label} className="card stat-card">
              <div className="stat-value">{s.value}</div>
              <div className="stat-label">{s.label}</div>
              {s.sub && <div style={{ fontSize: 11, color: s.subColor || 'var(--text-muted)', marginTop: 2 }}>{s.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Upcoming interviews — detected from recruiter replies, or added by hand */}
      {interviews.length > 0 && (
        <div className="card" style={{ marginBottom: 24, borderLeft: '3px solid var(--green)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Upcoming Interviews</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              detected from recruiter replies — click a row to open the application
            </span>
          </div>
          {interviews.map(iv => {
            const when = new Date(iv.scheduled_at.replace(' ', 'T'))
            const days = Math.round((when - new Date()) / 86400000)
            const rel = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
            return (
              <div key={iv.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 6,
                cursor: 'pointer',
              }}
                onClick={() => {
                  const app = apps.find(a => a.id === iv.application_id)
                  if (app) setSelected(app)
                }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {iv.job_title} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {iv.company}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                    {iv.has_time ? ` at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (time not detected)'}
                    {iv.source === 'inbox' && ' · auto-detected'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: days <= 1 ? 'var(--green)' : 'var(--surface)',
                    color: days <= 1 ? '#fff' : 'var(--text-muted)',
                  }}>{rel}</span>
                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={async (e) => {
                      e.stopPropagation()
                      await window.api.deleteInterviewEvent(iv.id)
                      setInterviews(prev => prev.filter(x => x.id !== iv.id))
                    }}
                    title="Remove from this list (the application is unchanged)">
                    Dismiss
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: logCollapsed ? 0 : 10 }}>
            <button onClick={() => setLogCollapsed(c => !c)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)',
            }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Activity Log</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{logCollapsed ? '▼' : '▲'}</span>
            </button>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{logs.length} entries</span>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => window.api.openLogFile?.()}
                title="Open the full persistent log file (survives restarts)">
                Open file
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--red)' }}
                onClick={() => { if (window.confirm('Clear the activity log? This deletes the saved log file too.')) onClearLogs?.() }}>
                Clear
              </button>
            </div>
          </div>
          {!logCollapsed && <div className="log-box" ref={logRef}>{logs.join('\n')}</div>}
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
            { value: 'offer', label: 'Offer' },
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

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-muted)' }}>{filtered.length} job{filtered.length !== 1 ? 's' : ''}</span>
            {/* Bulk actions */}
            {selectedIds.size > 0 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
                <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{selectedIds.size} selected</span>
                <select
                  defaultValue=""
                  onChange={e => { if (e.target.value) bulkChangeStatus(e.target.value); e.target.value = '' }}
                  style={{ width: 'auto', padding: '3px 6px', fontSize: 11 }}
                >
                  <option value="" disabled>Set status...</option>
                  <option value="applied">Applied</option>
                  <option value="interview">Interview</option>
                  <option value="offer">Offer</option>
                  <option value="rejected">Rejected</option>
                  <option value="pending">Pending</option>
                </select>
                <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)', padding: '2px 8px' }} onClick={bulkDelete}>Delete</button>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={searchRef}
              value={filter.search}
              onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
              placeholder="Search... (/)"
              style={{ width: 180, padding: '6px 10px', fontSize: 12 }}
            />
            <select value={filter.platform} onChange={e => setFilter(f => ({ ...f, platform: e.target.value }))} style={{ width: 180, padding: '6px 10px', fontSize: 12 }}>
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
            <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>▦</div>
            No jobs yet. Run a scan to get started.
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32, padding: '10px 8px' }}>
                      <input type="checkbox"
                        checked={allPagedSelected}
                        onChange={toggleSelectAll}
                        aria-label="Select all rows on this page"
                        style={{ width: 'auto' }}
                      />
                    </th>
                    <th className="sortable" onClick={() => toggleSort('job_title')}>Role{sortIndicator('job_title')}</th>
                    <th className="sortable" onClick={() => toggleSort('company')}>Company{sortIndicator('company')}</th>
                    <th className="sortable" onClick={() => toggleSort('platform')}>Platform{sortIndicator('platform')}</th>
                    <th className="sortable" onClick={() => toggleSort('match_score')}>Match{sortIndicator('match_score')}</th>
                    <th>Comment</th>
                    <th className="sortable" onClick={() => toggleSort('status')}>Status{sortIndicator('status')}</th>
                    <th className="sortable" onClick={() => toggleSort('applied_at')}>Date{sortIndicator('applied_at')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map(a => (
                    <tr key={a.id} style={{ cursor: 'pointer', background: selectedIds.has(a.id) ? 'var(--surface2)' : undefined }} onClick={() => { setSelected(a); setResumeExpanded(false) }}>
                      <td style={{ padding: '10px 8px' }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox"
                          checked={selectedIds.has(a.id)}
                          onChange={() => toggleSelect(a.id)}
                          aria-label={`Select ${a.job_title} at ${a.company}`}
                          style={{ width: 'auto' }}
                        />
                      </td>
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
                            <option value="offer">Offer</option>
                            <option value="rejected">Rejected</option>
                            <option value="pending">Pending</option>
                          </select>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(a.applied_at).toLocaleDateString()}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)', padding: '2px 6px' }}
                          aria-label={`Delete ${a.job_title} at ${a.company}`} title="Delete"
                          onClick={e => deleteApp(a.id, e)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="pagination">
                <button disabled={currentPage === 1} onClick={() => setCurrentPage(1)}>«</button>
                <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>‹</button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let page
                  if (totalPages <= 7) {
                    page = i + 1
                  } else if (currentPage <= 4) {
                    page = i + 1
                  } else if (currentPage >= totalPages - 3) {
                    page = totalPages - 6 + i
                  } else {
                    page = currentPage - 3 + i
                  }
                  return (
                    <button key={page}
                      className={page === currentPage ? 'active' : ''}
                      onClick={() => setCurrentPage(page)}>
                      {page}
                    </button>
                  )
                })}
                <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)}>›</button>
                <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(totalPages)}>»</button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail modal */}
      {selected && (
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setSelected(null)}>
          <div className="card modal-content" style={{ width: '70vw', maxWidth: 900, maxHeight: '85vh', overflow: 'auto' }}
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
                {selected.closing_date && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Applications close {new Date(`${selected.closing_date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={async () => {
                    await window.api.deleteApplication(selected.id)
                    setApps(prev => prev.filter(a => a.id !== selected.id))
                    setSelected(null)
                  }}>Delete</button>
                <button className="btn btn-ghost" aria-label="Close details" onClick={() => setSelected(null)}>✕</button>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {(selected.status === 'applied' || selected.status === 'interview') && (
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
                  showToast?.(`${selected.company} blacklisted`, 'success')
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
                key={selected.id + '_comment'}
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

            {/* Interview time — auto-detected from the recruiter's reply where
                possible, always correctable here. */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ marginBottom: 8 }}>Interview</label>
              {appInterviews.length > 0 ? appInterviews.map(iv => (
                <div key={iv.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  padding: '8px 10px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 6,
                }}>
                  <div style={{ fontSize: 13 }}>
                    {new Date(iv.scheduled_at.replace(' ', 'T')).toLocaleString(undefined,
                      iv.has_time
                        ? { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
                        : { weekday: 'short', day: 'numeric', month: 'short' })}
                    <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>
                      {iv.source === 'inbox' ? 'auto-detected' : 'added by you'}
                    </span>
                  </div>
                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={async () => {
                      await window.api.deleteInterviewEvent(iv.id)
                      setAppInterviews(prev => prev.filter(x => x.id !== iv.id))
                      loadData()
                    }}>Remove</button>
                </div>
              )) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  No interview scheduled. One is added automatically when a recruiter reply
                  proposes a time.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="datetime-local" value={newInterviewAt}
                  onChange={e => setNewInterviewAt(e.target.value)} style={{ flex: 1, fontSize: 12 }} />
                <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }}
                  disabled={!newInterviewAt}
                  onClick={async () => {
                    // datetime-local gives "YYYY-MM-DDTHH:MM" in local time —
                    // the same wall-clock the DB column stores.
                    const scheduledAt = `${newInterviewAt.replace('T', ' ')}:00`
                    const res = await window.api.addInterviewEvent({
                      applicationId: selected.id, scheduledAt, hasTime: true,
                    })
                    if (res?.success) {
                      setNewInterviewAt('')
                      setAppInterviews(await window.api.getInterviewEvents(selected.id))
                      loadData()
                    } else {
                      showToast?.(res?.error || 'Could not save interview', 'error')
                    }
                  }}>Add</button>
              </div>
            </div>

            {statusHistory.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ marginBottom: 8 }}>Status History</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {statusHistory.map((h, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: i === statusHistory.length - 1 ? 'var(--accent)' : 'var(--border)',
                      }} />
                      <span className={`badge ${STATUS_BADGE[h.status]?.color || 'badge-gray'}`} style={{ minWidth: 70, textAlign: 'center' }}>
                        {STATUS_BADGE[h.status]?.label || h.status}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {/* changed_at is stored in UTC — render in local time */}
                        {new Date(h.changed_at.replace(' ', 'T') + 'Z').toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
              <InterviewPrepPanel questions={interviewQuestions} applicationId={selected.id} jobDescription={selected.job_description || ''} />
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
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}>
          <div className="card modal-content" style={{ width: 560, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
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
        <div className="modal-overlay" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }}>
          <div className="modal-content" style={{
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
