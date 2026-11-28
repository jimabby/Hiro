import { useCallback, useEffect, useRef, useState } from 'react'
import { splitDrafts, wordCount } from '../chatDrafts'
import { ParseCheck } from './settings/ParseCheck'

// Ask Hiro: one chat for two jobs.
//
//   Questions about your own job search, answered from your own data (see
//   services/askHiro.js). The assistant can suggest a scan, a page to open or a
//   follow-up date; a suggestion is a button, and nothing happens until it is
//   pressed — a follow-up additionally shows what it will set, editable, and
//   waits for a second confirm.
//
//   Your résumé, the way people use ChatGPT or Claude for it: attach a PDF or
//   Word file (or drop it on the chat, or pick one already saved in Settings),
//   optionally add the job ad, and ask for a review, a match check, a rewrite, a
//   tailored version or a cover letter. A full document comes back as a card
//   with Copy, PDF, Word and "Save to my résumés", and is checked against the
//   résumé for dates, employers and qualifications that were not in it.
//
// Replies stream in as they are written, and Stop keeps what was written so
// far. A job ad can be pasted, loaded from a file, or read from a link; an
// attached PDF or Word résumé can be run through the ATS readability check.
//
// Conversations are stored on the desktop (in the same database, so they are
// encrypted whenever the database is) together with the résumé and job ad they
// are about, and are listed beside the chat.

const SEARCH_STARTERS = [
  'Which applications have gone quiet for over two weeks?',
  'What do I need to do this week?',
  'Which platform gets me the most interviews?',
  'Summarise my search so far.',
]

const RESUME_STARTERS = [
  'Review my résumé and list the five changes that would help most.',
  'Rewrite my résumé to be clearer and stronger, without adding anything that is not true.',
  'Which of my bullet points are weakest, and how would you rewrite them?',
  'Make my résumé fit on one page.',
]

const JOB_STARTERS = [
  'How well does my résumé match this job? Be honest.',
  'Tailor my résumé to this job.',
  'Write a cover letter for this job.',
  'What interview questions should I expect for this job, given my résumé?',
]

const PAGE_LABELS = {
  dashboard: 'Dashboard', pipeline: 'Pipeline', offers: 'Offers', review: 'Review', attention: 'Needs Attention',
  timeline: 'Timeline', analytics: 'Analytics', settings: 'Settings', workbench: 'Workbench',
}

const ACCEPT = '.pdf,.docx,.txt,.md'
const MAX_FILE_BYTES = 10 * 1024 * 1024
const EMPTY_DOCS = { resumeName: '', resumeText: '', jobText: '' }
// A long pasted message (a résumé, a job ad) is folded in the history.
const FOLD_AT = 1500

const FLAG_LABELS = {
  date: 'date', credential: 'qualification', employer: 'employer', 'job-title': 'job title',
  heading: 'changed heading', 'moved-claim': 'moved claim', 'moved-bullet': 'bullet from another job', figure: 'new figure',
}

function newRequestId() {
  try { return crypto.randomUUID() } catch { return `r${Date.now()}${Math.random().toString(36).slice(2, 10)}` }
}

// What is shown of a reply still being written: an ACTIONS line is for the app,
// and is turned into buttons only once the reply is complete.
function visibleStream(text) {
  return String(text || '').replace(/\n?\s*ACTIONS:[\s\S]*$/, '')
}

// The question sent when the user asks for help with what the ATS check found.
function atsQuestion(result) {
  const lines = (result?.findings || []).map(f => `- ${f.title}: ${f.detail}`)
  return `An applicant tracking system check of my résumé file found these problems:\n${lines.join('\n')}\n\nHow do I fix them in my résumé? Be specific.`
}

