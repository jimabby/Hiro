// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// Cached screening answers: what has been submitted on the user's behalf, and
// which of it has aged past the point of being worth reusing unreviewed.

import { useCallback, useEffect, useState } from 'react'

export function AnswerBank({ showToast }) {
  const [answers, setAnswers] = useState([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    window.api.listInterviewAnswers?.(search).then(rows => setAnswers(rows || [])).catch(() => {})
  }, [search])

  useEffect(() => { load() }, [load])

  async function polish(entry) {
    setBusy(true)
    try {
      const res = await window.api.draftInterviewAnswer?.({
        question: entry.question,
        existingAnswer: draft,
      })
      if (res?.success) setDraft(res.draft)
      else showToast?.(res?.error || 'Could not draft an answer', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function save(entry) {
    // Saved as the user's own, whatever produced the text: they read it and
    // pressed save, which is the whole difference between a draft and an answer.
    await window.api.saveInterviewAnswer?.({ question: entry.question, answer: draft, source: 'user' })
    setEditing(null)
    setDraft('')
    load()
    showToast?.('Answer saved', 'success')
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Interview Answer Bank</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.55 }}>
        Answers you have worked out once, kept for the next time the question comes up. Saved from the
        Interview Questions panel on any application; the same question asked with different wording
        finds the same entry.
      </p>

      <div className="form-group" style={{ maxWidth: 320 }}>
        <label htmlFor="answer-search">Search</label>
        <input
          id="answer-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Question or answer text"
        />
      </div>

      {answers.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {search ? 'Nothing matches that.' : 'No answers saved yet.'}
        </div>
      )}

      {answers.map(entry => (
        <div key={entry.id} style={{
          padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{entry.question}</div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                className="btn btn-ghost" style={{ fontSize: 12 }}
                onClick={() => { setEditing(entry.id); setDraft(entry.answer || '') }}
              >Edit</button>
              <button
                className="btn btn-ghost" style={{ fontSize: 12 }}
                onClick={async () => {
                  await window.api.deleteInterviewAnswer?.(entry.question)
                  load()
                }}
              >Delete</button>
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {/* An unedited AI draft is not yet the user's answer, and saying so
                is the difference between a bank and a pile of generated text. */}
            {entry.source === 'ai' ? 'AI draft — not yet reviewed' : 'Your answer'}
            {entry.times_used > 0 && ` · used ${entry.times_used} time${entry.times_used === 1 ? '' : 's'}`}
          </div>

          {editing === entry.id ? (
            <div style={{ marginTop: 8 }}>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={5}
                style={{ width: '100%', fontSize: 13 }}
                aria-label={`Answer to: ${entry.question}`}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => save(entry)}>Save</button>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={() => polish(entry)}>
                  {busy ? 'Working…' : 'Tighten with AI'}
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setEditing(null); setDraft('') }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
              {entry.answer || <span style={{ color: 'var(--text-muted)' }}>No answer yet.</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// Company career boards. These serve structured JSON with no login and no bot
// defenses, which makes them far steadier than scraping the aggregators — but
// their application forms are custom per company, so matches are routed to
// Needs Attention with the documents already drafted rather than submitted.
