import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SafeAnswer, { TextBlocks } from '../components/SafeAnswer'

// Practice: interview questions as flashcards, a few a day
// (services/practice.js). Cards rated Again or Hard come back sooner; Good and
// Easy push them further out (SM-2). Job decks are the questions Hiro already
// generated for real applications; generated decks come from a job ad the user
// pastes or uploads. Any card can carry a note, and can be explained by the AI.
//
// Layout rule: the card is the page. Stats sit in one line at the top, topics
// fold away behind a button, so the question, the answer and the rating
// buttons fit on screen without scrolling.

const RATINGS = [
  { key: 'again', label: 'Again', hint: 'Forgot it', className: 'btn btn-danger' },
  { key: 'hard', label: 'Hard', hint: 'Got it, with effort', className: 'btn' },
  { key: 'good', label: 'Good', hint: 'Got it', className: 'btn btn-primary' },
  { key: 'easy', label: 'Easy', hint: 'Instant', className: 'btn' },
]
const COUNTS = [5, 8, 10, 15, 20]
const REASONS = [
  { key: 'outdated', label: 'Outdated' },
  { key: 'wrong', label: 'Wrong' },
  { key: 'other', label: 'Something else' },
]
const DIFFICULTY_TONE = { easy: 'badge-green', medium: 'badge-yellow', hard: 'badge-red' }
const ACCEPT = '.pdf,.docx,.txt,.md'

export function formatInterval(days) {
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return '1y'
}

const plain = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const topicLabel = c => (c.deck === 'job' ? `Job: ${c.topic}` : c.deck === 'custom' ? `Deck: ${c.topic}` : c.topic)

function readBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(b => new Uint8Array(b))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

// Topic · category · difficulty, then state. The category is labelled so it is
// not mistaken for another topic.
function CardMeta({ card, showState = true }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="badge badge-blue" title="Topic">{topicLabel(card)}</span>
      {card.category && card.category !== card.topic && <span className="badge badge-gray" title="Category"><span style={{ opacity: 0.7 }}>Category:</span>&nbsp;{card.category}</span>}
      {card.difficulty && <span className={`badge ${DIFFICULTY_TONE[card.difficulty]}`} title="Difficulty">{card.difficulty}</span>}
      {card.versions?.map(v => <span key={v} className="badge badge-gray" title="Technology version">{v}</span>)}
      {showState && <span className="badge badge-gray">{card.state ? 'Review' : 'New'}</span>}
    </div>
  )
}

