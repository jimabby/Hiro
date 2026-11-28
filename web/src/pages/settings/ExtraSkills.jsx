// Skills the user really has that no résumé lists (config.extraSkills), ticked
// rather than typed. The list is services/skillCatalog.js: the skills the
// skills-gap report counts in job ads, plus tools, licences and spoken
// languages that ads ask for. Skills a résumé already names are left out, and
// the ones recent ads ask for come first. Tailoring may add a ticked skill to a
// skills line or the summary, a cover letter or screening answer may mention
// it, and the fabrication guard accepts it there. It is never put into a job's
// bullets, because ticking a skill does not say where it was used.

import { useEffect, useMemo, useState } from 'react'

const ROW = { display: 'flex', flexWrap: 'wrap', gap: 6 }
const GROUP_TITLE = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', margin: '0 0 6px' }

export function ExtraSkills({ form, set }) {
  const [choices, setChoices] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (typeof window.api?.getSkillChoices !== 'function') return
    let live = true
    Promise.resolve(window.api.getSkillChoices())
      .then(res => { if (live) setChoices(res) })
      .catch(err => { if (live) setError(err.message) })
    return () => { live = false }
  }, [])

  const ticked = useMemo(() => new Set(Array.isArray(form.extraSkills) ? form.extraSkills : []), [form.extraSkills])
  if (typeof window.api?.getSkillChoices !== 'function') return null

  const toggle = (name) => set('extraSkills', ticked.has(name) ? [...ticked].filter(n => n !== name) : [...ticked, name])
  const q = query.trim().toLowerCase()
  // A skill a résumé names needs no tick. One ticked anyway stays, so it can be unticked.
  const offered = (s) => (!s.onResume || ticked.has(s.name)) && (!q || s.name.toLowerCase().includes(q))
  const all = (choices?.groups || []).flatMap(g => g.skills)
  const groups = (choices?.groups || []).map(g => ({ ...g, skills: g.skills.filter(offered) })).filter(g => g.skills.length)
  const asked = all.filter(s => s.ads > 0 && offered(s))
    .sort((a, b) => b.ads - a.ads || a.name.localeCompare(b.name)).slice(0, 20)
  const onResume = all.filter(s => s.onResume).length

  const chip = (s) => (
    <button key={s.name} type="button" className={`chip${ticked.has(s.name) ? ' chip-on' : ''}`}
      aria-pressed={ticked.has(s.name)} onClick={() => toggle(s.name)}
      title={s.ads ? `Asked for in ${s.ads} recent job ad${s.ads === 1 ? '' : 's'}` : undefined}>
      {s.name}
      {s.ads > 0 && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>{s.ads}</span>}
    </button>
  )

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 4, fontSize: 15 }}>
        Other Skills You Have{' '}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 13 }}>({ticked.size} ticked)</span>
      </h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Tick only what you can really do that your résumé doesn&apos;t list. When a job asks for one, tailoring
        may add it to a skills line or your summary, and cover letters may mention it. It is never added to a
        job&apos;s bullets, because ticking a skill doesn&apos;t say where you used it.
      </p>
      <input type="search" aria-label="Filter skills" placeholder="Filter skills"
        value={query} onChange={e => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{error}</p>}
      {!choices && !error && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading skills…</p>}
      {asked.length > 0 && !q && (
        <section style={{ marginBottom: 12 }}>
          <h4 style={GROUP_TITLE}>Asked for in your recent job ads</h4>
          <div style={ROW}>{asked.map(chip)}</div>
        </section>
      )}
      {groups.map(g => (
        <section key={g.group} style={{ marginBottom: 10 }}>
          <h4 style={GROUP_TITLE}>{g.group}</h4>
          <div style={ROW}>{g.skills.map(chip)}</div>
        </section>
      ))}
      {choices && q && !groups.length && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No skill in the list matches &ldquo;{query}&rdquo;.</p>
      )}
      {onResume > 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          {onResume} skill{onResume === 1 ? ' is' : 's are'} already on your résumé, so not listed.
        </p>
      )}
    </div>
  )
}
