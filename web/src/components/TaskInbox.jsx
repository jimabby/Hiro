import { useCallback, useEffect, useState } from 'react'
import { notifyTasksChanged, useTasksChanged } from '../taskEvents'
import ProposeTimes from './ProposeTimes'
import ThankYouNote from './ThankYouNote'

const BTN = { fontSize: 12, padding: '5px 11px' }

export default function TaskInbox({ active, onOpenApplication, onNavigate, showToast }) {
  const [tasks, setTasks] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { setTasks(await window.api.getTaskInbox()); setError('') } catch (err) { setError(err.message) }
  }, [])
  const [proposeFor, setProposeFor] = useState(null)
  const [thankFor, setThankFor] = useState(null)
  useEffect(() => { if (active) load() }, [active, load])
  // The board below changes the same rows (completing a follow-up, moving a
  // card to Rejected). See taskEvents.js.
  useTasksChanged(load, 'task-inbox')
  const complete = async (task) => {
    setBusy(true)
    try { const result = await window.api.completeInboxTask(task); if (result?.success === false) throw new Error(result.reason); await load(); notifyTasksChanged('task-inbox') }
    catch (err) { showToast?.(err.message, 'error'); setError(err.message) } finally { setBusy(false) }
  }
  const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  // Sized like every other card on the page. The bare <h2> and <p> here
  // inherited the browser defaults — a 21px card title over full-size body text,
  // louder than the page title above it.
  return <section className="card" aria-label="Task inbox" style={{ marginBottom: 20 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 15, marginBottom: 4 }}>Task inbox</h2>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Checklist tasks, follow-ups, thank-you notes, application deadlines and offer decisions.</p>
      </div>
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '5px 10px', flexShrink: 0 }} onClick={load}>Refresh tasks</button>
    </div>
    {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{error}</p>}
    {!error && tasks.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>No outstanding tasks.</p>}
    {tasks.length > 0 && <div style={{ marginTop: 8 }}>
    {tasks.map(task => <div key={task.id} className="list-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{task.title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 1 }}>{[task.company, task.jobTitle].filter(Boolean).join(' · ')}</div>
        <small style={{ display: 'block', fontSize: 11.5, marginTop: 2, color: task.due && task.due < today ? 'var(--red)' : 'var(--text-faint)' }}>{task.kind} · {task.due ? `${task.due < today ? 'Overdue · ' : ''}${task.due}` : 'No due date'}</small></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
      {task.applicationId && <button className="btn btn-ghost btn-sm" style={BTN} onClick={() => onOpenApplication(task.applicationId)}>Open application</button>}
      {task.kind === 'attention' && <button className="btn btn-ghost btn-sm" style={BTN} onClick={() => onNavigate?.('attention')}>Open Needs Attention</button>}
      {task.kind === 'offer' && <button className="btn btn-ghost btn-sm" style={BTN} onClick={() => onNavigate?.('offers')}>Review offer</button>}
      {task.kind === 'propose-times' && <button className="btn btn-ghost btn-sm" style={BTN} onClick={() => setProposeFor(task.applicationId)}>Review drafted times</button>}
      {task.kind === 'thank-you' && <button className="btn btn-ghost btn-sm" style={BTN} onClick={() => setThankFor(task)}>Draft note</button>}
      {['checklist', 'follow-up', 'propose-times', 'thank-you'].includes(task.kind) && <button className="btn btn-primary btn-sm" style={BTN} disabled={busy} onClick={() => complete(task)}>
        {task.kind === 'propose-times' ? 'Dismiss' : task.kind === 'thank-you' ? 'Mark sent' : 'Mark done'}</button>}
      </div>
    </div>)}
    </div>}
    {proposeFor && <ProposeTimes applicationId={proposeFor} onClose={() => { setProposeFor(null); load() }} showToast={showToast} />}
    {thankFor && <ThankYouNote interviewId={thankFor.interviewId} showToast={showToast}
      onClose={() => setThankFor(null)}
      onDone={async () => { const task = thankFor; setThankFor(null); await complete(task) }} />}
  </section>
}
