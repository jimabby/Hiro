import { useCallback, useEffect, useState } from 'react'

export default function TaskInbox({ active, onOpenApplication, onNavigate, showToast }) {
  const [tasks, setTasks] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { setTasks(await window.api.getTaskInbox()); setError('') } catch (err) { setError(err.message) }
  }, [])
  useEffect(() => { if (active) load() }, [active, load])
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return <section className="card" aria-label="Task inbox" style={{ marginBottom: 20 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}><h2>Task inbox</h2><button className="btn btn-ghost" onClick={load}>Refresh tasks</button></div>
    <p>Checklist tasks, follow-ups, application deadlines and offer decisions.</p>
    {error && <p role="alert">{error}</p>}
    {!error && tasks.length === 0 && <p>No outstanding tasks.</p>}
    {tasks.map(task => <div key={task.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1 }}><strong>{task.title}</strong><div>{task.company} · {task.jobTitle}</div>
        <small style={{ color: task.due && task.due < today ? 'var(--red)' : 'var(--text-muted)' }}>{task.kind} · {task.due ? `${task.due < today ? 'Overdue · ' : ''}${task.due}` : 'No due date'}</small></div>
      {task.applicationId && <button className="btn btn-ghost" onClick={() => onOpenApplication(task.applicationId)}>Open application</button>}
      {task.kind === 'attention' && <button className="btn btn-ghost" onClick={() => onNavigate?.('attention')}>Open Needs Attention</button>}
      {task.kind === 'offer' && <button className="btn btn-ghost" onClick={() => onNavigate?.('offers')}>Review offer</button>}
      {['checklist', 'follow-up'].includes(task.kind) && <button className="btn btn-primary" disabled={busy} onClick={async () => {
        setBusy(true)
        try { const result = await window.api.completeInboxTask(task); if (result?.success === false) throw new Error(result.reason); await load() }
        catch (err) { showToast?.(err.message, 'error'); setError(err.message) } finally { setBusy(false) }
      }}>Mark done</button>}
    </div>)}
  </section>
}
