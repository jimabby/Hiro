import { useState } from 'react'

// A model-name box with a menu, and a button that fills the menu from the
// provider itself — the models this key can actually use. Free text still
// works: a model newer than the list should not have to wait for a release.
//
// `apiKey` may be the saved-key placeholder; the main process resolves it.
export default function ModelPicker({
  id, label, value, onChange, provider, apiKey, overrides, placeholder, choices = [], help,
}) {
  const [loaded, setLoaded] = useState(null) // { provider, models }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const listId = `${id}-options`
  // A list loaded for another provider is not offered for this one.
  const models = loaded?.provider === provider ? loaded.models : null
  const options = models || choices

  const load = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await window.api.listAiModels(provider, apiKey, overrides)
      if (res?.success) setLoaded({ provider, models: res.models || [] })
      else setError(res?.error || 'Could not load the model list.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input id={id} list={listId} style={{ flex: 1 }}
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button type="button" className="btn btn-ghost" onClick={load} disabled={busy}>
          {busy ? 'Loading…' : 'Load models'}
        </button>
      </div>
      <datalist id={listId}>
        {options.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </datalist>
      {models && !error && (
        <span role="status" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          {models.length} models available to this key. Click the box to pick one.
        </span>
      )}
      {error && <span role="alert" style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{error}</span>}
      {help && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{help}</span>}
    </div>
  )
}