function ReportForm({ card, onDone, onCancel, showToast }) {
  const [reason, setReason] = useState('outdated')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    const res = await window.api.flagPracticeCard(card.id, reason, note)
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not report the card', 'error'); return }
    showToast?.('Reported. It is out of your practice until you restore it.', 'success')
    onDone()
  }
  return (
    <form onSubmit={submit} className="practice-panel">
      <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>What&apos;s wrong with this card?</legend>
        {REASONS.map(r => (
          <label key={r.key} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" name={`reason-${card.id}`} value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)} />
            {r.label}
          </label>
        ))}
      </fieldset>
      <textarea aria-label="Report note" placeholder="Optional: what should it say?" value={note} maxLength={500}
        onChange={e => setNote(e.target.value)} rows={2} style={{ width: '100%', marginTop: 8 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Report</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function NoteEditor({ card, onSaved, onCancel, showToast }) {
  const [text, setText] = useState(card.note || '')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  async function save(e) {
    e.preventDefault()
    setBusy(true)
    const res = await window.api.savePracticeNote(card.id, text)
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not save the note', 'error'); return }
    showToast?.(res.note ? 'Note saved' : 'Note removed', 'success')
    onSaved(res.note)
  }
  return (
    <form onSubmit={save} className="practice-panel">
      <label htmlFor={`note-${card.id}`} style={{ fontSize: 13, fontWeight: 600 }}>Your note</label>
      <textarea id={`note-${card.id}`} ref={ref} value={text} maxLength={5000} rows={4}
        placeholder="Your own words, an example from a project, a reminder of what tripped you up…"
        onChange={e => setText(e.target.value)} style={{ width: '100%', marginTop: 6 }}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save note</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{text.length}/5000</span>
      </div>
    </form>
  )
}

function SavedNote({ note, onEdit }) {
  if (!note) return null
  return (
    <div className="practice-note">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Your note</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
      </div>
      <p style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, margin: 0 }}>{note}</p>
    </div>
  )
}

// Ask the AI about a card. Opening it with nothing saved asks for the standard
// deeper explanation straight away; after that the user can ask follow-ups.
function AskPanel({ card, onClose, onChanged, showToast }) {
  const [entries, setEntries] = useState(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const started = useRef(false)

  const ask = useCallback(async (followUp = '') => {
    setBusy(true); setError('')
    const res = await window.api.explainPracticeCard(card.id, followUp)
    setBusy(false)
    if (!res?.success) { setError(res?.error || 'The AI request failed.'); return }
    setEntries(list => [...(list || []), res.entry])
    setInput('')
    onChanged?.()
  }, [card.id, onChanged])

  // Loaded once per card. `ask` changes identity whenever the parent
  // re-renders; depending on it would reload the saved list and wipe a reply
  // that had just arrived.
  const askRef = useRef(ask)
  askRef.current = ask
  useEffect(() => {
    let live = true
    Promise.resolve(window.api.getPracticeExplanations(card.id)).then(list => {
      if (!live) return
      const saved = Array.isArray(list) ? list : []
      setEntries(saved)
      if (!saved.length && !started.current) { started.current = true; askRef.current('') }
    })
    return () => { live = false }
  }, [card.id])

  async function clear() {
    await window.api.clearPracticeExplanations(card.id)
    setEntries([])
    onChanged?.()
    showToast?.('Cleared', 'success')
  }

  return (
    <div className="practice-panel" aria-label="Ask AI about this question">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>✦ Ask AI</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {entries?.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <div aria-live="polite">
        {entries?.map(e => (
          <div key={e.id} style={{ marginBottom: 12 }}>
            {e.prompt && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 4px' }}><strong>You asked:</strong> {e.prompt}</p>}
            <div className="practice-answer"><TextBlocks blocks={e.blocks} /></div>
          </div>
        ))}
        {busy && <p style={{ fontSize: 13, color: 'var(--text-muted)' }} role="status">Thinking…</p>}
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{error}</p>}
      </div>
      <form onSubmit={e => { e.preventDefault(); if (input.trim()) ask(input) }} style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input aria-label="Ask a follow-up question" value={input} maxLength={1000} onChange={e => setInput(e.target.value)}
          placeholder="Ask a follow-up, e.g. “Show me an example in C#”" style={{ flex: 1 }}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>Ask</button>
      </form>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Uses your AI provider. Answers are saved with the card.</p>
    </div>
  )
}

const STORY_PARTS = [
  { key: 'situation', label: 'Situation', hint: 'Where were you, and what was going on?' },
  { key: 'task', label: 'Task', hint: 'What did you need to do, or what was the problem?' },
  { key: 'action', label: 'Action', hint: 'What did you do — you, not the team?' },
  { key: 'result', label: 'Result', hint: 'What happened? A number if you have one, and what you learned.' },
]
const STORY_CATEGORIES = new Set(['Behavioural', 'Situational'])

function StoryForm({ initial, cardId, onSaved, onCancel, showToast }) {
  const [form, setForm] = useState(() => ({ title: '', situation: '', task: '', action: '', result: '', tags: '', ...(initial || {}) }))
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  async function save(e) {
    e.preventDefault()
    setBusy(true)
    const res = await window.api.savePracticeStory({ ...form, id: initial?.id, cardId })
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not save the story', 'error'); return }
    showToast?.(initial?.id ? 'Story updated' : 'Story saved', 'success')
    onSaved(res.story)
  }
  return (
    <form onSubmit={save} className="practice-panel" aria-label={initial?.id ? 'Edit story' : 'New story'}>
      <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor={`story-title-${initial?.id || 'new'}`}>Title</label>
      <input id={`story-title-${initial?.id || 'new'}`} value={form.title} maxLength={120} onChange={e => set('title', e.target.value)}
        placeholder="e.g. Fixing the capstone deploy the night before the demo" style={{ marginTop: 4, marginBottom: 8 }} />
      {STORY_PARTS.map(p => (
        <div key={p.key} style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor={`story-${p.key}-${initial?.id || 'new'}`}>{p.label}</label>
          <textarea id={`story-${p.key}-${initial?.id || 'new'}`} value={form[p.key]} maxLength={2000} rows={2} placeholder={p.hint}
            onChange={e => set(p.key, e.target.value)} style={{ width: '100%', marginTop: 4 }} />
        </div>
      ))}
      <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor={`story-tags-${initial?.id || 'new'}`}>Tags (optional)</label>
      <input id={`story-tags-${initial?.id || 'new'}`} value={form.tags} maxLength={200} onChange={e => set('tags', e.target.value)}
        placeholder="teamwork, deadline, conflict" style={{ marginTop: 4 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{initial?.id ? 'Save story' : 'Save story'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function StoryBody({ story }) {
  return (
    <dl className="practice-star">
      {STORY_PARTS.filter(p => story[p.key]).map(p => (
        <div key={p.key}><dt>{p.label[0]}</dt><dd><strong>{p.label}.</strong> {story[p.key]}</dd></div>
      ))}
    </dl>
  )
}

// Stories attached to one card, attaching more, and writing a new one in place.
function StoryPanel({ card, onClose, onChanged, showToast }) {
  const [all, setAll] = useState(null)
  const [linked, setLinked] = useState(card.storyIds || [])
  const [writing, setWriting] = useState(false)
  const [pick, setPick] = useState('')
  const load = useCallback(async () => { setAll(await window.api.getPracticeStories()) }, [])
  useEffect(() => { load() }, [load])
  const attached = (all || []).filter(s => linked.includes(s.id))
  const others = (all || []).filter(s => !linked.includes(s.id))

  async function attach() {
    if (!pick) return
    const res = await window.api.linkPracticeStory(card.id, Number(pick))
    if (!res?.success) { showToast?.(res?.error || 'Could not attach the story', 'error'); return }
    setLinked(l => [...l, Number(pick)]); setPick(''); onChanged?.()
  }
  async function detach(id) {
    await window.api.unlinkPracticeStory(card.id, id)
    setLinked(l => l.filter(x => x !== id)); onChanged?.()
  }

  return (
    <div className="practice-panel" aria-label="STAR stories for this question">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>★ Your STAR stories for this question</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      {!all && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>}
      {all && attached.length === 0 && !writing && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
          No story attached. Behavioural questions are easier with a real example ready: Situation, Task, Action, Result.
        </p>
      )}
      {attached.map(s => (
        <details key={s.id} open={attached.length === 1} className="practice-story">
          <summary><strong>{s.title}</strong></summary>
          <StoryBody story={s} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => detach(s.id)}>Detach from this question</button>
        </details>
      ))}
      {writing ? (
        <StoryForm cardId={card.id} showToast={showToast} onCancel={() => setWriting(false)}
          onSaved={s => { setWriting(false); setLinked(l => [...l, s.id]); load(); onChanged?.() }} />
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          {others.length > 0 && (
            <>
              <select aria-label="Attach a story" className="practice-select" value={pick} onChange={e => setPick(e.target.value)}>
                <option value="">Attach a story you wrote…</option>
                {others.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
              <button type="button" className="btn btn-sm" disabled={!pick} onClick={attach}>Attach</button>
            </>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setWriting(true)}>Write a new story</button>
        </div>
      )}
    </div>
  )
}

// The secondary actions on any card: Ask AI, stories, note, report.
function CardTools({ card, onChanged, showToast, compact = false }) {
  const [panel, setPanel] = useState(null) // 'ask' | 'stories' | 'note' | 'report'
  const [note, setNote] = useState(card.note || '')
  useEffect(() => { setPanel(null); setNote(card.note || '') }, [card.id, card.note])
  const toggle = p => setPanel(cur => (cur === p ? null : p))
  const storyCount = card.storyIds?.length || 0
  const behavioural = STORY_CATEGORIES.has(card.category)
  return (
    <>
      {panel !== 'note' && <SavedNote note={note} onEdit={() => setPanel('note')} />}
      <div className="practice-tools" style={compact ? { marginTop: 8 } : undefined}>
        <button type="button" className={`btn btn-sm ${panel === 'ask' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggle('ask')}>
          ✦ Ask AI{card.explained && panel !== 'ask' ? ' · saved' : ''}
        </button>
        {(behavioural || storyCount > 0) && (
          <button type="button" className={`btn btn-sm ${panel === 'stories' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggle('stories')}>
            ★ {storyCount ? `Stories (${storyCount})` : 'Add a STAR story'}
          </button>
        )}
        <button type="button" className={`btn btn-sm ${panel === 'note' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggle('note')}>
          ✎ {note ? 'Edit note' : 'Add note'}
        </button>
        {card.flag ? null : (
          <button type="button" className={`btn btn-sm ${panel === 'report' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggle('report')}>
            ⚑ Report
          </button>
        )}
      </div>
      {panel === 'ask' && <AskPanel card={card} onClose={() => setPanel(null)} onChanged={onChanged} showToast={showToast} />}
      {panel === 'stories' && <StoryPanel card={card} onClose={() => setPanel(null)} onChanged={onChanged} showToast={showToast} />}
      {panel === 'note' && (
        <NoteEditor card={{ ...card, note }} showToast={showToast} onCancel={() => setPanel(null)}
          onSaved={n => { setNote(n); setPanel(null); onChanged?.() }} />
      )}
      {panel === 'report' && (
        <ReportForm card={card} showToast={showToast} onCancel={() => setPanel(null)} onDone={() => { setPanel(null); onChanged?.({ reported: true }) }} />
      )}
    </>
  )
}

function StatPills({ stats }) {
  if (!stats) return null
  const goalMet = stats.daysThisWeek >= stats.weeklyGoalDays
  return (
    <div className="practice-stats" aria-label="Practice progress">
      <span title="Days you practised this week, against a goal of 4" style={goalMet ? { color: 'var(--green)' } : undefined}>
        <strong>{stats.daysThisWeek}/{stats.weeklyGoalDays}</strong> days this week{goalMet ? ' ✓' : ''}
      </span>
      <span title="Days in a row with practice"><strong>{stats.streak}</strong>-day streak</span>
      <span title="Cards due for review now"><strong>{stats.due}</strong> due</span>
      <span title="Cards you remember well enough to see three weeks or more apart"><strong>{stats.learned}</strong>/{stats.total} learned</span>
    </div>
  )
}

function StoriesView({ showToast, onChanged }) {
  const [list, setList] = useState(null)
  const [editing, setEditing] = useState(null) // story, or {} for a new one
  const [confirm, setConfirm] = useState(null)
  const load = useCallback(async () => {
    try { setList(await window.api.getPracticeStories()) } catch (err) { showToast?.(err.message, 'error') }
  }, [showToast])
  useEffect(() => { load() }, [load])
  async function remove(id) {
    const res = await window.api.deletePracticeStory(id)
    setConfirm(null)
    if (!res?.success) { showToast?.(res?.error || 'Could not delete the story', 'error'); return }
    load(); onChanged()
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Your STAR stories</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          Write each real example once — Situation, Task, Action, Result — then attach it to the behavioural questions it answers.
          Four or five good stories cover most interviews. Ask AI uses the stories attached to a question.
        </p>
        {editing ? (
          <StoryForm initial={editing.id ? editing : null} showToast={showToast} onCancel={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); onChanged() }} />
        ) : <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>Write a new story</button>}
      </div>
      {!list && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>}
      {list?.length === 0 && !editing && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No stories yet.</p>}
      {list?.map(s => (
        <details key={s.id} className="card practice-item">
          <summary>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</span>
            <span className="practice-item-meta">
              {s.linkedCards ? `Attached to ${s.linkedCards} question${s.linkedCards === 1 ? '' : 's'}` : 'Not attached yet'}
              {s.tags ? ` · ${s.tags}` : ''}
            </span>
          </summary>
          <div style={{ marginTop: 10 }}>
            <StoryBody story={s} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(s)}>Edit</button>
              {confirm === s.id ? (
                <>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(s.id)}>Delete story</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Keep</button>
                </>
              ) : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(s.id)}>Delete</button>}
            </div>
          </div>
        </details>
      ))}
    </div>
  )
}

const pct = n => `${Math.round(n * 100)}%`

function InsightsView({ active, onPractise, onNavigate }) {
  const [days, setDays] = useState(90)
  const [data, setData] = useState(null)
  useEffect(() => {
    if (active === false) return
    let live = true
    Promise.resolve(window.api.getPracticeInsights({ days })).then(d => { if (live) setData(d) })
    return () => { live = false }
  }, [active, days])
  if (!data) return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Reading your ratings…</p>
  const priority = data.topics.filter(t => t.againRate >= 0.25 && t.demand)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {data.totals.reviews} ratings on {data.totals.activeDays} day{data.totals.activeDays === 1 ? '' : 's'} · forgot {pct(data.totals.againRate)} overall
        </p>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Last
          <select aria-label="Insights period" className="practice-select" value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>year</option>
          </select>
        </label>
      </div>

      {priority.length > 0 && (
        <div className="practice-note" role="note">
          <strong>Where practice pays most:</strong>{' '}
          {priority.slice(0, 3).map(t => `${t.name} (forgot ${pct(t.againRate)}, asked for in ${pct(t.demand.share)} of recent ads)`).join('; ')}.
        </div>
      )}

      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Weak topics</h2>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10 }}>How often you rated a topic “Again”. Topics need four or more ratings to show.</p>
        {data.topics.length === 0
          ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Not enough ratings yet. This fills in as you practise.</p>
          : (
            <table className="practice-table">
              <thead><tr><th scope="col">Topic</th><th scope="col">Forgot</th><th scope="col">Employers ask for it</th><th scope="col" aria-label="Action"></th></tr></thead>
              <tbody>
                {data.topics.map(t => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><span className={`badge ${t.againRate >= 0.4 ? 'badge-red' : t.againRate >= 0.2 ? 'badge-yellow' : 'badge-green'}`}>{pct(t.againRate)}</span> <span className="practice-muted">{t.again} of {t.reviews}</span></td>
                    <td>{t.demand
                      ? <>{pct(t.demand.share)} of ads <span className="practice-muted">({t.demand.skill}{t.demand.inResume ? ', in your résumé' : ', not in your résumé'})</span></>
                      : <span className="practice-muted">—</span>}</td>
                    <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => onPractise(t.name)}>Practise</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          {data.skillsGap.available
            ? <>Demand comes from the {data.skillsGap.sample} job ads Hiro has read in the last 90 days. </>
            : <>Demand appears once Hiro has read enough job ads. </>}
          {onNavigate && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('analytics')}>Open the skills report</button>}
        </p>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Cards you forget most</h2>
        {data.weakCards.length === 0
          ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>None yet.</p>
          : (
            <ol style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.weakCards.map(c => (
                <li key={c.id} style={{ fontSize: 13.5 }}>
                  {c.question} <span className="practice-muted">· {topicLabel(c)} · forgot {c.lapses}×</span>
                </li>
              ))}
            </ol>
          )}
      </div>
    </div>
  )
}

