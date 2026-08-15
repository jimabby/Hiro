import { useState, useEffect, useCallback } from 'react'

// Offer comparison.
//
// Every other page answers "what happened". This one exists for the few days
// where the answer is already yes and the question is which yes — the moment
// the whole pipeline was for, and the one the rest of the app had nothing to
// say about.
//
// The numbers here decide something real, so the page is careful about one
// thing above all: never presenting an advertised range as if it were an offer.

const DECISIONS = [
  { id: 'considering', label: 'Considering' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'declined', label: 'Declined' },
  { id: 'expired', label: 'Expired' },
]

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString()}`)

const blankForm = {
  baseSalary: '', bonus: '', equity: '', currency: '', startDate: '', respondBy: '',
  location: '', remote: '', pros: '', cons: '', notes: '', excitement: '', decision: 'considering',
}

function formFrom(offer) {
  if (!offer) return { ...blankForm }
  return {
    baseSalary: offer.base_salary ?? '', bonus: offer.bonus ?? '', equity: offer.equity || '',
    currency: offer.currency || '', startDate: offer.start_date || '', respondBy: offer.respond_by || '',
    location: offer.location || '', remote: offer.remote || '', pros: offer.pros || '',
    cons: offer.cons || '', notes: offer.notes || '', excitement: offer.excitement ?? '',
    decision: offer.decision || 'considering',
  }
}

// How urgent the deadline is. Colour is doing real work here — an offer with two
// days left and one with three weeks left should not look the same.
function deadlineTone(days, expired) {
  if (expired) return 'var(--red)'
  if (days == null) return 'var(--text-muted)'
  if (days <= 2) return 'var(--red)'
  if (days <= 7) return 'var(--yellow)'
  return 'var(--text-muted)'
}

function deadlineText(offer) {
  if (!offer.respond_by) return 'No deadline set'
  if (offer.expired) return `Deadline passed ${Math.abs(offer.daysToRespond)} day${Math.abs(offer.daysToRespond) === 1 ? '' : 's'} ago`
  if (offer.daysToRespond === 0) return 'Respond today'
  return `${offer.daysToRespond} day${offer.daysToRespond === 1 ? '' : 's'} to respond`
}

// Where an offer sits against what comparable roles were advertised at.
//
// The rest of this page says what an offer IS. This is the only thing here that
// speaks to whether it is any good — which is the question everyone actually has
// while holding one, and the one the app previously had no answer to despite
// having the entire advertised-pay history sitting in its own database.
//
// Two things it refuses to do. It never calls this "market rate": these are
// advertised ranges, which skew high and are not what anyone was paid. And below
// a handful of comparable listings it shows the figures but withholds the
// percentile, because a "75th percentile" drawn from three adverts is a sentence
// about three adverts.
function Benchmark({ jobTitle, value }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!jobTitle || !Number.isFinite(Number(value))) { setData(null); return undefined }
    window.api.getSalaryBenchmark?.(jobTitle, Number(value))
      .then(b => { if (!cancelled) setData(b || null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [jobTitle, value])

  if (!data?.sample) return null

  const pct = data.percentile
  const tone = pct == null || !data.comparable ? 'var(--text-muted)'
    : pct >= 75 ? 'var(--green)' : pct <= 25 ? 'var(--yellow)' : 'var(--text)'

  return (
    <div style={{
      marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)' }}>
          Comparable ads: {money(data.p25)} – {money(data.p75)} (median {money(data.median)})
        </span>
        <span style={{ color: tone, fontWeight: data.comparable ? 600 : 400 }}>
          {data.comparable && pct != null
            ? `This offer sits around the ${pct}th percentile`
            : `Only ${data.sample} comparable ad${data.sample === 1 ? '' : 's'} — too few to place it`}
        </span>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 4 }}>
        From {data.sample} advertised range{data.sample === 1 ? '' : 's'} in your own scan history matching
        “{data.tokens.join(' ')}”. These are what employers advertised, not what they paid.
      </div>
    </div>
  )
}

function OfferForm({ form, setForm, onSave, onCancel, saving }) {
  const field = (key, props = {}) => (
    <input
      className="input"
      value={form[key]}
      onChange={e => setForm({ ...form, [key]: e.target.value })}
      {...props}
    />
  )

  return (
    <div style={{ padding: 14, background: 'var(--bg)', borderRadius: 8, marginTop: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Base salary{field('baseSalary', { type: 'number', min: 0, placeholder: '150000' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Bonus{field('bonus', { type: 'number', min: 0, placeholder: '20000' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Equity{field('equity', { placeholder: '0.1% / 500 RSUs' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Respond by{field('respondBy', { type: 'date' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Start date{field('startDate', { type: 'date' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Location{field('location', { placeholder: 'Sydney' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Remote{field('remote', { placeholder: 'Hybrid 3 days' })}</label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Excitement (0–5)
          {field('excitement', { type: 'number', min: 0, max: 5, placeholder: '4' })}
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          What is good about it
          <textarea className="input" style={{ minHeight: 60 }} value={form.pros}
            onChange={e => setForm({ ...form, pros: e.target.value })} placeholder="Team, scope, learning…" />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          What is not
          <textarea className="input" style={{ minHeight: 60 }} value={form.cons}
            onChange={e => setForm({ ...form, cons: e.target.value })} placeholder="Commute, on-call…" />
        </label>
      </div>
      <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Notes
        <textarea className="input" style={{ minHeight: 50 }} value={form.notes}
          onChange={e => setForm({ ...form, notes: e.target.value })} />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <select className="input" style={{ width: 150 }} value={form.decision}
          onChange={e => setForm({ ...form, decision: e.target.value })}>
          {DECISIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <button className="btn btn-primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function Offers({ active, showToast, onOpenApplication }) {
  const [data, setData] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [editing, setEditing] = useState(null) // applicationId
  const [form, setForm] = useState(blankForm)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState('')

  const load = useCallback(async () => {
    const [offers, apps] = await Promise.all([
      window.api.getOffers?.() ?? Promise.resolve({ offers: [] }),
      window.api.getApplications?.({}) ?? Promise.resolve([]),
    ])
    setData(offers)
    // Applications that reached offer or interview but have no offer row yet —
    // the only ones worth offering to add, so the picker is short and relevant.
    const have = new Set((offers.offers || []).map(o => o.applicationId))
    setCandidates((apps || [])
      .filter(a => (a.status === 'offer' || a.status === 'interview') && !have.has(a.id)))
  }, [])

  useEffect(() => { if (active !== false) load().catch(() => {}) }, [active, load])

  async function save(applicationId) {
    setSaving(true)
    try {
      const result = await window.api.saveOffer?.(applicationId, form)
      if (result?.success === false) {
        showToast?.(result.reason || 'Could not save that offer', 'error')
        return
      }
      setEditing(null)
      setAdding('')
      await load()
      showToast?.('Offer saved')
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const offers = data.offers || []
  const live = offers.filter(o => o.decision === 'considering')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 0 }}>Offers</h1>
        {candidates.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="input" style={{ width: 260 }} value={adding} onChange={e => {
              setAdding(e.target.value)
              setForm({ ...blankForm })
              setEditing(null)
            }}>
              <option value="">Record an offer…</option>
              {candidates.map(a => (
                <option key={a.id} value={a.id}>{a.job_title} — {a.company}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
        What is on the table, side by side, with the deadline that expires first at the top.
      </p>

      {adding && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {candidates.find(c => String(c.id) === String(adding))?.job_title} — {candidates.find(c => String(c.id) === String(adding))?.company}
          </div>
          <OfferForm form={form} setForm={setForm} saving={saving}
            onSave={() => save(Number(adding))} onCancel={() => setAdding('')} />
        </div>
      )}

      {offers.length === 0 && !adding && (
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>No offers recorded yet</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {candidates.length > 0
              ? 'When one arrives, record it above and compare it against anything else on the table.'
              : 'Applications that reach interview or offer stage can be recorded here and compared side by side.'}
          </div>
        </div>
      )}

      {/* The summary only means anything with a real decision to make. */}
      {live.length >= 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 20 }}>
          <div className="card">
            <div style={{ fontSize: 22, fontWeight: 700 }}>{data.live}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>open decision{data.live === 1 ? '' : 's'}</div>
          </div>
          <div className="card">
            <div style={{ fontSize: 22, fontWeight: 700 }}>{money(data.best)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>best on the table</div>
          </div>
          {data.spread != null && (
            <div className="card">
              <div style={{ fontSize: 22, fontWeight: 700 }}>{money(data.spread)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>between highest and lowest</div>
            </div>
          )}
          {data.nextDeadline && (
            <div className="card">
              <div style={{ fontSize: 15, fontWeight: 700, color: deadlineTone(data.nextDeadline.daysToRespond, data.nextDeadline.expired) }}>
                {deadlineText(data.nextDeadline)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{data.nextDeadline.company}</div>
            </div>
          )}
        </div>
      )}

      {offers.map(o => (
        <div key={o.applicationId} className="card" style={{
          marginBottom: 12,
          opacity: o.decision === 'considering' ? 1 : 0.7,
          borderLeft: `3px solid ${o.decision === 'accepted' ? 'var(--green)' : o.decision === 'declined' ? 'var(--text-muted)' : deadlineTone(o.daysToRespond, o.expired)}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{o.job_title}</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {o.company}
                {o.location && ` · ${o.location}`}
                {o.remote && ` · ${o.remote}`}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{money(o.comparableComp)}</div>
              <div style={{ fontSize: 10, color: o.compIsAdvertised ? 'var(--yellow)' : 'var(--text-muted)' }}>
                {/* Never let an advert masquerade as an offer. */}
                {o.compIsAdvertised
                  ? 'advertised range — no offer figure entered'
                  : o.bonus
                    ? `${money(o.base_salary)} base + ${money(o.bonus)} bonus`
                    : 'base salary'}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{ color: deadlineTone(o.daysToRespond, o.expired), fontWeight: o.expired || (o.daysToRespond != null && o.daysToRespond <= 2) ? 600 : 400 }}>
              {deadlineText(o)}
            </span>
            {o.start_date && <span style={{ color: 'var(--text-muted)' }}>Starts {o.start_date}</span>}
            {o.equity && <span style={{ color: 'var(--text-muted)' }}>Equity: {o.equity}</span>}
            {o.excitement != null && (
              <span style={{ color: 'var(--text-muted)' }}>
                Excitement {'●'.repeat(o.excitement)}{'○'.repeat(5 - o.excitement)}
              </span>
            )}
            {o.decision !== 'considering' && (
              <span style={{ color: 'var(--text-muted)', textTransform: 'capitalize', fontWeight: 600 }}>{o.decision}</span>
            )}
          </div>

          {(o.pros || o.cons) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
              {o.pros && (
                <div style={{ fontSize: 12 }}>
                  <div style={{ color: 'var(--green)', fontWeight: 600, marginBottom: 2 }}>For</div>
                  <div style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{o.pros}</div>
                </div>
              )}
              {o.cons && (
                <div style={{ fontSize: 12 }}>
                  <div style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 2 }}>Against</div>
                  <div style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{o.cons}</div>
                </div>
              )}
            </div>
          )}

          {o.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, whiteSpace: 'pre-wrap' }}>{o.notes}</div>}

          {/* Only for a figure the user actually entered. Benchmarking an
              advertised range against other advertised ranges would compare a
              number to the population it came from and call it a finding. */}
          {!o.compIsAdvertised && o.comparableComp != null && (
            <Benchmark jobTitle={o.job_title} value={o.comparableComp} />
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => {
              setEditing(editing === o.applicationId ? null : o.applicationId)
              setForm(formFrom(o))
              setAdding('')
            }}>{editing === o.applicationId ? 'Close' : 'Edit'}</button>
            {onOpenApplication && (
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => onOpenApplication(o.applicationId)}>
                Open application
              </button>
            )}
            <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={async () => {
              await window.api.deleteOffer?.(o.applicationId)
              await load()
              // Deliberate wording: the offer record goes, the application stays.
              showToast?.('Offer removed — the application is untouched')
            }}>Remove</button>
          </div>

          {editing === o.applicationId && (
            <OfferForm form={form} setForm={setForm} saving={saving}
              onSave={() => save(o.applicationId)} onCancel={() => setEditing(null)} />
          )}
        </div>
      ))}
    </div>
  )
}
