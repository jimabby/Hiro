import { useCallback, useEffect, useMemo, useState } from 'react'
import SafeAnswer from '../components/SafeAnswer'

// Practice: interview questions as flashcards, a few a day
// (services/practice.js). Cards rated Again or Hard come back sooner; Good and
// Easy push them further out (SM-2). Job decks are the questions Hiro already
// generated for real applications.

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

export function formatInterval(days) {
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return '1y'
}

const plain = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function CardBadges({ card }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="badge badge-blue">{card.deck === 'job' ? `Job: ${card.topic}` : card.topic}</span>
      {card.difficulty && <span className={`badge ${DIFFICULTY_TONE[card.difficulty]}`}>{card.difficulty}</span>}
      {card.category && <span className="badge badge-gray">{card.category}</span>}
      {card.versions?.map(v => <span key={v} className="badge badge-gray">{v}</span>)}
      <span className="badge badge-gray">{card.state ? `Review · seen ${card.state.reps + card.state.lapses}×` : 'New'}</span>
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
    <form onSubmit={submit} style={{ marginTop: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
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

function StatsRow({ stats }) {
  if (!stats) return null
  const goalMet = stats.daysThisWeek >= stats.weeklyGoalDays
  const tiles = [
    { label: 'This week', value: `${stats.daysThisWeek} of ${stats.weeklyGoalDays} days`, tone: goalMet ? 'var(--green)' : undefined },
    { label: 'Streak', value: `${stats.streak} day${stats.streak === 1 ? '' : 's'}` },
    { label: 'Due now', value: String(stats.due) },
    { label: 'Learned', value: `${stats.learned} of ${stats.total}`, title: 'Cards you remember well enough to see them three weeks or more apart' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
      {tiles.map(t => (
        <div key={t.label} className="card" style={{ padding: '12px 14px' }} title={t.title}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: t.tone }}>{t.value}</div>
        </div>
      ))}
    </div>
  )
}

function TopicPicker({ topics, settings, onChange }) {
  const selected = new Set(settings.topics)
  const all = selected.size === 0
  const toggle = (name) => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name); else next.add(name)
    onChange({ ...settings, topics: [...next] })
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
      <button type="button" className="chip" aria-pressed={all} onClick={() => onChange({ ...settings, topics: [] })}
        style={all ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>All topics</button>
      {topics.map(t => (
        <button key={t.name} type="button" className="chip" aria-pressed={selected.has(t.name)} onClick={() => toggle(t.name)}
          style={selected.has(t.name) ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>
          {t.name} <span style={{ color: 'var(--text-muted)' }}>{t.count}</span>
        </button>
      ))}
      <label style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
        Cards a day{' '}
        <select aria-label="Cards a day" value={settings.dailyCount} onChange={e => onChange({ ...settings, dailyCount: Number(e.target.value) })}>
          {[...new Set([...COUNTS, settings.dailyCount])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  )
}

function TodayView({ active, data, reload, showToast }) {
  const [revealed, setRevealed] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = data?.cards.find(c => c.id === data.queue[0]) || null
  const position = data ? data.doneCount + 1 : 0

  useEffect(() => { setRevealed(false); setReporting(false) }, [current?.id])

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
  // switch pages) leave a rating keystroke alone.
  useEffect(() => {
    if (!active || !current || reporting) return
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
  }, [active, current, revealed, reporting, rate])

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
            ? 'Pick more topics above, or restore cards you reported.'
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
    <div className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <CardBadges card={current} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Card {position} of {data.cards.length}</span>
      </div>
      <h2 style={{ fontSize: 19, fontWeight: 700, lineHeight: 1.35, marginBottom: 18 }}>{current.question}</h2>
      {!revealed ? (
        <button className="btn btn-primary" onClick={() => setRevealed(true)}>Show answer <span style={{ opacity: 0.7 }}>(Space)</span></button>
      ) : (
        <>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 18 }}>
            <SafeAnswer answer={current.answer} format={current.format} />
          </div>
          <div role="group" aria-label="How well did you know it?" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {RATINGS.map((r, i) => (
              <button key={r.key} className={r.className} disabled={busy} onClick={() => rate(r.key)} title={`${r.hint} (${i + 1})`}>
                {r.label} <span style={{ opacity: 0.7, fontWeight: 400 }}>· {formatInterval(current.intervals[r.key])}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ marginTop: 14 }}>
        {!reporting
          ? <button className="btn btn-ghost btn-sm" onClick={() => setReporting(true)}>Report outdated or wrong</button>
          : <ReportForm card={current} showToast={showToast} onCancel={() => setReporting(false)} onDone={() => { setReporting(false); reload() }} />}
      </div>
    </div>
  )
}

function BrowseView({ bank, onChanged, showToast }) {
  const [search, setSearch] = useState('')
  const [topic, setTopic] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [reportingId, setReportingId] = useState(null)
  const shown = useMemo(() => {
    if (!bank) return []
    const needle = search.trim().toLowerCase()
    return bank.cards.filter(c => {
      if (topic && (c.deck === 'job' ? 'Job decks' : c.topic) !== topic) return false
      if (difficulty && c.difficulty !== difficulty) return false
      if (!needle) return true
      return [c.question, plain(c.answer), c.topic, ...(c.tags || []), ...(c.versions || [])].join(' ').toLowerCase().includes(needle)
    })
  }, [bank, search, topic, difficulty])

  if (!bank) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading questions…</p>

  async function restore(id) {
    const res = await window.api.unflagPracticeCard(id)
    if (!res?.success) { showToast?.(res?.error || 'Could not restore the card', 'error'); return }
    onChanged()
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input type="search" aria-label="Search questions" placeholder="Search questions, answers and tags" value={search}
          onChange={e => setSearch(e.target.value)} style={{ flex: '1 1 260px' }} />
        <select aria-label="Topic" value={topic} onChange={e => setTopic(e.target.value)}>
          <option value="">All topics</option>
          {bank.topics.map(t => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
        </select>
        <select aria-label="Difficulty" value={difficulty} onChange={e => setDifficulty(e.target.value)}>
          <option value="">Any difficulty</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }} role="status">{shown.length} of {bank.cards.length} questions</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map(c => (
          <details key={c.id} className="card" style={{ padding: '12px 16px' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
              {c.question}
              {c.flag && <span className="badge badge-red" style={{ marginLeft: 8 }}>Reported</span>}
            </summary>
            <div style={{ marginTop: 10 }}>
              <CardBadges card={c} />
              <div style={{ marginTop: 10 }}><SafeAnswer answer={c.answer} format={c.format} /></div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                <span>{c.state ? `Next review ${c.state.dueOn}` : 'Not practised yet'}</span>
                {c.updatedAt && <span>Updated {c.updatedAt}</span>}
                {c.flag
                  ? <button className="btn btn-sm" onClick={() => restore(c.id)}>Restore to practice</button>
                  : reportingId !== c.id && <button className="btn btn-ghost btn-sm" onClick={() => setReportingId(c.id)}>Report outdated or wrong</button>}
              </div>
              {reportingId === c.id && (
                <ReportForm card={c} showToast={showToast} onCancel={() => setReportingId(null)} onDone={() => { setReportingId(null); onChanged() }} />
              )}
            </div>
          </details>
        ))}
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
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing reported. Use “Report outdated or wrong” on a card whose answer looks off.</p>
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
                {reasonLabel(c.flag.reason)} · {c.deck === 'job' ? `Job: ${c.topic}` : c.topic} · {String(c.flag.flagged_at || '').slice(0, 10)}
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

export default function Practice({ active, showToast }) {
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
  useEffect(() => { if (active !== false && available && tab !== 'today') loadBank() }, [active, available, tab, loadBank])

  const afterChange = useCallback(() => { loadToday(); loadBank() }, [loadToday, loadBank])
  const reloadToday = useCallback((given) => { loadToday(given); setBank(null) }, [loadToday])

  async function changeSettings(next) {
    const res = await window.api.savePracticeSettings(next)
    if (!res?.success) { showToast?.('Could not save practice settings', 'error'); return }
    reloadToday()
  }

  if (!available) return null

  const tabs = [
    { id: 'today', label: 'Today' },
    { id: 'browse', label: 'Browse' },
    { id: 'reported', label: `Reported${stats?.flagged ? ` (${stats.flagged})` : ''}` },
  ]

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Practice</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          A few interview questions a day. Cards you find hard come back sooner; ones you know well wait longer.
        </p>
      </div>
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)', marginBottom: 12 }}>{error}</p>}
      <StatsRow stats={stats} />
      <div role="tablist" aria-label="Practice views" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'today' && (
        <>
          {today && <TopicPicker topics={today.topics} settings={today.settings} onChange={changeSettings} />}
          <TodayView active={active !== false && tab === 'today'} data={today} reload={reloadToday} showToast={showToast} />
        </>
      )}
      {tab === 'browse' && <BrowseView bank={bank} onChanged={afterChange} showToast={showToast} />}
      {tab === 'reported' && <ReportedView bank={bank} onChanged={afterChange} showToast={showToast} />}
    </div>
  )
}
