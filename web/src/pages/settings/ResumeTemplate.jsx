// Which layout generated résumé PDFs use: downloads, previews, and the file
// attached when Hiro submits. A résumé imported as Word keeps its own layout
// wherever Hiro can fill the original; this applies wherever a PDF is built.

import { useEffect, useState } from 'react'

export function ResumeTemplate({ form, set, onPreview, showToast }) {
  const [templates, setTemplates] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.getResumeTemplates?.().then(t => setTemplates(t || [])).catch(() => {})
  }, [])

  async function preview() {
    setBusy(true)
    try {
      const res = await window.api.previewResumeTemplate(form.resumeTemplate || 'classic')
      if (res?.success) onPreview?.({ url: res.url, title: 'Résumé template preview' })
      else showToast?.(res?.error || 'Could not build the preview', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Résumé Layout</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.55 }}>
        The look of every résumé PDF Hiro produces. All layouts use standard fonts that applicant
        tracking systems read reliably; a Word résumé you imported keeps its own layout where Hiro can fill it in.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ marginBottom: 0, flex: '1 1 260px' }}>
          <label htmlFor="resume-template">Layout</label>
          <select id="resume-template" value={form.resumeTemplate || 'classic'} onChange={e => set('resumeTemplate', e.target.value)}>
            {(templates.length ? templates : [{ id: 'classic', label: 'Classic' }]).map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-ghost" disabled={busy} onClick={preview}>{busy ? 'Building…' : 'Preview with my résumé'}</button>
      </div>
    </div>
  )
}