// Where the question bank came from, and a manual check for updates.
function BankStatus({ showToast, onUpdated }) {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (typeof window.api?.getPracticeBankInfo !== 'function') return
    Promise.resolve(window.api.getPracticeBankInfo()).then(setInfo)
  }, [])
  if (!info) return null
  async function check() {
    setBusy(true)
    const res = await window.api.refreshPracticeBank()
    setBusy(false)
    if (!res?.success) { showToast?.(`Could not check for updates: ${res?.error || 'unknown error'}`, 'error'); return }
    showToast?.(res.updated ? `Question bank updated: ${res.count} questions` : 'The question bank is up to date', 'success')
    setInfo(await window.api.getPracticeBankInfo())
    if (res.updated) onUpdated()
  }
  return (
    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      Question bank: {info.count} questions, updated {info.updatedAt || 'unknown'} ({info.source === 'downloaded' ? 'latest published' : 'built in'}).
      {info.updates
        ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check for updates'}</button>
        : ' Updates are off.'}
    </p>
  )
}

function TopicPicker({ topics, settings, onChange, extra }) {
  const [open, setOpen] = useState(false)
  const selected = new Set(settings.topics)
  const all = selected.size === 0
  const toggle = (name) => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name); else next.add(name)
    onChange({ ...settings, topics: [...next] })
  }
  const summary = all ? 'All topics' : settings.topics.length === 1 ? settings.topics[0] : `${settings.topics.length} topics`
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          Topics: {summary} {open ? '▴' : '▾'}
        </button>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Cards a day
          <select aria-label="Cards a day" value={settings.dailyCount} className="practice-select"
            onChange={e => onChange({ ...settings, dailyCount: Number(e.target.value) })}>
            {[...new Set([...COUNTS, settings.dailyCount])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {extra}
      </div>
      {open && (
        <div className="practice-panel" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className={`chip${all ? ' chip-on' : ''}`} aria-pressed={all} onClick={() => onChange({ ...settings, topics: [] })}>All topics</button>
          {topics.map(t => (
            <button key={t.name} type="button" className={`chip${selected.has(t.name) ? ' chip-on' : ''}`} aria-pressed={selected.has(t.name)} onClick={() => toggle(t.name)}>
              {t.name} <span style={{ color: 'var(--text-muted)' }}>{t.count}</span>
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)}>Done</button>
        </div>
      )}
    </div>
  )
}

const daysText = d => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`)

// Interviews in the next week. Their questions already lead today's set; this
// says so, and offers to create questions for one that has none yet.
function CountdownBanner({ countdown, onPrepared, showToast }) {
  const [busy, setBusy] = useState(null)
  if (!countdown?.length) return null
  async function prepare(c) {
    setBusy(c.applicationId)
    const res = await window.api.preparePracticeJobDeck(c.applicationId)
    setBusy(null)
    if (!res?.success) { showToast?.(res?.error || 'Could not create questions', 'error'); return }
    showToast?.(`${res.cards} questions ready for ${c.company || 'this interview'}`, 'success')
    onPrepared()
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }} aria-label="Upcoming interviews">
      {countdown.map(c => (
        <div key={c.applicationId} className="practice-countdown" role="status">
          <span className="practice-countdown-days">{c.daysLeft === 0 ? 'Today' : c.daysLeft === 1 ? '1 day' : `${c.daysLeft} days`}</span>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{c.company || 'Interview'} interview {daysText(c.daysLeft)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              {c.jobTitle}{c.jobTitle ? ' · ' : ''}
              {c.cards === 0
                ? 'no practice questions for this job yet'
                : c.cardsLeft > 0
                  ? `${c.cardsLeft} of ${c.cards} card${c.cards === 1 ? '' : 's'} left today — they come first`
                  : `all ${c.cards} cards done for today ✓`}
            </div>
          </div>
          {c.cards === 0 && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy === c.applicationId} onClick={() => prepare(c)}>
              {busy === c.applicationId ? 'Creating…' : 'Create interview questions'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function ReminderControl({ showToast }) {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(null)
  const [draft, setDraft] = useState({ enabled: false, time: '19:00' })
  useEffect(() => {
    if (typeof window.api?.getPracticeReminder !== 'function') return
    Promise.resolve(window.api.getPracticeReminder()).then(s => { if (s) { setSettings(s); setDraft(s) } })
  }, [])
  if (!settings) return null
  async function save(e) {
    e.preventDefault()
    const res = await window.api.savePracticeReminder(draft)
    if (!res?.success) { showToast?.(res?.error || 'Could not save the reminder', 'error'); return }
    setSettings(res.settings); setOpen(false)
    showToast?.(res.settings.enabled ? `Reminder set for ${res.settings.time} each day` : 'Reminder off', 'success')
  }
  return (
    <span style={{ position: 'relative' }}>
      <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        🔔 Reminder: {settings.enabled ? settings.time : 'off'}
      </button>
      {open && (
        <form onSubmit={save} className="practice-popover" aria-label="Daily practice reminder">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} />
            Remind me to practise each day
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 8 }}>
            at <input type="time" aria-label="Reminder time" value={draft.time} className="practice-select" onChange={e => setDraft(d => ({ ...d, time: e.target.value }))} />
          </label>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '8px 0' }}>
            On this computer, and on your phone when phone notifications are on. Skipped on days you have already practised; it warns you when a streak is at stake.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm">Save</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDraft(settings); setOpen(false) }}>Cancel</button>
          </div>
        </form>
      )}
    </span>
  )
}

function TodayView({ active, data, reload, showToast }) {
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = data?.cards.find(c => c.id === data.queue[0]) || null
  const position = data ? data.doneCount + 1 : 0
  const total = data?.cards.length || 0

  useEffect(() => { setRevealed(false) }, [current?.id])

  const rate = useCallback(async (rating) => {
    if (!current || busy) return
    setBusy(true)
    const res = await window.api.ratePracticeCard(current.id, rating)
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not save the rating', 'error'); return }
    reload()
  }, [current, busy, reload, showToast])

  // Space or Enter shows the answer; 1–4 rate it once shown. Registered in the
  // capture phase and marked handled, so the app-wide digit shortcuts (which
  // switch pages) leave a rating keystroke alone. Typing in a note or a
  // follow-up question is never intercepted.
  useEffect(() => {
    if (!active || !current) return
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || el?.isContentEditable) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (!revealed && (e.key === ' ' || e.key === 'Enter') && el?.tagName !== 'BUTTON') {
        e.preventDefault(); setRevealed(true); return
      }
      const idx = ['1', '2', '3', '4'].indexOf(e.key)
      if (revealed && idx >= 0) { e.preventDefault(); rate(RATINGS[idx].key) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, current, revealed, rate])

  async function practiseMore() {
    setBusy(true)
    const res = await window.api.practiceMore(data.settings.dailyCount)
    setBusy(false)
    if (res?.cards) reload(res)
  }

  if (!data) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Choosing today&apos;s cards…</p>

  if (!current) {
    const empty = data.cards.length === 0
    return (
      <div className="card" style={{ textAlign: 'center', padding: 32 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{empty ? 'No cards for these topics' : 'Done for today'}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          {empty
            ? 'Pick more topics, generate a deck from a job ad, or restore cards you reported.'
            : `${data.doneCount} card${data.doneCount === 1 ? '' : 's'} reviewed. Come back tomorrow for the next set.`}
          {data.dueLater > 0 && ` ${data.dueLater} more card${data.dueLater === 1 ? ' is' : 's are'} due.`}
        </p>
        {data.available > 0 && (
          <button className="btn btn-primary" disabled={busy} onClick={practiseMore}>
            Practise {Math.min(data.settings.dailyCount, data.available)} more
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="card practice-card">
      <div className="practice-progress" aria-hidden="true"><div style={{ width: `${Math.round((data.doneCount / Math.max(1, total)) * 100)}%` }} /></div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, alignItems: 'flex-start' }}>
        <CardMeta card={current} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Card {position} of {total}</span>
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.35, marginBottom: 18 }}>{current.question}</h2>
      {!revealed ? (
        <button className="btn btn-primary" onClick={() => setRevealed(true)}>Show answer <span style={{ opacity: 0.7 }}>(Space)</span></button>
      ) : (
        <>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 16 }}>
            <SafeAnswer answer={current.answer} format={current.format} blocks={current.blocks} />
          </div>
          <div role="group" aria-label="How well did you know it?" className="practice-ratings">
            {RATINGS.map((r, i) => (
              <button key={r.key} className={r.className} disabled={busy} onClick={() => rate(r.key)} title={`${r.hint} (${i + 1})`}>
                {r.label} <span style={{ opacity: 0.7, fontWeight: 400 }}>· {formatInterval(current.intervals[r.key])}</span>
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Keys 1–4 rate the card. Again and Hard bring it back sooner.</p>
        </>
      )}
      <div style={{ marginTop: 16 }}>
        <CardTools card={current} showToast={showToast} onChanged={() => reload()} />
      </div>
    </div>
  )
}

function BrowseView({ bank, onChanged, showToast }) {
  const [search, setSearch] = useState('')
  const [topic, setTopic] = useState('')
  const [category, setCategory] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const shown = useMemo(() => {
    if (!bank) return []
    const needle = search.trim().toLowerCase()
    return bank.cards.filter(c => {
      if (topic && c.topicKey !== topic) return false
      if (category && c.category !== category) return false
      if (difficulty && c.difficulty !== difficulty) return false
      if (!needle) return true
      return [c.question, plain(c.answer), c.topic, c.category, c.note, ...(c.tags || []), ...(c.versions || [])].join(' ').toLowerCase().includes(needle)
    })
  }, [bank, search, topic, category, difficulty])

  if (!bank) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading questions…</p>

  async function restore(id) {
    const res = await window.api.unflagPracticeCard(id)
    if (!res?.success) { showToast?.(res?.error || 'Could not restore the card', 'error'); return }
    onChanged()
  }

  return (
    <div>
      <div className="practice-filters">
        <input type="search" aria-label="Search questions" placeholder="Search questions, answers, notes and tags" value={search}
          onChange={e => setSearch(e.target.value)} />
        <select aria-label="Topic" value={topic} onChange={e => setTopic(e.target.value)}>
          <option value="">All topics</option>
          {bank.topics.map(t => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
        </select>
        <select aria-label="Category" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">Any category</option>
          {(bank.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="Difficulty" value={difficulty} onChange={e => setDifficulty(e.target.value)}>
          <option value="">Any difficulty</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 8px' }} role="status">{shown.length} of {bank.cards.length} questions</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map(c => (
          <details key={c.id} className="card practice-item">
            <summary>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{c.question}</span>
              <span className="practice-item-meta">
                {topicLabel(c)}{c.category && c.category !== c.topic ? ` · ${c.category}` : ''}{c.note ? ' · ✎ note' : ''}{c.explained ? ' · ✦ AI' : ''}
                {c.flag && <span className="badge badge-red" style={{ marginLeft: 8 }}>Reported</span>}
              </span>
            </summary>
            <div style={{ marginTop: 10 }}>
              <CardMeta card={c} />
              <div style={{ marginTop: 10 }}><SafeAnswer answer={c.answer} format={c.format} blocks={c.blocks} /></div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap', marginBottom: 4 }}>
                <span>{c.state ? `Next review ${c.state.dueOn}` : 'Not practised yet'}</span>
                {c.updatedAt && <span>Updated {c.updatedAt}</span>}
                {c.flag && <button className="btn btn-sm" onClick={() => restore(c.id)}>Restore to practice</button>}
              </div>
              <CardTools card={c} compact showToast={showToast} onChanged={onChanged} />
            </div>
          </details>
        ))}
      </div>
      <BankStatus showToast={showToast} onUpdated={onChanged} />
    </div>
  )
}

function deckSource(d) {
  if (d.source === 'import') return 'imported from a file'
  if (d.source === 'web-page') {
    let host = ''
    try { host = new URL(d.sourceUrl).hostname.replace(/^www\./, '') } catch { /* no address */ }
    return host ? `from ${host}` : 'from a web page'
  }
  return 'from a job ad'
}

function readText(file) {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

// A page the user is studying, turned into flashcards for their own use.
function WebPageForm({ sizes, onCreated, showToast, readyNote }) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [count, setCount] = useState(15)
  const [busy, setBusy] = useState(false)
  const valid = /^https?:\/\/\S+\.\S+/i.test(url.trim())
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    const res = await window.api.practiceDeckFromUrl({ url: url.trim(), title, count })
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not make cards from that page', 'error'); return }
    setUrl(''); setTitle('')
    onCreated(res.deck)
  }
  return (
    <form className="card" onSubmit={submit} style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Turn a web page into cards</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
        Paste the address of an article, tutorial or list of interview questions you&apos;re studying. Hiro reads the page and writes flashcards from it, for your own practice.
      </p>
      <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor="deck-url">Page address</label>
      <input id="deck-url" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" style={{ marginTop: 4, marginBottom: 10 }} />
      <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor="deck-url-title">Deck name (optional)</label>
      <input id="deck-url-title" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="Defaults to the page title" style={{ marginTop: 4 }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Questions
          <select aria-label="Number of questions from the page" value={count} className="practice-select" onChange={e => setCount(Number(e.target.value))}>
            {(sizes || [10, 15, 20]).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>{busy ? 'Reading the page and writing cards…' : 'Make cards'}</button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Uses your AI provider (one request). Pages behind a sign-in can&apos;t be read.</span>
      </div>
      {readyNote}
    </form>
  )
}

const IMPORT_ACCEPT = '.csv,.tsv,.txt,.json'
const IMPORT_EXAMPLE = 'question,answer,topic\n"What is a closure?","A function that remembers the variables from where it was created.",JavaScript'

// The user's own question file: previewed, then saved as a deck.
function ImportForm({ onCreated, showToast, readyNote }) {
  const [file, setFile] = useState(null) // { name, text }
  const [preview, setPreview] = useState(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  async function choose(f) {
    if (!f) return
    setPreview(null)
    try {
      if (f.size > 2 * 1024 * 1024) { showToast?.('That file is larger than 2 MB. Split it into smaller files.', 'error'); return }
      const text = await readText(f)
      const res = await window.api.previewPracticeImport({ name: f.name, text })
      if (!res?.success) { showToast?.(res?.error || 'Could not read that file', 'error'); return }
      setFile({ name: f.name, text }); setPreview(res); setTitle(res.suggestedTitle)
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function confirm() {
    setBusy(true)
    const res = await window.api.importPracticeDeck({ ...file, title })
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not import the file', 'error'); return }
    setFile(null); setPreview(null); setTitle('')
    onCreated(res.deck, `Imported ${res.deck.cards} questions into “${res.deck.title}”${res.skippedCount ? ` (${res.skippedCount} skipped)` : ''}`)
  }

  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Import your own questions</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
        A CSV or tab-separated file (from Excel, Google Sheets or Quizlet), an Anki “Notes in Plain Text” export, or JSON. The first column is the question and the second the answer, or use a header row with <code>question</code>, <code>answer</code> and optionally <code>topic</code>, <code>category</code> and <code>difficulty</code>.
      </p>
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>Example CSV</summary>
        <pre className="practice-example">{IMPORT_EXAMPLE}</pre>
      </details>
      <input ref={inputRef} type="file" accept={IMPORT_ACCEPT} style={{ display: 'none' }} aria-label="Choose a question file" onChange={e => choose(e.target.files?.[0])} />
      <button type="button" className="btn btn-primary btn-sm" onClick={() => inputRef.current?.click()}>{preview ? 'Choose another file' : 'Choose a file'}</button>

      {preview && (
        <div className="practice-panel" aria-label="Import preview">
          <p style={{ fontSize: 13, margin: 0 }}>
            <strong>{file.name}</strong> · {preview.formatLabel} · <strong>{preview.count}</strong> question{preview.count === 1 ? '' : 's'} ready
            {preview.skippedCount > 0 && <>, {preview.skippedCount} skipped</>}
          </p>
          {preview.skippedCount > 0 && (
            <ul style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0', paddingLeft: 18 }}>
              {preview.skipped.slice(0, 5).map((s, i) => <li key={i}>{s.where}: {s.reason}</li>)}
              {preview.skippedCount > 5 && <li>…and {preview.skippedCount - 5} more</li>}
            </ul>
          )}
          {preview.sample.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {preview.sample.slice(0, 3).map((c, i) => (
                <div key={i} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.question}</div>
                  <div className="practice-answer" style={{ fontSize: 13 }}><TextBlocks blocks={c.blocks} /></div>
                </div>
              ))}
            </div>
          )}
          {preview.count > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, fontWeight: 600, flex: '1 1 220px' }}>
                Deck name
                <input value={title} maxLength={60} onChange={e => setTitle(e.target.value)} style={{ marginTop: 4 }} />
              </label>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={confirm}>
                {busy ? 'Importing…' : `Import ${preview.count} question${preview.count === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </div>
      )}
      {readyNote}
    </div>
  )
}

