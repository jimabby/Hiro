import { useCallback, useEffect, useState } from 'react'
import { useTasksChanged } from '../taskEvents'

// This week's targets and how far along each is (services/weeklyGoals.js).
// With no goal set, the card is a one-line invitation to set some rather than
// three empty bars.

const STATE_COLOR = { done: 'var(--green)', 'on-track': 'var(--accent)', behind: 'var(--amber, var(--yellow))' }
const STATE_LABEL = { done: 'Done', 'on-track': 'On pace', behind: 'Behind pace' }
const FIELDS = [
  { key: 'applications', label: 'Applications sent' },
  { key: 'followUps', label: 'Follow-ups done' },
  { key: 'contacts', label: 'People contacted' },
]

export default function WeeklyGoals({ active, showToast }) {
  const [data, setData] = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    // Absent from an older preload, and from page tests that mock only what they use.
    if (typeof window.api?.getWeeklyGoals !== 'function') return
    try { setData(await window.api.getWeeklyGoals()); setError(null) } catch (err) { setError(err.message) }
  }, [])
  useEffect(() => { if (active !== false) load() }, [active, load])
  // Completing a follow-up elsewhere moves the count.
  useTasksChanged(load, 'weekly-goals')

  if (!data && !error) return null

  async function save() {
    try {
      const res = await window.api.saveWeeklyGoals(draft)
      if (res?.success === false) throw new Error(res.error || 'Could not save goals')
      setEditing(false)
      await load()
      showToast?.('Weekly goals saved', 'success')
    } catch (err) { showToast?.(err.message, 'error') }
  }

  const startEdit = () => { setDraft({ ...(data?.targets || {}) }); setEditing(true) }
  const goals = data?.goals || []

  return (
    <section className="card" aria-label="Weekly goals" style={{ marginBottom: 16, padding: '12px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>This week{data ? <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}> · {data.weekStart} to {data.weekEnd}</span> : null}</div>
        {!editing && <button className="btn btn-ghost btn-sm" onClick={startEdit}>{goals.length ? 'Edit goals' : 'Set weekly goals'}</button>}
      </div>
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</p>}

      {editing && (
        <div style={{ marginTop: 10 }}>
          <div className="form-row">
            {FIELDS.map(f => (
              <div className="form-group" key={f.key}>
                <label htmlFor={`goal-${f.key}`}>{f.label}</label>
                <input id={`goal-${f.key}`} type="number" min={0} max={200} value={draft[f.key] ?? 0}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>0 means no goal. Weeks start on Monday.</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={save}>Save goals</button>
          </div>
        </div>
      )}

      {!editing && !goals.length && data && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
          Set a target for applications, follow-ups and people contacted, and Hiro tracks the week against it.
        </p>
      )}

      {!editing && goals.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {goals.map(g => {
            const pct = Math.min(100, Math.round((g.done / g.target) * 100))
            return (
              <div key={g.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>{g.label}</span>
                  <span><strong>{g.done}</strong> / {g.target} · <span style={{ color: STATE_COLOR[g.state] }}>{STATE_LABEL[g.state]}</span></span>
                </div>
                <div role="progressbar" aria-label={g.label} aria-valuenow={g.done} aria-valuemin={0} aria-valuemax={g.target}
                  style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: STATE_COLOR[g.state] }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
