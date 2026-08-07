import { useState, useEffect, useCallback, useMemo } from 'react'

// The follow-up pipeline.
//
// Everything else in Hiro answers "what happened": a list sorted by date, rates,
// a timeline. None of it answers the question that actually loses people offers —
// "what do I owe, and when?" An application that needed a nudge on Thursday looked
// identical to one that was rightly ignored, so applications died of neglect while
// the dashboard reported a healthy response rate.
//
// So this board is organised around the next action, not around history:
//   • Overdue and due-today are hoisted out of the columns entirely, because a
//     board where the urgent thing is buried in column three is a board nobody
//     acts on.
//   • Columns come from status, derived rather than stored, so this view can never
//     disagree with the status shown everywhere else.
//   • Rows with nothing booked and no recent movement are flagged, since silence
//     is exactly what this is meant to catch.

const STAGE_COLORS = {
  applied: 'var(--accent)',
  waiting: 'var(--text-muted)',
  interview: 'var(--green)',
  offer: 'var(--green)',
  closed: 'var(--red)',
}

// "in 3 days" is easier to act on than "2026-08-09"; the exact date is kept in
// the title attribute for when it matters.
function relativeDay(date, today) {
  if (!date) return ''
  const days = Math.round((new Date(`${date}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days < 0) return `${-days} days ago`
  return `in ${days} days`
}

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDaysISO(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Setting a date should take one click for the common cases. Typing a date into a
// picker for "chase them next week" is the kind of friction that stops a feature
// like this from being used at all.
const QUICK_DATES = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
  { label: 'In 2 weeks', days: 14 },
]

function NextActionEditor({ item, onSave, onCancel }) {
  const [date, setDate] = useState(item.next_action_at || addDaysISO(3))
  const [note, setNote] = useState(item.next_action_note || '')

  return (
    <div style={{
      background: 'var(--surface2)', borderRadius: 8, padding: 10, marginTop: 8,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {QUICK_DATES.map(q => (
          <button key={q.days} className="btn btn-ghost btn-sm"
            aria-pressed={date === addDaysISO(q.days)}
            style={date === addDaysISO(q.days)
              ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
              : undefined}
            onClick={() => setDate(addDaysISO(q.days))}>{q.label}</button>
        ))}
      </div>
      <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ fontSize: 12 }} />
      <input value={note} onChange={e => setNote(e.target.value)} style={{ fontSize: 12 }}
        placeholder="What needs doing? e.g. chase the recruiter" />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-primary btn-sm"
          onClick={() => onSave({ date, note })}>Save</button>
        <button className="btn btn-ghost btn-sm"
          onClick={onCancel}>Cancel</button>
        {item.next_action_at && (
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-muted)' }}
            onClick={() => onSave({ date: null, note: '' })}>Clear</button>
        )}
      </div>
    </div>
  )
}

function Card({ item, today, editing, onEdit, onSave, onCancel, onDone, onOpen }) {
  const due = item.next_action_at
  const border = item.overdue ? 'var(--red)' : item.dueToday ? 'var(--accent)' : 'transparent'

  const open = editing ? undefined : () => onOpen(item)

  return (
    <div
      className={`card${editing ? '' : ' card-interactive'}`}
      style={{ padding: 12, marginBottom: 8, borderLeft: `3px solid ${border}` }}
      onClick={open}
      // Keyboard users could reach the buttons inside a card but never the card
      // itself, so opening an application was mouse-only.
      role={editing ? undefined : 'button'}
      tabIndex={editing ? undefined : 0}
      aria-label={editing ? undefined : `Open ${item.job_title} at ${item.company}`}
      onKeyDown={editing ? undefined : (e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item) }
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.job_title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {item.company} · {item.platform}
            {item.match_score != null && ` · ${item.match_score}%`}
          </div>
        </div>
        {item.nextInterview && (
          <span title={`Interview ${item.nextInterview.scheduled_at}`} style={{
            fontSize: 10, background: 'var(--green)', color: '#fff',
            borderRadius: 10, padding: '1px 6px', height: 16, flexShrink: 0,
          }}>interview</span>
        )}
      </div>

      {due && (
        <div style={{ marginTop: 8, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span title={due} style={{
            color: item.overdue ? 'var(--red)' : item.dueToday ? 'var(--accent)' : 'var(--text-muted)',
            fontWeight: item.overdue || item.dueToday ? 600 : 400,
          }}>
            {item.overdue ? '⚑ ' : ''}{item.next_action_note || 'Follow up'} · {relativeDay(due, today)}
          </span>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
            onClick={(e) => { e.stopPropagation(); onDone(item) }}
            title="Mark this action done and clear the reminder">Done</button>
        </div>
      )}

      {/* A row with nothing booked and no recent movement is the one that goes
          missing. Say so rather than leaving it looking the same as the rest. */}
      {!due && item.needsAction && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--amber, var(--text-muted))' }}>
          Nothing planned, and nothing has happened here in a while.
        </div>
      )}

      {editing
        ? <NextActionEditor item={item} onSave={onSave} onCancel={onCancel} />
        : (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
            onClick={(e) => { e.stopPropagation(); onEdit(item) }}>
            {due ? 'Reschedule' : 'Set next action'}
          </button>
        )}
    </div>
  )
}

export default function Pipeline({ active, onOpenApplication }) {
  const [data, setData] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await window.api.getPipeline())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // Statuses change on the Dashboard and from inbox checks, so a board that
  // loaded once would go stale in the background. Reload whenever it is shown.
  useEffect(() => { if (active !== false) load() }, [active, load])

  const today = data?.today || todayISO()

  const { overdue, dueToday, byStage } = useMemo(() => {
    const items = data?.items || []
    const stages = {}
    for (const stage of data?.stages || []) stages[stage.id] = []
    for (const item of items) (stages[item.stage] ||= []).push(item)
    return {
      overdue: items.filter(i => i.overdue),
      dueToday: items.filter(i => i.dueToday),
      byStage: stages,
    }
  }, [data])

  const saveAction = async (item, { date, note }) => {
    const res = await window.api.setNextAction(item.id, { date, note })
    if (res?.success === false) { setError(res.reason); return }
    setEditingId(null)
    load()
  }

  const completeAction = async (item) => {
    await window.api.completeNextAction(item.id)
    load()
  }

  const openApplication = (item) => onOpenApplication?.(item.id)

  const cardProps = (item) => ({
    item,
    today,
    editing: editingId === item.id,
    onEdit: (i) => setEditingId(i.id),
    onSave: (payload) => saveAction(item, payload),
    onCancel: () => setEditingId(null),
    onDone: completeAction,
    onOpen: openApplication,
  })

  if (!data) {
    return (
      <div data-testid="pipeline">
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Pipeline</h1>
        {/* Shaped placeholders rather than the word "Loading" — the board's
            layout appears immediately, so the page doesn't jump when it lands. */}
        <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))', gap: 14, marginTop: 20 }}>
          {[0, 1, 2, 3].map(col => (
            <div key={col}>
              <div className="skeleton" style={{ height: 14, width: '55%', marginBottom: 14 }} />
              {[0, 1].map(row => (
                <div key={row} className="skeleton" style={{ height: 78, marginBottom: 8, borderRadius: 'var(--radius-lg)' }} />
              ))}
            </div>
          ))}
        </div>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          Loading pipeline…
        </span>
      </div>
    )
  }

  const empty = data.items.length === 0

  return (
    <div data-testid="pipeline">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Pipeline</h1>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={load}>Refresh</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
        What each application is waiting on, and what you owe it. Held and skipped drafts are not
        here — nothing was ever sent, so there is nothing to chase.
      </p>

      {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {empty && (
        <div className="card empty-state">
          <div className="empty-icon" aria-hidden="true">≡</div>
          <div className="empty-title">Nothing to chase yet</div>
          <div className="empty-hint">
            No submitted applications yet. Once a scan sends one, it appears here and you can book
            the follow-up.
          </div>
        </div>
      )}

      {/* Hoisted out of the columns on purpose: the whole failure this page exists
          to fix is an urgent follow-up sitting unnoticed inside a long list. */}
      {(overdue.length > 0 || dueToday.length > 0) && (
        <div className="card" style={{
          marginBottom: 24,
          borderLeft: `3px solid ${overdue.length ? 'var(--red)' : 'var(--accent)'}`,
        }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            {overdue.length > 0 && `${overdue.length} overdue`}
            {overdue.length > 0 && dueToday.length > 0 && ' · '}
            {dueToday.length > 0 && `${dueToday.length} due today`}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
            Deal with these first. Everything below is organised by where the application got to.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {[...overdue, ...dueToday].map(item => (
              <Card key={`urgent-${item.id}`} {...cardProps(item)} />
            ))}
          </div>
        </div>
      )}

      {!empty && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.stages.length}, minmax(220px, 1fr))`, gap: 14, overflowX: 'auto' }}>
          {data.stages.map(stage => {
            const items = byStage[stage.id] || []
            const needing = items.filter(i => !i.next_action_at && i.needsAction).length
            return (
              <div key={stage.id} data-testid={`pipeline-stage-${stage.id}`}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10,
                  paddingBottom: 6, borderBottom: `2px solid ${STAGE_COLORS[stage.id] || 'var(--border)'}`,
                }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{stage.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{items.length}</span>
                  {needing > 0 && (
                    <span title={`${needing} with no next action booked`} style={{
                      marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)',
                    }}>{needing} unplanned</span>
                  )}
                </div>
                {items.length === 0 && (
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>Nothing here.</p>
                )}
                {items.map(item => <Card key={item.id} {...cardProps(item)} />)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
