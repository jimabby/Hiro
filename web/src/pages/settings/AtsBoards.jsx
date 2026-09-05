// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// Company career boards, validated as they are added so a typo in a slug is
// caught here rather than as an empty scan three days later.

import { useState } from 'react'

// Mirrors PROVIDERS in electron/services/scraper/ats.js. The hint is the URL a
// user is actually looking at when they go to copy the slug, so it is written as
// the careers address rather than the API endpoint behind it.
const ATS_PROVIDERS = [
  { id: 'greenhouse', label: 'Greenhouse', hint: 'boards.greenhouse.io/SLUG', placeholder: 'company' },
  { id: 'lever', label: 'Lever', hint: 'jobs.lever.co/SLUG', placeholder: 'company' },
  { id: 'ashby', label: 'Ashby', hint: 'jobs.ashbyhq.com/SLUG', placeholder: 'company' },
  { id: 'workable', label: 'Workable', hint: 'apply.workable.com/SLUG', placeholder: 'company' },
  { id: 'recruitee', label: 'Recruitee', hint: 'SLUG.recruitee.com', placeholder: 'company' },
  { id: 'smartrecruiters', label: 'SmartRecruiters', hint: 'jobs.smartrecruiters.com/SLUG', placeholder: 'company' },
  { id: 'bamboohr', label: 'BambooHR', hint: 'SLUG.bamboohr.com/careers', placeholder: 'company' },
  { id: 'personio', label: 'Personio', hint: 'SLUG.jobs.personio.com', placeholder: 'company' },
  // The one board identified by a URL rather than a name. The data centre in it
  // (wd1, wd3, wd5…) differs per employer and cannot be derived from the company
  // name, so asking for the address is the only thing that can work — and it is
  // what the user already has in front of them.
  {
    id: 'workday',
    label: 'Workday',
    hint: 'the full careers URL, e.g. https://acme.wd3.myworkdayjobs.com/en-US/External',
    placeholder: 'https://acme.wd3.myworkdayjobs.com/en-US/External',
    isUrl: true,
  },
  // The portal half of an iCIMS host is part of the tenant name and is not
  // derivable from the company — careers-acme and jobs-acme are both real — so
  // the hint names the whole host rather than a slug inside a fixed one.
  {
    id: 'icims',
    label: 'iCIMS',
    hint: 'careers-SLUG.icims.com, or paste the full careers URL',
    placeholder: 'careers-acme',
  },
]

// Which mail servers this address resolves to, and what to do when it does not
// resolve to any.
//
// The old behaviour was a hardcoded switch on the domain with Gmail as the
// fallback, which meant three separate wrongs (see services/mailProvider.js):
// a custom domain silently had its credentials sent to smtp.gmail.com and
// reported the refusal as a bad password; Outlook could not work at all because
// Microsoft turned off password sign-in for personal accounts; and the Outlook
// transport carried an SSLv3 cipher list copied from an old README.
//
// This panel exists so all three are visible rather than inferred from a failed
// send that arrives, or does not arrive, twelve hours later.

export function AtsBoards({ form, set, showToast }) {
  const [provider, setProvider] = useState('greenhouse')
  const [slug, setSlug] = useState('')
  const [label, setLabel] = useState('')
  const [testing, setTesting] = useState(false)

  const boards = Array.isArray(form.atsBoards) ? form.atsBoards : []
  const active = ATS_PROVIDERS.find(p => p.id === provider)

  async function addBoard() {
    const cleanSlug = slug.trim()
    if (!cleanSlug) return
    if (boards.some(b => b.provider === provider && b.slug.toLowerCase() === cleanSlug.toLowerCase())) {
      showToast?.('That board is already in the list', 'error')
      return
    }
    // Validate before saving — a typo caught here beats an empty scan three
    // days from now that looks like a quiet job market.
    setTesting(true)
    try {
      const res = await window.api.testAtsBoard(provider, cleanSlug)
      if (!res?.success) {
        showToast?.(`Could not read that board: ${res?.error || 'unknown error'}`, 'error')
        return
      }
      set('atsBoards', [...boards, {
        id: Date.now().toString(36),
        provider,
        slug: cleanSlug,
        label: label.trim() || cleanSlug,
      }])
      setSlug('')
      setLabel('')
      showToast?.(`Added — ${res.count} open role${res.count === 1 ? '' : 's'} on that board right now`, 'success')
    } catch (err) {
      showToast?.(`Could not read that board: ${err.message}`, 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Company Career Boards</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Watch specific employers directly on Greenhouse, Lever, Ashby, Workable, Recruitee,
        SmartRecruiters, Workday, BambooHR or Personio. These have no bot defenses and don't change
        shape, so they're more reliable than the job aggregators. They can't be auto-submitted —
        matches land in Needs Attention with your tailored resume and cover letter ready to paste.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={!!form.enableAtsBoards}
          onChange={e => set('enableAtsBoards', e.target.checked)}
        />
        <span>Include career boards in scans</span>
      </label>

      {boards.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {boards.map(b => (
            <div key={b.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 6,
            }}>
              <div style={{ fontSize: 13 }}>
                {b.label}
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {' '}· {ATS_PROVIDERS.find(p => p.id === b.provider)?.label || b.provider} / {b.slug}
                </span>
              </div>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => set('atsBoards', boards.filter(x => x.id !== b.id))}
              >Remove</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
          <label htmlFor="set-f0">Provider</label>
          <select id="set-f0" value={provider} onChange={e => setProvider(e.target.value)}>
            {ATS_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: active?.isUrl ? 280 : 150 }}>
          <label htmlFor="ats-slug">{active?.isUrl ? 'Careers URL' : 'Board slug'}</label>
          <input
            id="ats-slug"
            value={slug}
            onChange={e => setSlug(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addBoard() }}
            placeholder={active?.placeholder || 'company'}
            aria-describedby="ats-slug-hint"
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 130 }}>
          <label htmlFor="set-f1">Display name (optional)</label>
          <input id="set-f1" value={label} onChange={e => setLabel(e.target.value)} placeholder="Acme Corp" />
        </div>
        <button className="btn btn-primary" onClick={addBoard} disabled={testing || !slug.trim()}>
          {testing ? 'Checking…' : 'Add board'}
        </button>
      </div>
      <small id="ats-slug-hint" style={{ color: 'var(--text-muted)', display: 'block', marginTop: 8 }}>
        {active?.isUrl
          ? <>Paste {active.hint}. Everything else is read out of it. The board is checked before it&apos;s added.</>
          : <>The slug is the company name in their careers URL — {active?.hint}. The board is checked
            before it&apos;s added.</>}
      </small>

      <div className="form-group" style={{ marginTop: 16, marginBottom: 0, maxWidth: 200 }}>
        <label htmlFor="ats-daily-limit">Daily application limit</label>
        <input
          id="ats-daily-limit"
          type="number" min="1" max="50"
          value={form.dailyLimitAts ?? 10}
          onChange={e => set('dailyLimitAts', Number(e.target.value) || 10)}
        />
      </div>
    </div>
  )
}

// Auto-update. Downloading and installing are both explicit — an update that
// restarted the app mid-scan would abandon a half-submitted application.
