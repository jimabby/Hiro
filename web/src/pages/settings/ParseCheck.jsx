// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// Whether a resume file was read the way its author would recognise.

import { useState } from 'react'

export function ParseCheck({ resume }) {
  const [result, setResult] = useState(null)
  const [checking, setChecking] = useState(false)
  const [showExtract, setShowExtract] = useState(false)

  async function run() {
    setChecking(true)
    try {
      const res = await window.api.checkResumeParseable?.(resume.originalPath || null, resume.originalExt || null)
      setResult(res || null)
    } finally {
      setChecking(false)
    }
  }

  const tone = (severity) => (severity === 'error' ? 'var(--red)' : 'var(--yellow)')

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={checking} onClick={run}>
        {checking ? 'Checking…' : result ? 'Check again' : 'Check ATS readability'}
      </button>

      {result && !result.ok && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.55 }}>
          {result.reason}
        </div>
      )}

      {result?.ok && (
        <div style={{ marginTop: 8 }}>
          {result.findings.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--green)' }}>
              ✓ Parses cleanly — {result.extractedChars.toLocaleString()} characters extracted, contact
              details found.
            </div>
          ) : (
            result.findings.map(f => (
              <div key={f.id} style={{
                padding: '9px 12px', borderRadius: 6, marginBottom: 6,
                background: 'var(--surface2)', borderLeft: `3px solid ${tone(f.severity)}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  <span style={{ color: tone(f.severity) }}>
                    {f.severity === 'error' ? 'Problem' : 'Worth checking'}
                  </span>{' — '}{f.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.55 }}>
                  {f.detail}
                </div>
                <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.55 }}>{f.fix}</div>
              </div>
            ))
          )}

          {/* The advisory findings are judgements; this is the evidence. If the
              extracted text reads out of order here, an ATS sees the same thing. */}
          <button
            className="btn btn-ghost" style={{ fontSize: 11 }}
            aria-expanded={showExtract}
            onClick={() => setShowExtract(v => !v)}
          >
            {showExtract ? 'Hide what a parser sees' : 'Show what a parser sees'}
          </button>
          {showExtract && (
            <pre style={{
              fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--surface2)',
              padding: '10px 12px', borderRadius: 6, marginTop: 6, maxHeight: 260, overflow: 'auto',
            }}>{result.extract || '(nothing)'}</pre>
          )}
        </div>
      )}
    </div>
  )
}

// The handful of facts every application form asks for.
//
// These used to go through the full screening-answer path — a model call, a
// fabrication check against the resume, and a fallback to interrupting the user
// — which is the wrong machinery three times over. "Do you have the right to
// work in Australia?" is not inferable from a resume: the model either guessed
// or said it was unsure, and the user was interrupted for a fact that never
// changes, on every application, forever.
//
// Filled in here, these bypass the model entirely and are treated exactly as a
// user-typed answer is treated everywhere else — never second-guessed, never
// fabrication-checked — because that is what they are. See
// services/applicationProfile.js.