function DecksView({ onPractise, onChanged, showToast }) {
  const [data, setData] = useState(null)
  const [title, setTitle] = useState('')
  const [jobText, setJobText] = useState('')
  const [count, setCount] = useState(15)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [created, setCreated] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [renaming, setRenaming] = useState(null) // { id, title }
  const [mode, setMode] = useState('job') // 'job' | 'web' | 'import'
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    try { setData(await window.api.getPracticeDecks()) } catch (err) { showToast?.(err.message, 'error') }
  }, [showToast])
  useEffect(() => { load() }, [load])

  async function upload(file) {
    if (!file) return
    setReading(true)
    try {
      const res = await window.api.askHiroReadAttachment(file.name, await readBytes(file))
      if (!res?.success) { showToast?.(res?.error || 'Could not read that file', 'error'); return }
      setJobText(res.text)
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 60))
      showToast?.(`Read ${file.name}${res.words ? ` (${res.words} words)` : ''}`, 'success')
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function generate(e) {
    e.preventDefault()
    setBusy(true); setCreated(null)
    const res = await window.api.generatePracticeDeck({ title, jobText, count })
    setBusy(false)
    if (!res?.success) { showToast?.(res?.error || 'Could not generate questions', 'error'); return }
    setTitle(''); setJobText('')
    created_(res.deck)
  }

  async function remove(id) {
    const res = await window.api.deletePracticeDeck(id)
    setConfirmDelete(null)
    if (!res?.success) { showToast?.(res?.error || 'Could not delete the deck', 'error'); return }
    if (created?.id === id) setCreated(null)
    load(); onChanged()
  }

  async function rename(e) {
    e.preventDefault()
    const res = await window.api.renamePracticeDeck(renaming.id, renaming.title)
    if (!res?.success) { showToast?.(res?.error || 'Could not rename the deck', 'error'); return }
    setRenaming(null)
    load(); onChanged()
  }

  const words = (jobText.match(/\S+/g) || []).length
  const created_ = (deck, note) => {
    setCreated(deck)
    showToast?.(note || `Created “${deck.title}” with ${deck.cards} questions`, 'success')
    load(); onChanged()
  }
  const readyNote = created && (
    <div className="practice-note" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13 }}>“{created.title}” is ready: {created.cards} questions.</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onPractise(created.topic)}>Practise this deck now</button>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div role="tablist" aria-label="Ways to add a deck" style={{ display: 'flex', gap: 6 }}>
        {[['job', 'From a job ad'], ['web', 'From a web page'], ['import', 'Import a file']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
            style={mode === id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => { setMode(id); setCreated(null) }}>{label}</button>
        ))}
      </div>
      {mode === 'web' && <WebPageForm sizes={data?.sizes} onCreated={created_} showToast={showToast} readyNote={readyNote} />}
      {mode === 'import' && <ImportForm onCreated={created_} showToast={showToast} readyNote={readyNote} />}
      {mode === 'job' && (
      <form className="card" onSubmit={generate} style={{ padding: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Practise for a specific job</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Paste a job description or upload it, and Hiro writes interview questions matched to that role&apos;s stack, with model answers.
        </p>
        <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor="deck-title">Deck name (optional)</label>
        <input id="deck-title" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="e.g. Acme — Junior React Developer" style={{ marginTop: 4, marginBottom: 10 }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ fontSize: 12, fontWeight: 600 }} htmlFor="deck-job">Job description</label>
          <span>
            <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: 'none' }} aria-label="Upload a job description file" onChange={e => upload(e.target.files?.[0])} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={reading} onClick={() => fileRef.current?.click()}>
              {reading ? 'Reading…' : 'Upload file (PDF, Word, text)'}
            </button>
          </span>
        </div>
        <textarea id="deck-job" value={jobText} onChange={e => setJobText(e.target.value)} rows={8} maxLength={20000}
          placeholder="Paste the full job ad here…" style={{ width: '100%', marginTop: 4 }} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Questions
            <select aria-label="Number of questions" value={count} className="practice-select" onChange={e => setCount(Number(e.target.value))}>
              {(data?.sizes || [10, 15, 20]).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || words < 15}>
            {busy ? 'Writing questions… (up to a minute)' : 'Generate questions'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{words} words · uses your AI provider (one request)</span>
        </div>
        {readyNote}
      </form>
      )}

      <div>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Your decks</h3>
        {!data && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>}
        {data && data.generated.length === 0 && data.applications.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No decks yet. Generate one above, or open an application&apos;s interview prep to create its questions.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data?.generated.map(d => (
            <div key={d.id} className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {renaming?.id === d.id ? (
                <form onSubmit={rename} style={{ display: 'flex', gap: 6, flex: 1 }}>
                  <input aria-label="Deck name" value={renaming.title} maxLength={60} autoFocus onChange={e => setRenaming({ ...renaming, title: e.target.value })} style={{ flex: 1 }} />
                  <button type="submit" className="btn btn-primary btn-sm">Save</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{d.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {d.cards} questions · {deckSource(d)} · {String(d.created_at || '').slice(0, 10)}
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onPractise(d.topic)}>Practise</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming({ id: d.id, title: d.title })}>Rename</button>
                  {confirmDelete === d.id ? (
                    <>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(d.id)}>Delete deck</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Keep</button>
                    </>
                  ) : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(d.id)}>Delete</button>}
                </>
              )}
            </div>
          ))}
          {data?.applications.length > 0 && (
            <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>From your applications</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {data.applications.map(a => `${a.title} (${a.cards})`).join(' · ')}
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onPractise('Job decks')}>Practise</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReportedView({ bank, onChanged, showToast }) {
  if (!bank) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
  const flagged = bank.cards.filter(c => c.flag)
  const total = flagged.length + bank.orphanFlags.length
  async function restore(id) {
    const res = await window.api.unflagPracticeCard(id)
    if (!res?.success) { showToast?.(res?.error || 'Could not restore the card', 'error'); return }
    onChanged()
  }
  if (total === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing reported. Use “Report” on a card whose answer looks outdated or wrong.</p>
  }
  const reasonLabel = r => REASONS.find(x => x.key === r)?.label || r
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reported cards are left out of practice until you restore them.</p>
      {flagged.map(c => (
        <div key={c.id} className="card" style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{c.question}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {reasonLabel(c.flag.reason)} · {topicLabel(c)} · {String(c.flag.flagged_at || '').slice(0, 10)}
              </div>
              {c.flag.note && <p style={{ fontSize: 13, marginTop: 6 }}>{c.flag.note}</p>}
            </div>
            <button className="btn btn-sm" onClick={() => restore(c.id)}>Restore</button>
          </div>
        </div>
      ))}
      {bank.orphanFlags.map(f => (
        <div key={f.card_id} className="card" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>A reported question that no longer exists ({reasonLabel(f.reason)})</span>
          <button className="btn btn-sm" onClick={() => restore(f.card_id)}>Clear</button>
        </div>
      ))}
    </div>
  )
}