// Confirm-to-apply for a suggested follow-up. The date and note are the
// model's proposal, shown as editable fields; the main process checks them
// again (the application still exists, the date is a real upcoming day).
function FollowUpConfirm({ action, onDone, onCancel, showToast }) {
  const [date, setDate] = useState(action.date)
  const [note, setNote] = useState(action.note || '')
  const [saving, setSaving] = useState(false)

  async function confirm() {
    setSaving(true)
    try {
      const res = await window.api.askHiroSetFollowUp(action.id, date, note)
      if (res?.success) {
        showToast?.(`Follow-up set for ${res.date}`, 'success')
        onDone?.()
      } else {
        showToast?.(res?.error || 'Could not set the follow-up', 'error')
      }
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div role="group" aria-label="Confirm follow-up" style={{ marginTop: 6, padding: 10, background: 'var(--surface2)', borderRadius: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Follow-up date
        <input type="date" aria-label="Follow-up date" value={date} onChange={e => setDate(e.target.value)} />
      </label>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 160 }}>
        Note
        <input aria-label="Follow-up note" value={note} maxLength={200} onChange={e => setNote(e.target.value)} />
      </label>
      <button className="btn btn-primary btn-sm" disabled={saving || !date} onClick={confirm}>{saving ? 'Saving…' : 'Confirm follow-up'}</button>
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  )
}

// A file's bytes. Blob.arrayBuffer where it exists (Chromium, so Electron);
// FileReader otherwise.
function readBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(b => new Uint8Array(b))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Could not read that file'))
    reader.readAsArrayBuffer(file)
  })
}

async function copyText(text, showToast, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    showToast?.(what, 'success')
  } catch {
    showToast?.('Could not copy to the clipboard', 'error')
  }
}

