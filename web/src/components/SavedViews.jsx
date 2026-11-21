import { useEffect, useState } from 'react'

export default function SavedViews({ filter, sort, onApply }) {
  const [views, setViews] = useState([]), [name, setName] = useState(''), [selected, setSelected] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { window.api.getSavedViews().then(setViews).catch(e => setError(e.message)) }, [])
  async function save() {
    setBusy(true); setError('')
    try {
      const view = await window.api.saveView({ name, filter, sort })
      setViews(await window.api.getSavedViews()); setSelected(view.id); setName('')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    try { await window.api.deleteView(selected); setViews(await window.api.getSavedViews()); setSelected('') }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  // One compact toolbar. Each control used to take the full width of the card
  // (the global input rule), stacking four rows of chrome above the table.
  const compact = { width: 'auto', padding: '5px 10px', fontSize: 12 }
  return <div style={{ marginBottom: 10 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <select aria-label="Saved application view" value={selected} style={{ ...compact, minWidth: 170, maxWidth: 240 }} onChange={e => {
        const id = e.target.value; setSelected(id)
        const view = views.find(v => v.id === id); if (view) onApply(view)
      }}><option value="">{views.length ? 'Saved views…' : 'No saved views yet'}</option>{views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
      {selected && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={remove}>Delete view</button>}
      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} aria-hidden="true" />
      <input aria-label="New view name" placeholder="Name these filters…" value={name} onChange={e => setName(e.target.value)} maxLength={60}
        onKeyDown={e => { if (e.key === 'Enter' && name.trim() && !busy) save() }}
        style={{ ...compact, width: 190 }} />
      <button className="btn btn-ghost btn-sm" disabled={busy || !name.trim()} onClick={save}>Save view</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>
}
