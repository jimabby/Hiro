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
  return <div style={{ marginBottom: 12 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <select aria-label="Saved application view" value={selected} onChange={e => {
        const id = e.target.value; setSelected(id)
        const view = views.find(v => v.id === id); if (view) onApply(view)
      }}><option value="">Saved views</option>{views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
      <input aria-label="New view name" placeholder="Name current view" value={name} onChange={e => setName(e.target.value)} maxLength={60} />
      <button className="btn btn-ghost" disabled={busy || !name.trim()} onClick={save}>Save current view</button>
      <button className="btn btn-ghost" disabled={busy || !selected} onClick={remove}>Delete saved view</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>
}