export default function Practice({ active, showToast, onNavigate }) {
  const [tab, setTab] = useState('today')
  const [today, setToday] = useState(null)
  const [stats, setStats] = useState(null)
  const [bank, setBank] = useState(null)
  const [error, setError] = useState(null)
  const available = typeof window.api?.getPracticeToday === 'function'

  const loadToday = useCallback(async (given) => {
    try {
      const [t, s] = await Promise.all([given ? Promise.resolve(given) : window.api.getPracticeToday(), window.api.getPracticeStats()])
      setToday(t); setStats(s); setError(null)
    } catch (err) { setError(err.message) }
  }, [])

  const loadBank = useCallback(async () => {
    try { setBank(await window.api.getPracticeBank()); setError(null) } catch (err) { setError(err.message) }
  }, [])

  // Refreshed on every visit: the day may have turned over, and a job deck may
  // have gained questions since the page was last open.
  useEffect(() => { if (active !== false && available) loadToday() }, [active, available, loadToday])
  useEffect(() => { if (active !== false && available && (tab === 'browse' || tab === 'reported')) loadBank() }, [active, available, tab, loadBank])

  const afterChange = useCallback(() => { loadToday(); loadBank() }, [loadToday, loadBank])
  const reloadToday = useCallback((given) => { loadToday(given); setBank(null) }, [loadToday])

  const changeSettings = useCallback(async (next) => {
    const res = await window.api.savePracticeSettings(next)
    if (!res?.success) { showToast?.('Could not save practice settings', 'error'); return }
    reloadToday()
  }, [reloadToday, showToast])

  // "Practise this deck": today's set switches to that deck alone.
  const practiseTopic = useCallback(async (topic) => {
    await changeSettings({ topics: [topic], dailyCount: today?.settings.dailyCount || 8 })
    setTab('today')
  }, [changeSettings, today])

  if (!available) return null

  const tabs = [
    { id: 'today', label: 'Today' },
    { id: 'browse', label: 'Browse' },
    { id: 'decks', label: 'Decks' },
    { id: 'stories', label: 'Stories' },
    { id: 'insights', label: 'Insights' },
    { id: 'reported', label: `Reported${stats?.flagged ? ` (${stats.flagged})` : ''}` },
  ]

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Practice</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>A few interview questions a day. Hard ones come back sooner.</p>
        </div>
        <StatPills stats={stats} />
      </div>
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)', marginBottom: 12 }}>{error}</p>}
      <div role="tablist" aria-label="Practice views" style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'today' && (
        <>
          {today && <CountdownBanner countdown={today.countdown} showToast={showToast} onPrepared={() => reloadToday()} />}
          {today && <TopicPicker topics={today.topics} settings={today.settings} onChange={changeSettings} extra={<ReminderControl showToast={showToast} />} />}
          <TodayView active={active !== false && tab === 'today'} data={today} reload={reloadToday} showToast={showToast} />
        </>
      )}
      {tab === 'browse' && <BrowseView bank={bank} onChanged={afterChange} showToast={showToast} />}
      {tab === 'decks' && <DecksView onPractise={practiseTopic} onChanged={() => { reloadToday() }} showToast={showToast} />}
      {tab === 'stories' && <StoriesView showToast={showToast} onChanged={() => reloadToday()} />}
      {tab === 'insights' && <InsightsView active={active !== false} onPractise={practiseTopic} onNavigate={onNavigate} />}
      {tab === 'reported' && <ReportedView bank={bank} onChanged={afterChange} showToast={showToast} />}
    </div>
  )
}
