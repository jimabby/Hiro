import { useEffect, useState } from 'react'

export default function ApplicationChecklist({ applicationId }) {
  const [items, setItems] = useState([]), [title, setTitle] = useState(''), [due, setDue] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [editing, setEditing] = useState(null)
  useEffect(() => {
    let live = true
    window.api.getChecklist(applicationId).then(rows => { if (live) setItems(rows) }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [applicationId])
  async function change(input, reset = false) {
    setBusy(true); setError('')
    try { setItems(await window.api.updateChecklist(applicationId, input)); if (reset) { setTitle(''); setDue(''); setEditing(null) } }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return <section aria-label="Application checklist" style={{ marginBottom: 20 }}>
    <h3>Application checklist · {items.filter(t => t.done).length}/{items.length} complete</h3>
    {error && <p role="alert">{error}</p>}
    {items.map(item => <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
      <label style={{ flex: 1 }}><input type="checkbox" checked={!!item.done} disabled={busy} onChange={e => change({ id: item.id, done: e.target.checked })} /> {item.title}</label>
      {item.due && <span style={{ color: !item.done && item.due < today ? 'var(--red)' : 'var(--text-muted)' }}>{!item.done && item.due < today ? 'Overdue · ' : ''}{item.due}</span>}
      <button className="btn btn-ghost" disabled={busy} onClick={() => { setEditing(item.id); setTitle(item.title); setDue(item.due || '') }}>Edit</button>
      <button className="btn btn-ghost" disabled={busy} aria-label={`Delete ${item.title}`} onClick={() => change({ id: item.id, remove: true })}>Delete</button>
    </div>)}
    <form onSubmit={e => { e.preventDefault(); change({ id: editing, title, due }, true) }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      <input aria-label="Checklist task" placeholder="Assessment, references, portfolio…" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} />
      <input aria-label="Task due date" type="date" value={due} onChange={e => setDue(e.target.value)} />
      <button className="btn btn-primary" disabled={busy || !title.trim()}>{editing ? 'Save task' : 'Add task'}</button>
      {editing && <button className="btn btn-ghost" type="button" onClick={() => { setEditing(null); setTitle(''); setDue('') }}>Cancel edit</button>}
    </form>
  </section>
}