// A full résumé or cover letter the assistant wrote, with what can be done
// with it and what the fabrication check found.
function DraftCard({ draft, check, resumeName, onSave, showToast, pending = false }) {
  const isResume = draft.kind === 'resume'
  const label = isResume ? 'Résumé draft' : 'Cover letter draft'
  const fileBase = isResume ? `Resume${resumeName ? ` - ${resumeName}` : ''}` : 'Cover Letter'
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function download(format) {
    try {
      const res = await window.api.downloadResume(draft.text, fileBase, format, isResume ? 'resume' : 'coverLetter')
      if (res?.success) showToast?.(`Saved as ${format.toUpperCase()}`, 'success')
      else if (!res?.canceled) showToast?.(res?.error || 'Could not save the file', 'error')
    } catch (err) {
      showToast?.(err.message, 'error')
    }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await onSave(draft.text)
      if (res?.success) setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const flags = check?.flags || []
  const note = { padding: '6px 12px', fontSize: 11.5, borderBottom: '1px solid var(--border)' }
  return (
    <section aria-label={label} style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface2)' }}>
      <header style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
        <strong>{label}</strong> <span style={{ color: 'var(--text-muted)' }}>· {pending ? 'writing…' : `${wordCount(draft.text)} words`}</span>
      </header>
      {flags.length > 0 && (
        <div role="note" style={{ ...note, fontSize: 12, color: 'var(--amber)' }}>
          Check before using: {flags.length === 1 ? 'this is' : 'these are'} not in your résumé —{' '}
          {flags.map(f => `${FLAG_LABELS[f.kind] || f.kind} “${f.value}”`).join(', ')}. Keep {flags.length === 1 ? 'it' : 'them'} only if true.
        </div>
      )}
      {check?.checked && flags.length === 0 && (
        <div style={{ ...note, color: 'var(--green)' }}>✓ No dates, employers or qualifications that are not in your résumé.</div>
      )}
      {check && !check.checked && (
        <div style={{ ...note, color: 'var(--text-muted)' }}>Not checked against a résumé — attach yours to have drafts checked for invented facts.</div>
      )}
      <div style={{ padding: '10px 12px', fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.55, maxHeight: 420, overflow: 'auto' }}>{draft.text}</div>
      {!pending && (
        <footer style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
          {isResume && (
            <button className="btn btn-primary btn-sm" disabled={saving || saved} onClick={save}
              title="Add it to Settings → Resumes so scans can use it">
              {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save to my résumés'}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => copyText(draft.text, showToast, `${label} copied`)}>Copy</button>
          <button className="btn btn-ghost btn-sm" onClick={() => download('pdf')} title="Save as a PDF file">PDF</button>
          <button className="btn btn-ghost btn-sm" onClick={() => download('docx')} title="Save as a Word file">Word</button>
        </footer>
      )}
    </section>
  )
}

function UserText({ content }) {
  const [open, setOpen] = useState(false)
  if (content.length <= FOLD_AT || open) return content
  return (
    <>
      {content.slice(0, 600)}…{' '}
      <button className="btn btn-ghost btn-sm" style={{ color: 'inherit', textDecoration: 'underline', padding: 0 }} onClick={() => setOpen(true)}>
        Show all ({wordCount(content)} words)
      </button>
    </>
  )
}

export default function AskHiro({ showToast, onNavigate, onOpenApplication }) {
  const [threads, setThreads] = useState([])
  const [threadId, setThreadId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null) // `${messageIndex}:${actionIndex}`
  // What the conversation is about, sent with every question and stored on the thread.
  const [docs, setDocs] = useState(EMPTY_DOCS)
  // Where the attached résumé came from: { kind: 'upload', fileName, bytes } while
  // the file is still in hand (so saving keeps the original Word layout), or
  // { kind: 'saved', id } for one picked from Settings.
  const [resumeSource, setResumeSource] = useState(null)
  const [savedResumes, setSavedResumes] = useState([])
  const [reading, setReading] = useState(false)
  const [jobOpen, setJobOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // The reply being written, and the id that lets Stop name it.
  const [streamText, setStreamText] = useState('')
  const requestRef = useRef(null)
  const [jobUrl, setJobUrl] = useState('')
  const [readingLink, setReadingLink] = useState(false)
  const [atsOpen, setAtsOpen] = useState(false)
  const [atsResult, setAtsResult] = useState(null)
  const endRef = useRef(null)
  const fileRef = useRef(null)
  const jobFileRef = useRef(null)
  const dragDepth = useRef(0)

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [messages, busy, streamText])

  // Only the request this page is waiting for is shown; a late event from one
  // that has finished is ignored.
  useEffect(() => window.api.onAskHiroStream?.(({ requestId, text } = {}) => {
    if (requestId && requestId === requestRef.current) setStreamText(String(text || ''))
  }), [])

  const loadThreads = useCallback(async () => {
    try { setThreads((await window.api.askHiroThreads?.()) || []) } catch { /* the chat still works without the list */ }
  }, [])
  useEffect(() => { loadThreads() }, [loadThreads])

  const loadSavedResumes = useCallback(async () => {
    try {
      const cfg = await window.api.getConfig?.()
      setSavedResumes((cfg?.resumes || []).filter(r => r?.text).map(r => ({
        id: r.id, name: r.name, text: r.text, originalPath: r.originalPath || null, originalExt: r.originalExt || null,
      })))
    } catch { /* attaching a file still works */ }
  }, [])
  useEffect(() => { loadSavedResumes() }, [loadSavedResumes])

  async function openThread(id) {
    if (busy) return
    try {
      const t = await window.api.askHiroThread(id)
      if (!t) { showToast?.('That conversation no longer exists', 'error'); loadThreads(); return }
      setThreadId(t.id)
      setMessages(t.messages || [])
      setDocs({ ...EMPTY_DOCS, ...(t.documents || {}) })
      setResumeSource(null)
      setJobOpen(false)
      setAtsOpen(false)
      setAtsResult(null)
      setConfirming(null)
    } catch (err) {
      showToast?.(err.message, 'error')
    }
  }

  function newThread() {
    if (busy) return
    setThreadId(null)
    setMessages([])
    setDocs(EMPTY_DOCS)
    setResumeSource(null)
    setJobOpen(false)
    setAtsOpen(false)
    setAtsResult(null)
    setConfirming(null)
  }

  async function deleteThread(id) {
    const res = await window.api.askHiroDeleteThread(id)
    if (res?.success === false) { showToast?.(res.error || 'Could not delete that conversation', 'error'); return }
    if (id === threadId) newThread()
    loadThreads()
  }

  // Reads a file in the main process from its bytes. `target` is 'resume' or 'job'.
  async function attachFile(file, target = 'resume') {
    if (!file || reading) return
    if (file.size > MAX_FILE_BYTES) { showToast?.('That file is larger than 10 MB, which is far bigger than a résumé should be.', 'error'); return }
    setReading(true)
    try {
      const bytes = await readBytes(file)
      const res = await window.api.askHiroReadAttachment(file.name, bytes)
      if (!res?.success) { showToast?.(res?.error || 'Could not read that file', 'error'); return }
      if (target === 'job') {
        setDocs(d => ({ ...d, jobText: res.text }))
        setJobOpen(true)
      } else {
        setDocs(d => ({ ...d, resumeName: res.name, resumeText: res.text }))
        setResumeSource({ kind: 'upload', fileName: file.name, bytes })
        setAtsOpen(false)
        setAtsResult(null)
        showToast?.(`Attached ${res.name} (${res.words} words)${res.truncated ? ' — only the first part fits' : ''}`, 'success')
      }
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setReading(false)
    }
  }

  function pickSavedResume(id) {
    const r = savedResumes.find(x => x.id === id)
    if (!r) return
    setDocs(d => ({ ...d, resumeName: r.name, resumeText: r.text }))
    setResumeSource({ kind: 'saved', id: r.id })
    setAtsOpen(false)
    setAtsResult(null)
  }

  function removeResume() {
    setDocs(d => ({ ...d, resumeName: '', resumeText: '' }))
    setResumeSource(null)
    setAtsOpen(false)
    setAtsResult(null)
  }

  // A job ad from its link, read by the desktop.
  async function readJobLink() {
    const url = jobUrl.trim()
    if (!url || readingLink) return
    setReadingLink(true)
    try {
      const res = await window.api.askHiroReadJobLink(url)
      if (!res?.success) { showToast?.(res?.error || 'Could not read that link', 'error'); return }
      setDocs(d => ({ ...d, jobText: res.text }))
      setJobUrl('')
      setJobOpen(true)
      const what = [res.title, res.company].filter(Boolean).join(' at ')
      showToast?.(`Read ${what || 'the job ad'} (${res.words} words)${res.structured ? '' : ' — check it is the ad, not the whole page'}`, 'success')
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setReadingLink(false)
    }
  }

  // Which ATS check applies to the attached résumé: the file in hand, or the
  // original a saved résumé was imported from. Null when there is no file.
  const savedSource = resumeSource?.kind === 'saved' ? savedResumes.find(r => r.id === resumeSource.id) : null
  const uploadExt = resumeSource?.kind === 'upload' ? String(resumeSource.fileName || '').split('.').pop().toLowerCase() : ''
  const atsCheck = resumeSource?.kind === 'upload' && ['pdf', 'docx'].includes(uploadExt)
    ? () => window.api.askHiroCheckAttachment(resumeSource.fileName, resumeSource.bytes)
    : savedSource?.originalPath
      ? () => window.api.checkResumeParseable(savedSource.originalPath, savedSource.originalExt)
      : null

  // Keep a résumé from the chat: the attached one, or a draft written from it.
  async function saveResume(text, name) {
    try {
      const res = await window.api.askHiroSaveResume({
        name, text,
        ...(resumeSource?.kind === 'upload' ? { fileName: resumeSource.fileName, bytes: resumeSource.bytes } : {}),
        ...(resumeSource?.kind === 'saved' ? { sourceResumeId: resumeSource.id } : {}),
      })
      if (res?.success) {
        showToast?.(`Saved “${res.name}” to Settings → Resumes`, 'success')
        loadSavedResumes()
      } else {
        showToast?.(res?.error || 'Could not save the résumé', 'error')
      }
      return res
    } catch (err) {
      showToast?.(err.message, 'error')
      return { success: false }
    }
  }

  async function saveAttachedResume() {
    const res = await saveResume(docs.resumeText, docs.resumeName)
    if (res?.success) setResumeSource({ kind: 'saved', id: res.id })
  }

  async function send(text) {
    const q = String(text ?? input).trim()
    if (!q || busy) return
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setInput('')
    setBusy(true)
    const rid = newRequestId()
    requestRef.current = rid
    setStreamText('')
    try {
      // The history is the stored thread's, read by the main process — the page
      // only says which thread this question belongs to, and what it is about.
      const res = await window.api.askHiro(q, threadId, docs, rid)
      if (res?.threadId) setThreadId(res.threadId)
      if (res?.success) setMessages(prev => [...prev, { role: 'assistant', content: res.reply, actions: res.actions || [], stopped: !!res.stopped }])
      else setMessages(prev => [...prev, { role: 'assistant', content: res?.error || 'Something went wrong.', error: true }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: err.message, error: true }])
    } finally {
      requestRef.current = null
      setStreamText('')
      setBusy(false)
      loadThreads()
    }
  }

  function stop() {
    if (requestRef.current) window.api.askHiroStop?.(requestRef.current)
  }

  // Asks a failed question again. The failed pair stays in the stored thread
  // (it is never sent back to the model) but leaves the screen.
  function retry(index) {
    const question = messages[index - 1]?.role === 'user' ? messages[index - 1].content : null
    if (!question || busy) return
    setMessages(prev => prev.slice(0, index - 1))
    send(question)
  }

  async function runAction(a, key) {
    if (a.type === 'scan') {
      const res = await window.api.askHiroRunScan(a.keywords)
      if (res?.success) showToast?.(`Scan queued for "${a.keywords}" — drafts will wait in Review`, 'success')
      else showToast?.(res?.error || 'Could not queue the scan', 'error')
    } else if (a.type === 'open') {
      onNavigate?.(a.page)
    } else if (a.type === 'openApplication') {
      onOpenApplication?.(a.id)
    } else if (a.type === 'setFollowUp') {
      setConfirming(confirming === key ? null : key)
    }
  }

  const actionLabel = a => a.type === 'scan' ? `Scan for "${a.keywords}"`
    : a.type === 'open' ? `Open ${PAGE_LABELS[a.page] || a.page}`
      : a.type === 'setFollowUp' ? `Set follow-up${a.title ? ` for ${a.title}${a.company ? ` at ${a.company}` : ''}` : ''} on ${a.date}`
        : 'Open application'

  // Drag and drop anywhere on the chat. A counter, not a boolean: dragenter and
  // dragleave fire for every child the pointer crosses.
  const dropHandlers = {
    onDragEnter: e => { if (e.dataTransfer?.types?.includes?.('Files')) { e.preventDefault(); dragDepth.current++; setDragging(true) } },
    onDragOver: e => { if (e.dataTransfer?.types?.includes?.('Files')) e.preventDefault() },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) },
    onDrop: e => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) attachFile(file, 'resume')
    },
  }

  const hasResume = !!docs.resumeText
  const hasJob = !!docs.jobText.trim()
  const starters = hasJob ? JOB_STARTERS : hasResume ? RESUME_STARTERS : null

  const chip = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 4px 3px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, minWidth: 0, maxWidth: '100%' }
  const label = { fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase' }

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 64px)', maxWidth: 1180 }}>
      {/* Only once there is something to list: an empty column is just less room for the chat. */}
      {threads.length > 0 && (
        <aside aria-label="Conversations" style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto', paddingTop: 52 }}>
          <div style={label}>Conversations</div>
          {threads.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 2, borderRadius: 6, background: t.id === threadId ? 'var(--surface2)' : 'transparent' }}>
              <button className="btn btn-ghost btn-sm" style={{ flex: 1, minWidth: 0, display: 'block', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: 'none', background: 'transparent' }}
                aria-current={t.id === threadId ? 'true' : undefined} onClick={() => openThread(t.id)} title={t.title}>
                {t.title || 'Conversation'}
                {t.has_resume ? <span style={{ color: 'var(--text-muted)' }} aria-label="with résumé" title="Has a résumé attached"> · résumé</span> : null}
              </button>
              <button className="btn btn-ghost btn-sm" style={{ border: 'none', background: 'transparent' }} aria-label={`Delete conversation ${t.title}`} title="Delete conversation" onClick={() => deleteThread(t.id)}>×</button>
            </div>
          ))}
        </aside>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>Ask Hiro</h1>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
              Get your résumé reviewed, rewritten or tailored to a job, or ask about your applications. Nothing changes until you press a button.
            </p>
          </div>
          {(messages.length > 0 || hasResume || hasJob) && (
            <button className="btn btn-ghost btn-sm" onClick={newThread} disabled={busy}>+ New conversation</button>
          )}
        </div>

        <div className="card" data-testid="ask-chat" {...dropHandlers}
          style={{ flex: 1, minHeight: 220, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, position: 'relative', outline: dragging ? '2px dashed var(--accent)' : undefined }}
          aria-live="polite">
          {dragging && (
            <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--scrim)', fontSize: 15, fontWeight: 600, zIndex: 2, pointerEvents: 'none' }}>
              Drop your résumé to attach it
            </div>
          )}
          {messages.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {!hasResume && (
                <div style={{ padding: '20px 16px', border: '1px dashed var(--border-strong)', borderRadius: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>Start with your résumé</div>
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px auto 12px', maxWidth: 520, lineHeight: 1.5 }}>
                    Drop a PDF or Word file anywhere here, or paste it into the message box.
                    Add a job ad to check your fit, tailor your résumé or write a cover letter.
                  </p>
                  <button className="btn btn-primary btn-sm" disabled={reading} onClick={() => fileRef.current?.click()}>
                    {reading ? 'Reading…' : 'Attach résumé'}
                  </button>
                  {savedResumes.length > 0 && (
                    <div style={{ marginTop: 12, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>or use one you saved:</span>
                      {savedResumes.map(r => (
                        <button key={r.id} className="btn btn-ghost btn-sm" onClick={() => pickSavedResume(r.id)}>{r.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {starters && (
                <div>
                  <div style={label}>{hasJob ? 'About this job' : 'About your résumé'}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {starters.map(s => <button key={s} className="btn btn-ghost btn-sm" onClick={() => send(s)}>{s}</button>)}
                  </div>
                  {!hasJob && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                      Applying somewhere? <button className="btn btn-ghost btn-sm" onClick={() => setJobOpen(true)}>Add the job ad</button> to tailor your résumé to it.
                    </p>
                  )}
                </div>
              )}
              <div>
                <div style={label}>About your job search</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {SEARCH_STARTERS.map(s => <button key={s} className="btn btn-ghost btn-sm" onClick={() => send(s)}>{s}</button>)}
                </div>
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const checks = (m.actions || []).filter(a => a.type === 'draft')
            const buttons = (m.actions || []).filter(a => a.type !== 'draft')
            const segments = m.role === 'assistant' && !m.error ? splitDrafts(m.content) : [{ type: 'text', text: m.content }]
            return (
              <div key={m.id ?? `local-${i}`} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: m.role === 'user' ? '80%' : '92%', width: segments.some(s => s.type === 'draft') ? '92%' : undefined }}>
                {segments.map((seg, k) => seg.type === 'draft' ? (
                  <DraftCard key={k} draft={seg} check={checks[seg.index]} resumeName={docs.resumeName} showToast={showToast}
                    onSave={text => saveResume(text, `${docs.resumeName || 'Résumé'} (${seg.kind === 'resume' ? 'rewritten' : 'letter'})`)} />
                ) : (
                  <div key={k} style={{
                    padding: '9px 13px', borderRadius: 12, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: k ? 6 : 0,
                    background: m.role === 'user' ? 'var(--accent)' : 'var(--surface2)',
                    color: m.role === 'user' ? '#fff' : m.error ? 'var(--red)' : 'var(--text)',
                  }}>{m.role === 'user' ? <UserText content={seg.text} /> : seg.text}</div>
                ))}
                {m.role === 'assistant' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                    {m.stopped && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Stopped</span>}
                    {m.error
                      ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => retry(i)}>Try again</button>
                      : <button className="btn btn-ghost btn-sm" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)' }} aria-label="Copy reply" onClick={() => copyText(m.content.replace(/^<<<(RESUME|COVER_LETTER|END)>>>$/gm, '').trim(), showToast, 'Reply copied')}>Copy</button>}
                  </div>
                )}
                {buttons.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    {buttons.map((a, j) => (
                      <button key={j} className="btn btn-ghost btn-sm" onClick={() => runAction(a, `${i}:${j}`)}>{actionLabel(a)}</button>
                    ))}
                  </div>
                )}
                {buttons.map((a, j) => a.type === 'setFollowUp' && confirming === `${i}:${j}` && (
                  <FollowUpConfirm key={`confirm-${j}`} action={a} showToast={showToast}
                    onDone={() => setConfirming(null)} onCancel={() => setConfirming(null)} />
                ))}
              </div>
            )
          })}
          {busy && !visibleStream(streamText).trim() && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Thinking…</div>}
          {busy && visibleStream(streamText).trim() && (
            <div data-testid="ask-streaming" style={{ alignSelf: 'flex-start', maxWidth: '92%', width: /<<<(RESUME|COVER_LETTER)>>>/.test(streamText) ? '92%' : undefined }}>
              {splitDrafts(visibleStream(streamText)).map((seg, k) => seg.type === 'draft' ? (
                <DraftCard key={k} draft={seg} pending showToast={showToast} />
              ) : (
                <div key={k} style={{ padding: '9px 13px', borderRadius: 12, fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: k ? 6 : 0, background: 'var(--surface2)' }}>{seg.text}</div>
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Panels for the attachments, capped so the conversation keeps the screen. */}
        {((hasResume && atsOpen && atsCheck) || jobOpen) && (
          <div style={{ marginTop: 10, maxHeight: '34vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hasResume && atsOpen && atsCheck && (
              <div aria-label="ATS readability" style={{ fontSize: 12, padding: '10px 12px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
                  <strong style={{ flex: 1 }}>Can an applicant tracking system read “{docs.resumeName}”?</strong>
                  <button className="btn btn-ghost btn-sm" style={{ border: 'none', background: 'transparent' }} aria-label="Close ATS check" onClick={() => setAtsOpen(false)}>×</button>
                </div>
                <ParseCheck key={resumeSource?.kind === 'saved' ? resumeSource.id : resumeSource?.fileName} runCheck={atsCheck} onResult={setAtsResult} />
                {atsResult?.ok && atsResult.findings?.length > 0 && (
                  <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={busy} onClick={() => { setAtsOpen(false); send(atsQuestion(atsResult)) }}>
                    Ask Hiro how to fix these
                  </button>
                )}
              </div>
            )}
            {jobOpen && (
              <div aria-label="Job ad editor" style={{ fontSize: 12, padding: '10px 12px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <strong style={{ flex: 1 }}>The job ad</strong>
                  <button className="btn btn-ghost btn-sm" disabled={reading} onClick={() => jobFileRef.current?.click()}>From file…</button>
                  <button className="btn btn-primary btn-sm" onClick={() => setJobOpen(false)}>Done</button>
                </div>
                <form style={{ display: 'flex', gap: 6, marginTop: 8 }} onSubmit={e => { e.preventDefault(); readJobLink() }}>
                  <input aria-label="Job ad link" type="url" value={jobUrl} onChange={e => setJobUrl(e.target.value)}
                    placeholder="Paste a link to the posting…" style={{ flex: 1, fontSize: 12 }} />
                  <button className="btn btn-ghost btn-sm" type="submit" disabled={readingLink || !jobUrl.trim()}>{readingLink ? 'Reading…' : 'Read link'}</button>
                </form>
                <textarea aria-label="Job ad" value={docs.jobText} rows={5} maxLength={40000}
                  placeholder="…or paste the ad itself: title, company, responsibilities and requirements."
                  onChange={e => setDocs(d => ({ ...d, jobText: e.target.value }))}
                  style={{ width: '100%', marginTop: 6, resize: 'vertical', fontSize: 12, fontFamily: 'inherit' }} />
              </div>
            )}
          </div>
        )}

        {/* The composer: what the conversation is about, the message, and the tools. */}
        <form onSubmit={e => { e.preventDefault(); send() }}
          style={{ marginTop: 10, border: '1px solid var(--border-strong)', borderRadius: 14, background: 'var(--surface2)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(hasResume || hasJob) && (
            <div aria-label="Attached documents" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {hasResume && (
                <div style={chip}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Résumé: <strong>{docs.resumeName || 'Pasted résumé'}</strong> <span style={{ color: 'var(--text-muted)' }}>· {wordCount(docs.resumeText)} words</span>
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!atsCheck} aria-expanded={atsOpen} onClick={() => setAtsOpen(o => !o)}
                    title={atsCheck ? 'See whether an applicant tracking system can read this file' : 'Attach the PDF or Word file to check how a parser reads it'}>ATS check</button>
                  {resumeSource?.kind === 'upload' && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={saveAttachedResume} title="Add it to Settings → Resumes so scans can use it">Save</button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" style={{ border: 'none', background: 'transparent' }} aria-label="Remove résumé" title="Remove résumé" onClick={removeResume}>×</button>
                </div>
              )}
              {hasJob && (
                <div style={chip}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Job ad <span style={{ color: 'var(--text-muted)' }}>· {wordCount(docs.jobText)} words</span>
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJobOpen(o => !o)}>{jobOpen ? 'Close' : 'Edit'}</button>
                  <button type="button" className="btn btn-ghost btn-sm" style={{ border: 'none', background: 'transparent' }} aria-label="Remove job ad" title="Remove job ad"
                    onClick={() => { setDocs(d => ({ ...d, jobText: '' })); setJobOpen(false) }}>×</button>
                </div>
              )}
            </div>
          )}
          <textarea aria-label="Ask Hiro a question" value={input} rows={Math.min(8, Math.max(1, input.split('\n').length))}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              // Enter sends, Shift+Enter is a new line — and never mid-composition (IME).
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); send() }
            }}
            placeholder={hasResume ? 'Ask about your résumé, e.g. "Tailor it to the job ad"' : 'Ask anything, or paste your résumé…'}
            style={{ width: '100%', resize: 'none', fontFamily: 'inherit', lineHeight: 1.45, border: 'none', background: 'transparent', boxShadow: 'none', outline: 'none', padding: '4px 6px', fontSize: 13.5, minHeight: 40 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={reading} onClick={() => fileRef.current?.click()}
              title="Attach a résumé (PDF, Word or text)" aria-label="Attach résumé">{reading ? 'Reading…' : hasResume ? 'Replace résumé' : 'Attach résumé'}</button>
            {savedResumes.length > 0 && (
              <select aria-label="Use a saved résumé" value={resumeSource?.kind === 'saved' ? resumeSource.id : ''}
                onChange={e => pickSavedResume(e.target.value)} style={{ maxWidth: 190, fontSize: 12, padding: '4px 8px', height: 30 }}>
                <option value="">Use a saved résumé…</option>
                {savedResumes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
            {!hasJob && !jobOpen && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJobOpen(true)} title="Add the job ad you are applying to">+ Job ad</button>
            )}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Enter to send · Shift+Enter for a new line</span>
            {busy
              ? <button className="btn btn-ghost btn-sm" type="button" onClick={stop}>Stop</button>
              : <button className="btn btn-primary btn-sm" type="submit" disabled={!input.trim()}>Send</button>}
          </div>
          <input ref={fileRef} type="file" accept={ACCEPT} hidden data-testid="resume-file"
            onChange={e => { attachFile(e.target.files?.[0], 'resume'); e.target.value = '' }} />
          <input ref={jobFileRef} type="file" accept={ACCEPT} hidden data-testid="job-file"
            onChange={e => { attachFile(e.target.files?.[0], 'job'); e.target.value = '' }} />
        </form>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 5, textAlign: 'center' }}>
          Your résumé is sent only to the AI provider you chose in Settings. Check anything Hiro writes before you send it to an employer.
        </div>
      </div>
    </div>
  )
}
