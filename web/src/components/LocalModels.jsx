import { useCallback, useEffect, useState } from 'react'

// The local models Hiro recommends: a download button for each one the local
// server does not have yet, and a "Use" button for each it has. Models are not
// bundled with Hiro (see electron/services/ai/localModels.js); Ollama fetches
// them on request. LM Studio and llama.cpp cannot be asked to download, so with
// them this says so and the model is still picked by name above.

const GB = (bytes) => (bytes / 1e9).toFixed(1)
const ROW = { border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, display: 'flex', gap: 10, alignItems: 'center' }

export default function LocalModels({ baseUrl, value, onUse }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState({}) // model id → { total, completed, status }
  const [downloading, setDownloading] = useState({}) // model id → true

  const available = typeof window.api?.localAiStatus === 'function'

  const refresh = useCallback(async () => {
    if (!available) return
    setError('')
    const res = await window.api.localAiStatus({ localAiBaseUrl: baseUrl })
    if (res?.success) setState(res)
    else setError(res?.error || 'Could not reach the local server.')
  }, [available, baseUrl])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (typeof window.api?.onLocalModelPullProgress !== 'function') return undefined
    return window.api.onLocalModelPullProgress(p => setProgress(prev => ({ ...prev, [p.model]: p })))
  }, [])

  if (!available) return null

  const download = async (id) => {
    setDownloading(d => ({ ...d, [id]: true }))
    setError('')
    try {
      const res = await window.api.pullLocalModel(id, { localAiBaseUrl: baseUrl })
      if (res?.success) {
        await refresh()
        onUse(id) // downloaded to be used; saving Settings makes it stick
      } else if (!res?.cancelled) {
        setError(res?.error || 'The download failed.')
      }
    } finally {
      setDownloading(d => ({ ...d, [id]: false }))
      setProgress(({ [id]: _done, ...rest }) => rest)
    }
  }

  return (
    <div className="form-group">
      <span style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Recommended models</span>
      {state && !state.running && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>
          Ollama isn&apos;t answering at <code>{state.root}</code>.{' '}
          <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Install Ollama</a> (free) and start it,
          then{' '}
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={refresh}>check again</button>.
          {' '}LM Studio works too, but can&apos;t download models for you.
        </p>
      )}
      {(state?.recommended || []).map(m => {
        const p = progress[m.id]
        const pct = p?.total ? Math.min(100, Math.floor((p.completed / p.total) * 100)) : null
        const busy = !!downloading[m.id]
        const inUse = value === m.id
        return (
          <div key={m.id} style={ROW}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {m.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {m.size}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.note} {m.needs}</div>
              {busy && (
                <>
                  <div role="progressbar" aria-label={`Downloading ${m.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}
                    style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', marginTop: 6 }}>
                    <div style={{ width: `${pct ?? 0}%`, height: '100%', background: 'var(--accent)' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {pct === null ? 'Starting…' : `${pct}% · ${GB(p.completed)} of ${GB(p.total)} GB`}
                  </div>
                </>
              )}
            </div>
            {m.installed && (
              <button type="button" className="btn btn-ghost" disabled={inUse} onClick={() => onUse(m.id)}>
                {inUse ? 'In use' : 'Use'}
              </button>
            )}
            {!m.installed && busy && (
              <button type="button" className="btn btn-ghost" onClick={() => window.api.cancelLocalModelPull(m.id)}>Cancel</button>
            )}
            {!m.installed && !busy && (
              <button type="button" className="btn btn-primary" disabled={!state.running} onClick={() => download(m.id)}>
                Download
              </button>
            )}
          </div>
        )
      })}
      {error && <span role="alert" style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{error}</span>}
    </div>
  )
}
