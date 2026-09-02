import { useState, useEffect, useCallback, useRef } from 'react'
import HiroLogo from '../components/HiroLogo'

// How long ago a cached screening answer was last confirmed, in whole days.
//
// SQLite writes 'YYYY-MM-DD HH:MM:SS' in UTC and gives no zone suffix, which
// `new Date()` reads as LOCAL in some runtimes — enough to shift an answer
// across the staleness threshold on either side of the date line. Null when
// there is no usable timestamp, so the caller shows an age rather than "NaN
// days ago".
function answerAgeDays(updatedAt) {
  if (!updatedAt) return null
  const at = new Date(String(updatedAt).includes('T') ? updatedAt : `${String(updatedAt).replace(' ', 'T')}Z`)
  if (Number.isNaN(at.getTime())) return null
  return Math.max(0, Math.floor((Date.now() - at.getTime()) / 86400000))
}

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
function MailServers({ form, set }) {
  const [resolved, setResolved] = useState(null)
  const custom = form.mailProvider === 'custom'

  // Re-resolved as the address is typed, so the answer is on screen before Test
  // Connection is pressed rather than after it fails.
  useEffect(() => {
    let cancelled = false
    window.api.describeMailServers?.({
      gmailAddress: form.gmailAddress,
      mailProvider: form.mailProvider,
      smtpHost: form.smtpHost, smtpPort: form.smtpPort, smtpSecure: form.smtpSecure,
      imapHost: form.imapHost, imapPort: form.imapPort, imapSecure: form.imapSecure,
    }).then(r => { if (!cancelled) setResolved(r || null) }).catch(() => {})
    return () => { cancelled = true }
  }, [form.gmailAddress, form.mailProvider, form.smtpHost, form.smtpPort, form.smtpSecure,
    form.imapHost, form.imapPort, form.imapSecure])

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="form-group" style={{ maxWidth: 280 }}>
        <label htmlFor="mail-provider">Mail servers</label>
        <select
          id="mail-provider"
          value={form.mailProvider || 'auto'}
          onChange={e => set('mailProvider', e.target.value)}
        >
          <option value="auto">Detect from my email address</option>
          <option value="custom">Custom mail server</option>
        </select>
      </div>

      {custom && (
        <div style={{ padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 12 }}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="smtp-host">SMTP host <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(sending)</span></label>
              <input id="smtp-host" value={form.smtpHost || ''} onChange={e => set('smtpHost', e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div className="form-group" style={{ maxWidth: 110 }}>
              <label htmlFor="smtp-port">Port</label>
              <input id="smtp-port" type="number" value={form.smtpPort ?? 465} onChange={e => set('smtpPort', Number(e.target.value) || 465)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="imap-host">IMAP host <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(reading replies)</span></label>
              <input id="imap-host" value={form.imapHost || ''} onChange={e => set('imapHost', e.target.value)} placeholder="imap.example.com" />
            </div>
            <div className="form-group" style={{ maxWidth: 110 }}>
              <label htmlFor="imap-port">Port</label>
              <input id="imap-port" type="number" value={form.imapPort ?? 993} onChange={e => set('imapPort', Number(e.target.value) || 993)} />
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="smtp-user">Login name <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(only if it differs from the address)</span></label>
            <input id="smtp-user" value={form.smtpUser || ''} onChange={e => set('smtpUser', e.target.value)} placeholder="Leave blank to use the address above" />
          </div>
          <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 8 }}>
            Ports 465 and 993 use TLS directly; anything else is treated as STARTTLS. Both hosts are
            required — an account Hiro can send from but not read leaves recruiter replies undetected,
            which looks like nobody has written back.
          </small>
        </div>
      )}

      {/* What the address actually resolves to, including the reason when it
          resolves to nothing. This is the part that used to be invisible. */}
      {resolved && (
        <div
          role="status"
          style={{
            fontSize: 12, padding: '9px 12px', borderRadius: 6, lineHeight: 1.55,
            background: 'var(--surface2)',
            borderLeft: `3px solid ${resolved.ok ? 'var(--green)' : 'var(--yellow)'}`,
            color: resolved.ok ? 'var(--text-muted)' : 'var(--text)',
          }}
        >
          {resolved.ok ? (
            <>
              <strong>{resolved.providerName}</strong> — sending via {resolved.smtp.host}:{resolved.smtp.port},
              reading via {resolved.imap.host}:{resolved.imap.port}.
              {resolved.passwordHelp ? <> {resolved.passwordHelp}</> : null}
            </>
          ) : resolved.error}
        </div>
      )}
    </div>
  )
}

// Will an applicant tracking system be able to READ this resume?
//
// Keyword Gap already answers "does this resume say the right things". This is
// the question underneath it, which nothing here asked before: does the document
// survive being parsed at all.
//
// The failure it catches is silent by construction. A two-column layout, or a
// contact block in a Word header, or a resume built from a table, looks
// immaculate on screen and reads perfectly to a human — and comes out of an ATS
// parser as interleaved nonsense, or with no phone number, or as three
// characters of text. The application is rejected by a machine before a person
// sees it, and no feedback ever comes back. Somebody can send two hundred
// applications into that.
//
// Advisory throughout: it never blocks anything and never edits a document.
// "Your columns may not parse" is a judgement about someone else's parser, and
// being wrong about it must not cost a real application.
function ParseCheck({ resume }) {
  const [result, setResult] = useState(null)
  const [checking, setChecking] = useState(false)
  const [showExtract, setShowExtract] = useState(false)

  async function run() {
    setChecking(true)
    try {
      const res = await window.api.checkResumeParseable?.(resume.originalPath || null, resume.originalExt || null)
      setResult(res || null)
    } finally {
      setChecking(false)
    }
  }

  const tone = (severity) => (severity === 'error' ? 'var(--red)' : 'var(--yellow)')

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={checking} onClick={run}>
        {checking ? 'Checking…' : result ? 'Check again' : 'Check ATS readability'}
      </button>

      {result && !result.ok && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.55 }}>
          {result.reason}
        </div>
      )}

      {result?.ok && (
        <div style={{ marginTop: 8 }}>
          {result.findings.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--green)' }}>
              ✓ Parses cleanly — {result.extractedChars.toLocaleString()} characters extracted, contact
              details found.
            </div>
          ) : (
            result.findings.map(f => (
              <div key={f.id} style={{
                padding: '9px 12px', borderRadius: 6, marginBottom: 6,
                background: 'var(--surface2)', borderLeft: `3px solid ${tone(f.severity)}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  <span style={{ color: tone(f.severity) }}>
                    {f.severity === 'error' ? 'Problem' : 'Worth checking'}
                  </span>{' — '}{f.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.55 }}>
                  {f.detail}
                </div>
                <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.55 }}>{f.fix}</div>
              </div>
            ))
          )}

          {/* The advisory findings are judgements; this is the evidence. If the
              extracted text reads out of order here, an ATS sees the same thing. */}
          <button
            className="btn btn-ghost" style={{ fontSize: 11 }}
            aria-expanded={showExtract}
            onClick={() => setShowExtract(v => !v)}
          >
            {showExtract ? 'Hide what a parser sees' : 'Show what a parser sees'}
          </button>
          {showExtract && (
            <pre style={{
              fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--surface2)',
              padding: '10px 12px', borderRadius: 6, marginTop: 6, maxHeight: 260, overflow: 'auto',
            }}>{result.extract || '(nothing)'}</pre>
          )}
        </div>
      )}
    </div>
  )
}

// The handful of facts every application form asks for.
//
// These used to go through the full screening-answer path — a model call, a
// fabrication check against the resume, and a fallback to interrupting the user
// — which is the wrong machinery three times over. "Do you have the right to
// work in Australia?" is not inferable from a resume: the model either guessed
// or said it was unsure, and the user was interrupted for a fact that never
// changes, on every application, forever.
//
// Filled in here, these bypass the model entirely and are treated exactly as a
// user-typed answer is treated everywhere else — never second-guessed, never
// fabrication-checked — because that is what they are. See
// services/applicationProfile.js.
function ApplicationProfile({ form, set }) {
  const [fields, setFields] = useState([])
  const profile = (form.applicationProfile && typeof form.applicationProfile === 'object')
    ? form.applicationProfile
    : {}

  useEffect(() => {
    // The field list comes from the service so this form cannot drift from what
    // the matcher actually recognises.
    window.api.getProfileFields?.().then(f => setFields(f || [])).catch(() => {})
  }, [])

  const filled = fields.filter(f => String(profile[f.id] || '').trim()).length

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Application Profile</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.55 }}>
        The questions nearly every application form asks. Anything filled in here is typed straight
        into the form as you wrote it — no model call, no guess, and no interruption mid-scan. Leave a
        field blank and that question falls back to the usual path.
        {fields.length > 0 && (
          <> <strong>{filled} of {fields.length} filled in.</strong></>
        )}
      </p>

      {fields.map(field => (
        <div className="form-group" key={field.id}>
          <label htmlFor={`profile-${field.id}`}>{field.label}</label>
          <input
            id={`profile-${field.id}`}
            value={profile[field.id] || ''}
            placeholder={field.help}
            onChange={e => set('applicationProfile', { ...profile, [field.id]: e.target.value })}
          />
        </div>
      ))}

      {fields.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
      )}
    </div>
  )
}

// Where the scrapers' traffic goes out.
//
// automationHealth can already tell when a platform has started refusing us, and
// it responds the only way it could — by backing off and waiting. That is the
// right default and it was the entire toolkit: there was no lever for "route
// this somewhere else". For anyone on a connection a job board has decided it
// does not like, or on a corporate network whose only route out is a proxy,
// Hiro simply did not work and there was nothing to configure.
function ProxySettings({ form, set }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Network &amp; Proxy</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.55 }}>
        Route every browser Hiro launches through a proxy. Needed on a corporate network whose only
        way out is one, and useful when a job board has started refusing your connection — automation
        health can detect that and back off, but backing off is all it can do on its own.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={!!form.proxyEnabled}
          onChange={e => set('proxyEnabled', e.target.checked)}
        />
        <span>Send scraper traffic through a proxy</span>
      </label>

      {form.proxyEnabled && (
        <>
          <div className="form-group">
            <label htmlFor="proxy-server">Proxy address</label>
            <input
              id="proxy-server"
              value={form.proxyServer || ''}
              onChange={e => set('proxyServer', e.target.value)}
              placeholder="http://proxy.example.com:8080 or socks5://127.0.0.1:1080"
              aria-describedby="proxy-server-hint"
            />
            <small id="proxy-server-hint" style={{ color: 'var(--text-muted)' }}>
              Include the scheme and the port. http, https and socks5 are all accepted.
            </small>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="proxy-user">Username <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(optional)</span></label>
              <input id="proxy-user" value={form.proxyUsername || ''} onChange={e => set('proxyUsername', e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="proxy-pass">Password <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(optional)</span></label>
              <input id="proxy-pass" type="password" value={form.proxyPassword || ''} onChange={e => set('proxyPassword', e.target.value)} />
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="proxy-bypass">Bypass list <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(optional)</span></label>
            <input
              id="proxy-bypass"
              value={form.proxyBypass || ''}
              onChange={e => set('proxyBypass', e.target.value)}
              placeholder="localhost, 127.0.0.1, *.internal"
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Hosts to reach directly. The proxy password is stored encrypted in your OS keychain,
              like every other secret here, and is only ever sent to the proxy — never to a job board.
            </small>
          </div>
        </>
      )}
    </div>
  )
}

// Your own answers to interview questions, kept once and reused.
//
// Interview Questions generated questions and had nowhere to put the answers, so
// a STAR story worked out for one panel was worked out again from scratch for
// the next. Entries are keyed on a normalised form of the question, so the same
// question asked with different punctuation is one entry.
function AnswerBank({ showToast }) {
  const [answers, setAnswers] = useState([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    window.api.listInterviewAnswers?.(search).then(rows => setAnswers(rows || [])).catch(() => {})
  }, [search])

  useEffect(() => { load() }, [load])

  async function polish(entry) {
    setBusy(true)
    try {
      const res = await window.api.draftInterviewAnswer?.({
        question: entry.question,
        existingAnswer: draft,
      })
      if (res?.success) setDraft(res.draft)
      else showToast?.(res?.error || 'Could not draft an answer', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function save(entry) {
    // Saved as the user's own, whatever produced the text: they read it and
    // pressed save, which is the whole difference between a draft and an answer.
    await window.api.saveInterviewAnswer?.({ question: entry.question, answer: draft, source: 'user' })
    setEditing(null)
    setDraft('')
    load()
    showToast?.('Answer saved', 'success')
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Interview Answer Bank</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.55 }}>
        Answers you have worked out once, kept for the next time the question comes up. Saved from the
        Interview Questions panel on any application; the same question asked with different wording
        finds the same entry.
      </p>

      <div className="form-group" style={{ maxWidth: 320 }}>
        <label htmlFor="answer-search">Search</label>
        <input
          id="answer-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Question or answer text"
        />
      </div>

      {answers.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {search ? 'Nothing matches that.' : 'No answers saved yet.'}
        </div>
      )}

      {answers.map(entry => (
        <div key={entry.id} style={{
          padding: '10px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{entry.question}</div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                className="btn btn-ghost" style={{ fontSize: 12 }}
                onClick={() => { setEditing(entry.id); setDraft(entry.answer || '') }}
              >Edit</button>
              <button
                className="btn btn-ghost" style={{ fontSize: 12 }}
                onClick={async () => {
                  await window.api.deleteInterviewAnswer?.(entry.question)
                  load()
                }}
              >Delete</button>
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {/* An unedited AI draft is not yet the user's answer, and saying so
                is the difference between a bank and a pile of generated text. */}
            {entry.source === 'ai' ? 'AI draft — not yet reviewed' : 'Your answer'}
            {entry.times_used > 0 && ` · used ${entry.times_used} time${entry.times_used === 1 ? '' : 's'}`}
          </div>

          {editing === entry.id ? (
            <div style={{ marginTop: 8 }}>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={5}
                style={{ width: '100%', fontSize: 13 }}
                aria-label={`Answer to: ${entry.question}`}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => save(entry)}>Save</button>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={() => polish(entry)}>
                  {busy ? 'Working…' : 'Tighten with AI'}
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setEditing(null); setDraft('') }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
              {entry.answer || <span style={{ color: 'var(--text-muted)' }}>No answer yet.</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// Company career boards. These serve structured JSON with no login and no bot
// defenses, which makes them far steadier than scraping the aggregators — but
// their application forms are custom per company, so matches are routed to
// Needs Attention with the documents already drafted rather than submitted.
function AtsBoards({ form, set, showToast }) {
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
function UpdatePanel({ form, set, showToast }) {
  const [status, setStatus] = useState(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.getUpdateStatus?.().then(setStatus).catch(() => {})
    const off = window.api.onUpdateStatus?.(setStatus)
    return () => off?.()
  }, [])

  async function check() {
    setChecking(true)
    try {
      const res = await window.api.checkForUpdate()
      setStatus(res)
      if (res?.error) showToast?.(res.error, 'error')
      else if (!res?.updateAvailable) showToast?.('You are on the latest version', 'success')
    } catch (err) {
      showToast?.(`Update check failed: ${err.message}`, 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 6, fontSize: 15 }}>Updates</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Hiro checks for a new version daily. Nothing downloads or installs without you asking, and a
        restart is refused while a scan or apply is running.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={form.autoCheckUpdates !== false}
          onChange={e => set('autoCheckUpdates', e.target.checked)}
        />
        <span>Check for updates automatically</span>
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-ghost" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {status?.currentVersion && `Version ${status.currentVersion}`}
          {status?.updateAvailable && ` · ${status.version} available`}
          {status?.downloaded && ' · downloaded, restart to install'}
        </span>
      </div>
      {status?.error && (
        <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{status.error}</div>
      )}
    </div>
  )
}

function IndeedAccountCard() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [logging, setLogging] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.indeedStatus().then(s => setLoggedIn(s.loggedIn))
    const off = window.api.onIndeedStatusUpdate(m => setMsg(m))
    return () => off?.()
  }, [])

  return (
    <div className="card">
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>Indeed Account</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Required for Indeed Easy Apply. Without logging in, applications won't be submitted under your account.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: loggedIn ? 'var(--green)' : 'var(--text-muted)', fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: loggedIn ? 'var(--green)' : 'var(--border)' }} />
          {loggedIn ? 'Logged in' : 'Not logged in'}
        </div>
        {loggedIn ? (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
            await window.api.indeedLogout()
            setLoggedIn(false)
            setMsg('')
          }}>Log Out</button>
        ) : (
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={logging} onClick={async () => {
            setLogging(true)
            setMsg('')
            const res = await window.api.indeedLogin()
            setLogging(false)
            if (res.success) { setLoggedIn(true); setMsg('Logged in successfully!') }
            else setMsg(res.error || 'Login failed')
          }}>
            {logging ? 'Waiting for login...' : 'Login to Indeed'}
          </button>
        )}
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: loggedIn ? 'var(--green)' : 'var(--red)' }}>{msg}</div>}
    </div>
  )
}

function SeekAccountCard() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [logging, setLogging] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.seekStatus().then(s => setLoggedIn(s.loggedIn))
    const off = window.api.onSeekStatusUpdate(m => setMsg(m))
    return () => off?.()
  }, [])

  return (
    <div className="card">
      <h3 style={{ marginBottom: 8, fontSize: 15 }}>Seek Account</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        Required for Seek applications. Without logging in, submitted applications won't be recorded and you won't receive confirmation emails.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: loggedIn ? 'var(--green)' : 'var(--text-muted)', fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: loggedIn ? 'var(--green)' : 'var(--border)' }} />
          {loggedIn ? 'Logged in' : 'Not logged in'}
        </div>
        {loggedIn ? (
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
            await window.api.seekLogout()
            setLoggedIn(false)
            setMsg('')
          }}>Log Out</button>
        ) : (
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={logging} onClick={async () => {
            setLogging(true)
            setMsg('')
            const res = await window.api.seekLogin()
            setLogging(false)
            if (res.success) { setLoggedIn(true); setMsg('Logged in successfully!') }
            else setMsg(res.error || 'Login failed')
          }}>
            {logging ? 'Waiting for login...' : 'Login to Seek'}
          </button>
        )}
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: loggedIn ? 'var(--green)' : 'var(--red)' }}>{msg}</div>}
    </div>
  )
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function BackupsCard({ showToast }) {
  const [backups, setBackups] = useState([])
  const [drill, setDrill] = useState(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const [items, status] = await Promise.all([window.api.listBackups(), window.api.getBackupDrillStatus()])
      setBackups(items || []); setDrill(status)
    } catch { setBackups([]) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>Backups</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            The database is backed up automatically once a day (last 7 kept) in ~/.hiro/backups.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const res = await window.api.drillBackups()
              await load()
              showToast?.(res.success ? `Recovery drill passed for ${res.checked} backup(s)` : (res.error || `${res.failed} backup(s) failed`), res.success ? 'success' : 'error')
            } finally { setBusy(false) }
          }}>Test Recovery</button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const res = await window.api.backupNow()
              if (res.success) { showToast?.('Backup created', 'success'); await load() }
              else showToast?.(res.error || 'Backup failed', 'error')
            } finally { setBusy(false) }
          }}>{busy ? 'Working…' : 'Back Up Now'}</button>
        </div>
      </div>
      {drill && <p style={{ color: drill.success ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
        Last recovery drill: {new Date(drill.checkedAt).toLocaleString()} · {drill.checked} checked · {drill.failed} failed
      </p>}
      {backups.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No backups yet — one is created automatically each day the app runs.</p>}
      {backups.map(b => (
        <div key={b.name} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '8px 12px', background: 'var(--surface2)', borderRadius: 8, marginBottom: 6,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(b.mtime).toLocaleString()} · {formatBytes(b.size)}</div>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
            if (!window.confirm(`Restore ${b.name}? Your current data will be replaced (a pre-restore snapshot is kept in the backups folder).`)) return
            setBusy(true)
            try {
              const res = await window.api.restoreBackup(b.name)
              if (res.success) {
                showToast?.('Backup restored — reloading', 'success')
                setTimeout(() => window.location.reload(), 800)
              } else {
                showToast?.(res.error || 'Restore failed', 'error')
              }
            } finally { setBusy(false) }
          }}>Restore</button>
        </div>
      ))}
    </div>
  )
}

// Encrypted export/import of settings — resumes, criteria, blacklists, rules.
// The database backups above cover applications; this covers everything else,
// which otherwise had to be re-entered by hand on a new machine.
// The whole job search as portable data.
//
// Deliberately separate from Settings Transfer above it and from the database
// backups: those cover the other two thirds of the problem and neither covers
// this one. A backup is the SQLite file, which on an encrypted profile cannot be
// opened without this machine's keychain entry — right for a backup, and exactly
// wrong for the case where the keychain is what was lost.
function DataTransferCard({ showToast, onImported }) {
  const [mode, setMode] = useState(null) // 'export' | 'import'
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState(null)
  const [preview, setPreview] = useState(null)

  function reset() { setMode(null); setPassphrase(''); setStaged(null) }

  async function openExport() {
    setMode('export')
    // Say what is about to be written before it is written.
    try {
      const res = await window.api.exportDataPreview?.()
      if (res?.success) setPreview(res.counts)
    } catch { /* the summary is a courtesy, not a precondition */ }
  }

  async function doExport() {
    setBusy(true)
    try {
      const res = await window.api.exportData(passphrase)
      if (res.canceled) return
      if (res.success) {
        showToast?.(res.encrypted ? 'Data exported (encrypted)' : 'Data exported as plain JSON', 'success')
        reset()
      } else showToast?.(res.error || 'Export failed', 'error')
    } finally { setBusy(false) }
  }

  async function doChoose() {
    setBusy(true)
    try {
      const res = await window.api.chooseDataImport()
      if (res.canceled) return
      if (res.success) setStaged(res)
      else showToast?.(res.error || 'Could not read that file', 'error')
    } finally { setBusy(false) }
  }

  async function doImport() {
    setBusy(true)
    try {
      const res = await window.api.importData(passphrase)
      if (res.success) {
        const added = Object.entries(res.added || {}).filter(([, n]) => n > 0)
        showToast?.(res.total > 0
          ? `Imported ${added.map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ')}`
          : 'Nothing new — everything in that file is already here', 'success')
        reset()
        onImported?.()
      } else showToast?.(res.reason || res.error || 'Import failed', 'error')
    } finally { setBusy(false) }
  }

  const summarise = (counts) => Object.entries(counts || {})
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${n} ${table.replace(/_/g, ' ')}`)
    .join(' · ')

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>Data Export</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            Every application with the résumé and cover letter that went out, the replies that came
            back, interviews, contacts and notes — as one portable file. Unlike the backups above,
            this does not need this machine&apos;s keychain to read, so it is the copy that survives a
            lost profile. Importing only ever adds; nothing here is deleted or overwritten.
          </p>
        </div>
        {!mode && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={openExport}>Export</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode('import')}>Import</button>
          </div>
        )}
      </div>

      {mode === 'export' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          {preview && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              This will write {summarise(preview) || 'nothing — there is no history yet'}.
            </div>
          )}
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label htmlFor="set-f2" style={{ fontSize: 12 }}>Passphrase (optional)</label>
            <input id="set-f2" type="password" value={passphrase} autoFocus
              onChange={e => setPassphrase(e.target.value)}
              placeholder="Leave blank to write readable JSON" />
            <div style={{ fontSize: 11, color: passphrase ? 'var(--text-muted)' : 'var(--yellow)', marginTop: 4 }}>
              {passphrase
                ? 'Encrypted with this passphrase. There is no recovery if you lose it.'
                : 'Without a passphrase the file is plain JSON — readable by any tool, and by anyone '
                  + 'who finds it. It contains every résumé, cover letter and recruiter address.'}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doExport} disabled={busy}>
              {busy ? 'Exporting…' : 'Choose file and export'}
            </button>
          </div>
        </div>
      )}

      {mode === 'import' && !staged && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doChoose} disabled={busy}>
            {busy ? 'Reading…' : 'Choose a file'}
          </button>
        </div>
      )}

      {mode === 'import' && staged && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 10 }}>
            {staged.exportedAt && (
              <div style={{ color: 'var(--text-muted)' }}>Exported {new Date(staged.exportedAt).toLocaleString()}</div>
            )}
            <div style={{ color: 'var(--text-muted)' }}>Contains {summarise(staged.counts) || 'nothing'}.</div>
            <div style={{ marginTop: 6 }}>
              Anything already here is left exactly as it is — only what is missing gets added.
            </div>
          </div>
          {staged.encrypted && (
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label htmlFor="set-f3" style={{ fontSize: 12 }}>Passphrase</label>
              <input id="set-f3" type="password" value={passphrase} autoFocus
                onChange={e => setPassphrase(e.target.value)}
                placeholder="Passphrase used at export" />
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doImport}
              disabled={busy || (staged.encrypted && !passphrase)}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsTransferCard({ showToast, onImported }) {
  const [mode, setMode] = useState(null) // 'export' | 'import'
  const [passphrase, setPassphrase] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState(null)

  function reset() {
    setMode(null); setPassphrase(''); setIncludeSecrets(false); setStaged(null)
  }

  async function doExport() {
    setBusy(true)
    try {
      const res = await window.api.exportConfig(passphrase, includeSecrets)
      if (res.canceled) return
      if (res.success) { showToast?.('Settings exported', 'success'); reset() }
      else showToast?.(res.error || 'Export failed', 'error')
    } finally { setBusy(false) }
  }

  async function doInspect() {
    setBusy(true)
    try {
      const res = await window.api.inspectConfigImport(passphrase)
      if (res.canceled) return
      if (res.success) setStaged(res)
      else showToast?.(res.error || 'Import failed', 'error')
    } finally { setBusy(false) }
  }

  async function doApply() {
    setBusy(true)
    try {
      const res = await window.api.applyConfigImport()
      if (res.success) {
        showToast?.('Settings imported', 'success')
        reset()
        onImported?.()
      } else showToast?.(res.error || 'Import failed', 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>Settings Transfer</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            Export your resumes, job criteria, blacklist, routing rules, and templates to an
            encrypted file — then restore them on another machine. Applications live in the
            database backups above, not here.
          </p>
        </div>
        {!mode && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode('export')}>Export</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode('import')}>Import</button>
          </div>
        )}
      </div>

      {mode && !staged && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label htmlFor="set-f4" style={{ fontSize: 12 }}>Passphrase</label>
            <input id="set-f4" type="password" value={passphrase} autoFocus
              onChange={e => setPassphrase(e.target.value)}
              placeholder={mode === 'export' ? 'At least 8 characters' : 'Passphrase used at export'} />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              {mode === 'export'
                ? 'The file is encrypted with this passphrase. There is no recovery if you lose it.'
                : 'Enter the passphrase this file was exported with.'}
            </div>
          </div>

          {mode === 'export' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" style={{ width: 'auto' }}
                checked={includeSecrets} onChange={e => setIncludeSecrets(e.target.checked)} />
              Include API key and email app password
            </label>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }}
              disabled={busy || passphrase.length < 8}
              onClick={mode === 'export' ? doExport : doInspect}>
              {busy ? 'Working…' : mode === 'export' ? 'Choose File & Export' : 'Choose File'}
            </button>
          </div>
        </div>
      )}

      {staged && (
        <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Ready to import</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Exported {staged.createdAt ? new Date(staged.createdAt).toLocaleString() : 'at an unknown time'} ·
            {' '}{staged.summary.keys} settings · {staged.summary.resumes} resume{staged.summary.resumes === 1 ? '' : 's'} ·
            {' '}{staged.summary.resumeRules} routing rule{staged.summary.resumeRules === 1 ? '' : 's'} ·
            {' '}{staged.summary.blacklistedCompanies} blacklisted
            {staged.includesSecrets ? ' · includes credentials' : ' · no credentials'}
            <br />
            This replaces your current settings. Applications and history are untouched.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={reset} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={doApply} disabled={busy}>
              {busy ? 'Importing…' : 'Replace My Settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function StorageCard() {
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)

  async function loadInfo() {
    setLoading(true)
    const data = await window.api.getStorageInfo()
    setInfo(data)
    setLoading(false)
  }

  useEffect(() => { loadInfo() }, [])

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>Storage</h3>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={loadInfo} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {info ? (
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>{formatBytes(info.dbSize)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            {[
              { label: 'Applications', count: info.counts.applications },
              { label: 'Attention Jobs', count: info.counts.attentionJobs },
              { label: 'Cached Answers', count: info.counts.cachedAnswers },
              { label: 'Interview Preps', count: info.counts.interviewPreps },
              { label: 'Interviews', count: info.counts.interviewEvents ?? 0 },
            ].map(({ label, count }) => (
              <div key={label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{count}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
            Database size will decrease after clearing history, cache, or attention queue below.
          </p>
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
      )}
    </div>
  )
}

export default function Settings({ showToast, active }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [addingResume, setAddingResume] = useState(false)
  const [cachedAnswers, setCachedAnswers] = useState([])
  const [cachedSearch, setCachedSearch] = useState('')
  // Cached screening answers are submitted to employers for as long as they sit
  // in the cache, and nothing ever aged them out — so the oldest ones, the ones
  // most likely to have drifted, were the ones being reused most.
  const staleAfterDays = Number(form?.screeningAnswerStaleDays ?? 180)
  const staleAnswers = cachedAnswers.filter(ca => {
    if (!(staleAfterDays > 0)) return false
    const age = answerAgeDays(ca.updated_at)
    return age != null && age >= staleAfterDays
  })
  const [newBlacklist, setNewBlacklist] = useState('')
  const [newResumeName, setNewResumeName] = useState('')
  const [newResumeText, setNewResumeText] = useState('')
  const [newResumeOriginalPath, setNewResumeOriginalPath] = useState(null)
  const [newResumeOriginalExt, setNewResumeOriginalExt] = useState(null)
  const [uploadError, setUploadError] = useState('')
  const [clUploadError, setClUploadError] = useState('')
  const [settingsTab, setSettingsTab] = useState('accounts')
  const [pdfModal, setPdfModal] = useState(null) // { url, title }
  const [pdfLoading, setPdfLoading] = useState(false)
  const [improvingId, setImprovingId] = useState(null)
  const [improveModal, setImproveModal] = useState(null) // { sourceId, sourceName, text }
  const [testingAi, setTestingAi] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)
  const [aiResult, setAiResult] = useState(null)
  const [emailResult, setEmailResult] = useState(null)
  const [linkedinLoggedIn, setLinkedinLoggedIn] = useState(false)
  const [linkedinLogging, setLinkedinLogging] = useState(false)
  const [linkedinMsg, setLinkedinMsg] = useState('')
  const [gmailLogging, setGmailLogging] = useState(false)
  const [gmailMsg, setGmailMsg] = useState('')
  const [checkingInbox, setCheckingInbox] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [sweepResult, setSweepResult] = useState(null)
  const [inboxResult, setInboxResult] = useState(null)
  const [mobileInfo, setMobileInfo] = useState(null)
  const [pairingSession, setPairingSession] = useState(null)
  const [pairedDevices, setPairedDevices] = useState(null)
  const [mobileBusy, setMobileBusy] = useState(false)
  const [cloudStatus, setCloudStatus] = useState(null)
  // null = not opened yet; an array = loaded (possibly empty).
  const [syncConflicts, setSyncConflicts] = useState(null)
  const [devices, setDevices] = useState(null)
  const [cloudUrl, setCloudUrl] = useState('')
  const [cloudKey, setCloudKey] = useState('')
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudPassword, setCloudPassword] = useState('')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudMsg, setCloudMsg] = useState('')
  const [pushBusy, setPushBusy] = useState(false)
  // Calendar sync. `calSync` is the live service status; the rest is the connect
  // form, which only exists until a provider is connected.
  const [calSync, setCalSync] = useState(null)
  const [calProvider, setCalProvider] = useState('')
  const [calClientId, setCalClientId] = useState('')
  const [calClientSecret, setCalClientSecret] = useState('')
  const [calCalendars, setCalCalendars] = useState(null)
  const [calBusy, setCalBusy] = useState(false)
  // Encryption at rest. null = not loaded yet.
  const [encryption, setEncryption] = useState(null)
  const [encBusy, setEncBusy] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState(null)
  const [recoveryInput, setRecoveryInput] = useState('')

  // Every page stays mounted for the app's lifetime, so this form is a snapshot
  // that would otherwise go stale: blacklisting a company from the Dashboard,
  // or importing a resume that auto-fills personalLinks, writes config behind
  // our back — and saving the stale form silently reverted it. Refetch whenever
  // Settings becomes visible again.
  useEffect(() => {
    if (active === false) return
    window.api.getConfig().then(cfg => {
      setForm(f => ({
        ...cfg,
        blacklistedCompanies: Array.isArray(cfg.blacklistedCompanies)
          ? cfg.blacklistedCompanies.join(', ')
          : cfg.blacklistedCompanies || '',
        // Preserve fields the user is mid-edit so a tab switch doesn't discard
        // unsaved typing; only unedited values are refreshed from disk.
        ...(dirtyRef.current ? f : {}),
      }))
    })
  }, [active])

  useEffect(() => {
    window.api.linkedinStatus().then(s => setLinkedinLoggedIn(s.loggedIn))
    window.api.getMobileInfo?.().then(setMobileInfo)
    window.api.cloudStatus?.().then(s => {
      setCloudStatus(s)
      if (s?.email) setCloudEmail(s.email)
    })
    window.api.calendarSyncStatus?.().then(s => {
      setCalSync(s)
      if (s?.provider) setCalProvider(s.provider)
    })
    window.api.getEncryptionStatus?.().then(setEncryption)
    window.api.getConfig().then(cfg => {
      setCloudUrl(cfg.supabaseUrl || '')
      setCloudKey(cfg.supabaseAnonKey || '')
    })
    const offLinkedin = window.api.onLinkedInStatusUpdate(msg => setLinkedinMsg(msg))
    const offGmail = window.api.onGmailStatusUpdate(msg => setGmailMsg(msg))
    return () => {
      offLinkedin?.()
      offGmail?.()
    }
  }, [])

  // Tracks whether the form has edits the user hasn't saved yet, so refetching
  // on tab-focus never throws away typing in progress.
  const dirtyRef = useRef(false)
  // The ref alone can't drive the UI. Mirroring it into state lets the header
  // say so: one Save button serves six tabs, and there was previously nothing
  // on screen distinguishing "saved" from "typed but not saved".
  const [dirty, setDirty] = useState(false)

  const set = (key, val) => {
    dirtyRef.current = true
    setDirty(true)
    setForm(f => ({ ...f, [key]: val }))
  }

  async function viewPDF(text, title, originalPath, originalExt) {
    setPdfLoading(title)
    try {
      const res = await window.api.getResumePDFBase64(text, originalPath || null, originalExt || null)
      if (res.success) setPdfModal({ url: res.url, title })
    } finally {
      setPdfLoading(false)
    }
  }

  async function saveResumes(resumes, defaultResumeId) {
    const cfg = await window.api.getConfig()
    await window.api.saveConfig({ ...cfg, resumes, defaultResumeId })
    setForm(f => ({ ...f, resumes, defaultResumeId }))
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    const clamp = (v, min, max, fallback) => { const n = parseInt(v); return isNaN(n) ? fallback : Math.min(max, Math.max(min, n)) }
    await window.api.saveConfig({
      ...form,
      salaryMin: Math.max(0, parseInt(form.salaryMin) || 0),
      matchThreshold: clamp(form.matchThreshold, 0, 100, 80),
      dailyLimitSeek: clamp(form.dailyLimitSeek, 1, 100, 10),
      dailyLimitIndeed: clamp(form.dailyLimitIndeed, 1, 100, 10),
      dailyLimitLinkedIn: clamp(form.dailyLimitLinkedIn, 1, 100, 10),
      blacklistedCompanies: (form.blacklistedCompanies || '').split(',').map(s => s.trim()).filter(Boolean),
      followUpDays: clamp(form.followUpDays, 1, 30, 7),
      // 1 is the original behaviour — one nudge, ever. The ceiling is 5 because
      // past that it stops being a follow-up and starts being a nuisance to a
      // real person's inbox, over the user's name.
      followUpMaxCount: clamp(form.followUpMaxCount, 1, 5, 2),
      // At least a week between rounds. The database accepts 0, but a follow-up
      // the morning after the last one is not a cadence anybody wants and it is
      // the sort of setting that is easy to type by accident.
      followUpIntervalDays: clamp(form.followUpIntervalDays, 7, 90, 14),
      // 0 is meaningful (stop flagging stale answers), so the floor is 0.
      screeningAnswerStaleDays: clamp(form.screeningAnswerStaleDays, 0, 1095, 180),
      companyCooldownDays: clamp(form.companyCooldownDays, 0, 365, 30),
      smartScheduleBatchSize: clamp(form.smartScheduleBatchSize, 1, 20, 3),
      smartScheduleJitter: clamp(form.smartScheduleJitter, 0, 60, 15),
      // MAX_PAGES in the scrapers is 10; anything higher is silently capped
      // there, so clamp here to keep the form honest about what will happen.
      scrapePages: clamp(form.scrapePages, 1, 10, 3),
      // 0 is meaningful (disables the sweep), so the floor is 0, not 1.
      staleAfterDays: clamp(form.staleAfterDays, 0, 365, 45),
      inboxCheckHours: clamp(form.inboxCheckHours, 1, 24, 2),
      // Drop rules whose resume was deleted, or the applicator would silently
      // fall through to the default for a rule the user thinks is active.
      resumeRules: (form.resumeRules || []).filter(r =>
        r?.keywords?.trim() && (form.resumes || []).some(x => x.id === r.resumeId)),
    })
    dirtyRef.current = false // saved state now matches disk — safe to refetch
    setDirty(false)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function testAI() {
    setTestingAi(true); setAiResult(null)
    // A local server names its own model in the same argument slot Gemini uses
    // — see NAMES_OWN_MODEL in services/ai/index.js.
    const model = form.aiProvider === 'local' ? form.localAiModel : form.geminiModel
    const res = await window.api.testAiConnection(form.aiProvider, form.aiApiKey, model)
    setTestingAi(false); setAiResult(res)
  }

  async function testEmail() {
    setTestingEmail(true); setEmailResult(null)
    // The custom-server fields as they stand in the form, so this tests what is
    // on screen rather than what was last saved.
    const res = await window.api.testEmailConnection(form.gmailAddress, form.gmailAppPassword, {
      mailProvider: form.mailProvider,
      smtpHost: form.smtpHost, smtpPort: form.smtpPort, smtpSecure: form.smtpSecure, smtpUser: form.smtpUser,
      imapHost: form.imapHost, imapPort: form.imapPort, imapSecure: form.imapSecure, imapUser: form.imapUser,
    })
    setTestingEmail(false); setEmailResult(res)
  }

  if (!form) return <div style={{ color: 'var(--text-muted)' }}>Loading...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Settings</h1>
        {settingsTab !== 'about' && settingsTab !== 'data' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {saved && <span style={{ color: 'var(--green)', fontSize: 13 }}>✓ Saved</span>}
            {dirty && !saving && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--yellow)' }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: 'var(--yellow)', flexShrink: 0,
                }} />
                Unsaved changes
              </span>
            )}
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      {(() => {
        const TABS = [
          { id: 'accounts', label: 'Accounts & Schedule' },
          { id: 'criteria', label: 'Job, Resume & Cover Letter' },
          { id: 'automation', label: 'Automation & Boards' },
          { id: 'notifications', label: 'Notifications' },
          { id: 'data', label: 'Data Management' },
          { id: 'about', label: 'About' },
        ]
        return (
          <div style={{ display: 'flex', gap: 2, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => setSettingsTab(tab.id)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 18px', fontSize: 14, fontWeight: settingsTab === tab.id ? 600 : 400,
                color: settingsTab === tab.id ? 'var(--text)' : 'var(--text-muted)',
                borderBottom: settingsTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
              }}>
                {tab.label}
              </button>
            ))}
          </div>
        )
      })()}

      {settingsTab === 'accounts' && <div>
      {/* AI */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>AI Provider</h3>
        <div className="form-group">
          <label htmlFor="set-f5">Provider</label>
          <select id="set-f5" value={form.aiProvider} onChange={e => set('aiProvider', e.target.value)}>
            <option value="claude">Claude (Anthropic)</option>
            <option value="chatgpt">ChatGPT (OpenAI)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="gemini">Gemini (Google)</option>
            <option value="local">Local model (Ollama / LM Studio)</option>
          </select>
        </div>
        {form.aiProvider === 'local' ? (
          <div style={{
            fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-subtle)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', marginBottom: 12,
          }}>
            Résumés and job descriptions are sent to this address only. Nothing leaves this
            machine and nothing is billed, so the spend cap and cost meter will read zero.
            Expect weaker tailoring than a frontier model.
          </div>
        ) : (
          <div className="form-group">
            <label htmlFor="set-f6">API Key</label>
            <input id="set-f6" type="password" value={form.aiApiKey} onChange={e => set('aiApiKey', e.target.value)} />
          </div>
        )}
        {form.aiProvider === 'local' && (
          <>
            <div className="form-group">
              <label htmlFor="set-f7">Server address</label>
              <input id="set-f7"
                value={form.localAiBaseUrl || ''}
                onChange={e => set('localAiBaseUrl', e.target.value)}
                placeholder="http://localhost:11434/v1"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Ollama serves this at <code>http://localhost:11434/v1</code>; LM Studio at
                {' '}<code>http://localhost:1234/v1</code>. The endpoint must be OpenAI-compatible.
              </span>
            </div>
            <div className="form-group">
              <label htmlFor="set-f8">Model</label>
              <input id="set-f8"
                value={form.localAiModel || ''}
                onChange={e => set('localAiModel', e.target.value)}
                placeholder="e.g. llama3.1:8b"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Must already be pulled on the server — <code>ollama list</code> shows what is available.
              </span>
            </div>
          </>
        )}
        {form.aiProvider === 'gemini' && (
          <div className="form-group">
            <label htmlFor="set-f9">Gemini Model Name</label>
            <input id="set-f9"
              value={form.geminiModel || ''}
              onChange={e => set('geminiModel', e.target.value)}
              placeholder="e.g. gemini-2.5-flash"
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Find your available models at aistudio.google.com
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* A local server takes no key, so requiring one would leave the only
              button that proves the endpoint works permanently disabled. */}
          <button className="btn btn-ghost" onClick={testAI} disabled={(form.aiProvider !== 'local' && !form.aiApiKey) || testingAi}>
            {testingAi ? 'Testing...' : 'Test Connection'}
          </button>
          {aiResult && (
            <span style={{ color: aiResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
              {aiResult.success ? '✓ Connected' : `✗ ${aiResult.error}`}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
      {/* LinkedIn */}
      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>LinkedIn Account</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Required for LinkedIn Easy Apply. A browser window will open — log in normally, it closes automatically.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: linkedinLoggedIn ? 'var(--green)' : 'var(--text-muted)', fontSize: 13,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: linkedinLoggedIn ? 'var(--green)' : 'var(--border)',
            }} />
            {linkedinLoggedIn ? 'Logged in' : 'Not logged in'}
          </div>
          {linkedinLoggedIn ? (
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
              await window.api.linkedinLogout()
              setLinkedinLoggedIn(false)
              setLinkedinMsg('')
            }}>
              Log Out
            </button>
          ) : (
            <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={linkedinLogging} onClick={async () => {
              setLinkedinLogging(true)
              setLinkedinMsg('')
              const res = await window.api.linkedinLogin()
              setLinkedinLogging(false)
              if (res.success) {
                setLinkedinLoggedIn(true)
                setLinkedinMsg('Logged in successfully!')
              } else {
                setLinkedinMsg(res.error || 'Login failed')
              }
            }}>
              {linkedinLogging ? 'Waiting for login...' : 'Login to LinkedIn'}
            </button>
          )}
        </div>
        {linkedinMsg && (
          <div style={{ marginTop: 10, fontSize: 12, color: linkedinLoggedIn ? 'var(--green)' : 'var(--red)' }}>
            {linkedinMsg}
          </div>
        )}
      </div>

      {/* Indeed */}
      <IndeedAccountCard />

      {/* Seek */}
      <SeekAccountCard />
      </div> {/* end account cards grid */}

      {/* Email Notifications */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Email Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Used to send job alerts, daily reports, follow-up emails, and check your inbox for recruiter
          replies. Gmail, Yahoo, iCloud, Fastmail, Zoho and AOL are recognised automatically; anything
          else — a personal domain, a university address, a company mail server — needs the servers
          entered below.
        </p>

        <MailServers form={form} set={set} />

        {/* App Password helper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={gmailLogging} onClick={async () => {
            setGmailLogging(true); setGmailMsg('')
            const res = await window.api.gmailLogin(form.gmailAddress)
            setGmailLogging(false)
            if (!res.success) setGmailMsg(res.error || 'Failed to open browser')
          }}>
            {gmailLogging ? 'Opening...' : 'Open App Passwords Page ↗'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Opens the correct page for your email provider
          </span>
        </div>
        {gmailMsg && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, padding: '8px 12px', background: 'var(--surface2)', borderRadius: 6 }}>
            {gmailMsg}
          </div>
        )}

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="set-f10">Email Address</label>
            <input id="set-f10" type="email" value={form.gmailAddress} onChange={e => set('gmailAddress', e.target.value)} placeholder="you@gmail.com" />
          </div>
          <div className="form-group">
            <label htmlFor="set-f11">App Password <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(generated in your email provider's security settings)</span></label>
            <input id="set-f11" type="password" value={form.gmailAppPassword} onChange={e => set('gmailAppPassword', e.target.value)} placeholder="App-specific password" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={testEmail} disabled={!form.gmailAddress || !form.gmailAppPassword || testingEmail}>
            {testingEmail ? 'Testing...' : 'Test Connection'}
          </button>
          {emailResult && (
            <span style={{ color: emailResult.success ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
              {emailResult.success ? '✓ Connected' : `✗ ${emailResult.error}`}
            </span>
          )}
        </div>

        {/* Inbox check */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableInboxCheck} onChange={e => set('enableInboxCheck', e.target.checked)} />
              Auto-check inbox for recruiter replies
            </label>
          </div>
          {form.enableInboxCheck && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
              <div>
                <label htmlFor="set-f12" style={{ fontSize: 12 }}>Check every</label>
                <select id="set-f12" value={form.inboxCheckHours ?? 2} onChange={e => set('inboxCheckHours', e.target.value)}
                  style={{ width: 130, padding: '6px 10px', fontSize: 12 }}>
                  {[1, 2, 3, 4, 6, 8, 12, 24].map(h => (
                    <option key={h} value={h}>{h === 1 ? 'hour' : `${h} hours`}</option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 6, fontSize: 12 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!form.inboxCheckWeekdaysOnly}
                  onChange={e => set('inboxCheckWeekdaysOnly', e.target.checked)} />
                Weekdays only
              </label>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px', flex: '1 1 220px', minWidth: 200 }}>
                Checks run every day by default — a Friday-evening reply otherwise
                waits until Monday. Applications marked Pending or No Response are
                re-checked too, so a later email can still move them forward.
              </p>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}
              disabled={checkingInbox || !form.gmailAddress || !form.gmailAppPassword}
              onClick={async () => {
                setCheckingInbox(true); setInboxResult(null)
                const res = await window.api.checkInboxNow()
                setCheckingInbox(false); setInboxResult(res)
              }}>
              {checkingInbox ? 'Checking...' : 'Check Inbox Now'}
            </button>
            {inboxResult && (
              <span style={{ fontSize: 12, color: inboxResult.success ? 'var(--green)' : 'var(--red)' }}>
                {inboxResult.success
                  ? `✓ Scanned ${inboxResult.checked} emails — ${inboxResult.updated?.length || 0} status${inboxResult.updated?.length === 1 ? '' : 'es'} updated`
                  : `✗ ${inboxResult.error}`}
              </span>
            )}
          </div>
          {form.lastInboxCheck && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Last checked: {new Date(form.lastInboxCheck).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Automation Schedule */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>Automation Schedule</h3>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="set-f13">Daily Scan Time (Mon–Fri)</label>
            <input id="set-f13" type="time" value={form.scheduledScanTime || '09:00'} onChange={e => set('scheduledScanTime', e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="set-f14">Daily Report Time (Mon–Fri)</label>
            <input id="set-f14" type="time" value={form.dailyReportTime || '18:00'} onChange={e => set('dailyReportTime', e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableFollowUp} onChange={e => set('enableFollowUp', e.target.checked)} />
            Auto follow-up emails for unanswered applications
          </label>
        </div>
        {form.enableFollowUp && (
          <>
            <div className="form-group">
              <label htmlFor="set-f15">Send the first follow-up after how many days of no response</label>
              <input id="set-f15" type="number" min={1} max={30} value={form.followUpDays || 7} onChange={e => set('followUpDays', e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="set-f16">How many follow-ups in total</label>
              <input id="set-f16" type="number" min={1} max={5} value={form.followUpMaxCount ?? 2} onChange={e => set('followUpMaxCount', e.target.value)} />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                Each one is written differently — the second leads with something new rather than
                repeating the first, and later ones read as a closing note rather than another pitch.
                Set to 1 for a single nudge.
              </p>
            </div>
            {(form.followUpMaxCount ?? 2) > 1 && (
              <div className="form-group">
                <label htmlFor="set-f17">Days between follow-ups</label>
                <input id="set-f17" type="number" min={7} max={90} value={form.followUpIntervalDays ?? 14} onChange={e => set('followUpIntervalDays', e.target.value)} />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Counted from the last follow-up, not from the application, so the gap the recruiter
                  actually experiences is the one set here.
                </p>
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.reviewFollowUpEmails !== false} onChange={e => set('reviewFollowUpEmails', e.target.checked)} />
              Review each drafted follow-up before it is emailed
            </label>
            {form.reviewFollowUpEmails !== false && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                Rejecting a draft stops the whole sequence for that application — not just that one
                email — so declining once does not bring it back in a fortnight.
              </p>
            )}
          </>
        )}
      </div>
      {/* Smart Scheduling */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Smart Scheduling</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Spread applications in natural-looking batches throughout the day instead of all at once.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableSmartScheduling} onChange={e => set('enableSmartScheduling', e.target.checked)} />
            Enable smart scheduling
          </label>
        </div>
        {form.enableSmartScheduling && (
          <div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="set-f18">Start Time</label>
                <input id="set-f18" type="time" value={form.smartScheduleStartTime || '09:00'} onChange={e => set('smartScheduleStartTime', e.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="set-f19">End Time</label>
                <input id="set-f19" type="time" value={form.smartScheduleEndTime || '17:00'} onChange={e => set('smartScheduleEndTime', e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="set-f20">Applications per batch</label>
                <input id="set-f20" type="number" min={1} max={20} value={form.smartScheduleBatchSize || 3} onChange={e => set('smartScheduleBatchSize', parseInt(e.target.value) || 3)} />
              </div>
              <div className="form-group">
                <label htmlFor="set-f21">Jitter (± minutes)</label>
                <input id="set-f21" type="number" min={0} max={60} value={form.smartScheduleJitter || 15} onChange={e => set('smartScheduleJitter', parseInt(e.target.value) || 15)} />
              </div>
            </div>
          </div>
        )}
      </div>
      </div>} {/* end accounts tab */}

      {settingsTab === 'notifications' && <div>

      {/* Push notifications to the phone.
          The point of this feature: everything Hiro learns while nobody is
          looking at the window — a recruiter reply, an interview tomorrow, a
          blocked scan — used to be discoverable only by opening the app. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Phone Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Push notifications to the Hiro app on your phone. Sent through Expo’s push service
          straight from this desktop — there is no Hiro server in between. Needs cloud sync
          signed in on both devices, because that is where the phone registers itself.
        </p>

        {!cloudStatus?.signedIn && (
          <p style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 12 }}>
            Cloud sync is not signed in, so there is nowhere for your phone to register.
            Set it up under <strong>Accounts &amp; Schedule → Cloud Sync</strong> first.
          </p>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12, fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }}
            checked={!!form.pushEnabled}
            onChange={e => set('pushEnabled', e.target.checked)} />
          Send notifications to my phone
        </label>

        {form.pushEnabled && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                What to send
              </label>
              {[
                ['reply', 'A recruiter replied', 'The one you most want off the desktop.'],
                ['interview', 'Interview reminders', 'A day ahead and again an hour before.'],
                ['expiring', 'Application closing soon', 'Only for jobs still waiting on you.'],
                ['followUp', 'A follow-up is due', 'From the next-action dates on the Pipeline board.'],
                ['review', 'Drafts waiting for review', 'At most one reminder a day.'],
                ['scanFailed', 'A scan failed or was blocked', 'The one scan outcome you have to act on.'],
                ['newDevice', 'A new device signed in', 'A security event, not a status update.'],
              ].map(([key, label, hint]) => (
                <label key={key} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
                  marginBottom: 6, fontSize: 13,
                }}>
                  <input type="checkbox" style={{ width: 'auto', marginTop: 3 }}
                    // Absent means on: a config written before a kind existed must
                    // not read as "the user switched this off".
                    checked={form.pushKinds?.[key] !== false}
                    onChange={e => set('pushKinds', { ...(form.pushKinds || {}), [key]: e.target.checked })} />
                  <span>
                    {label}
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="set-f22">Warn about a closing date this many days ahead</label>
                <input id="set-f22" type="number" min="0" max="30" value={form.closingSoonDays ?? 3}
                  onChange={e => set('closingSoonDays', Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label htmlFor="set-f23">Review reminders, at most one every (hours)</label>
                <input id="set-f23" type="number" min="1" max="168" value={form.reviewReminderHours ?? 24}
                  onChange={e => set('reviewReminderHours', Number(e.target.value))} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              {/* Proves the whole path — token registry, Expo, APNs/FCM — instead
                  of leaving the user to wonder whether silence means "working" or
                  "misconfigured". */}
              <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={pushBusy}
                onClick={async () => {
                  setPushBusy(true)
                  const r = await window.api.sendTestPush?.()
                  setPushBusy(false)
                  showToast?.(
                    r?.success
                      ? `Sent to ${r.sent} of ${r.total} device(s) — check your phone.`
                      : `Not sent: ${r?.reason}`,
                    r?.success ? 'success' : 'error')
                }}>{pushBusy ? 'Sending...' : 'Send a test notification'}</button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Save your changes first — the test uses the saved settings.
              </span>
            </div>
          </>
        )}
      </div>

      {/* Two-way calendar sync.
          The .ics export it supplements is one-way and one-shot: moving an
          interview in Google Calendar left Hiro reminding you about the old time,
          and correcting it in Hiro left the calendar wrong. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Calendar Sync</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Keep interviews in step with Google Calendar or Outlook, both ways. Reschedule in
          either place and the other follows. The one-off <strong>.ics export</strong> on the
          Dashboard still works and needs none of this.
        </p>

        {!calSync?.connected ? (
          <>
            <div className="form-group">
              <label htmlFor="set-f24">Provider</label>
              <select id="set-f24" value={calProvider} onChange={e => setCalProvider(e.target.value)}>
                <option value="">Choose…</option>
                {(calSync?.providers || []).map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            {!!calProvider && (() => {
              const provider = (calSync?.providers || []).find(p => p.id === calProvider)
              return (
                <>
                  {/* Hiro ships no OAuth client of its own on purpose: a client
                      secret inside a downloadable binary is not a secret, and one
                      shared client id would put every user's calendar access
                      behind a single credential controlled by someone else. */}
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                    Register your own OAuth client at{' '}
                    <a href={provider?.consoleUrl} target="_blank" rel="noreferrer"
                      style={{ color: 'var(--accent)' }}>{provider?.consoleUrl}</a>{' '}
                    as a <strong>desktop / native</strong> app, with{' '}
                    <code>http://127.0.0.1</code> as an allowed redirect. Hiro deliberately does not
                    ship its own client credentials — a secret inside a downloadable app is not a secret.
                  </p>
                  <div className="form-group">
                    <label htmlFor="set-f25">OAuth client ID</label>
                    <input id="set-f25" value={calClientId} onChange={e => setCalClientId(e.target.value)}
                      placeholder="xxxxx.apps.googleusercontent.com" />
                  </div>
                  {provider?.needsSecret && (
                    <div className="form-group">
                      <label htmlFor="set-f26">OAuth client secret</label>
                      <input id="set-f26" type="password" value={calClientSecret}
                        onChange={e => setCalClientSecret(e.target.value)} />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Google issues one even for desktop clients and requires it on the token exchange.
                      </span>
                    </div>
                  )}
                  <button className="btn btn-primary" disabled={calBusy || !calClientId.trim()} onClick={async () => {
                    setCalBusy(true)
                    const r = await window.api.calendarSyncConnect?.({
                      provider: calProvider,
                      clientId: calClientId,
                      clientSecret: calClientSecret,
                    })
                    setCalBusy(false)
                    if (r?.success) {
                      showToast?.(`Connected to ${r.label}.`, 'success')
                      setCalSync(await window.api.calendarSyncStatus?.())
                    } else {
                      showToast?.(r?.error || 'Could not connect.', 'error')
                    }
                  }}>{calBusy ? 'Waiting for your browser…' : 'Connect'}</button>
                </>
              )
            })()}
          </>
        ) : (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface2)',
              borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: 13,
            }}>
              <span style={{ color: 'var(--green)' }}>●</span>
              <div style={{ flex: 1 }}>
                <strong>{calSync.label}</strong>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {calSync.linkedCount} interview{calSync.linkedCount === 1 ? '' : 's'} mirrored
                  {calSync.lastSyncAt ? ` · last synced ${new Date(calSync.lastSyncAt).toLocaleString()}` : ' · not synced yet'}
                  {calSync.error ? ` · ${calSync.error}` : ''}
                </div>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                setCalBusy(true)
                const r = await window.api.calendarSyncNow?.()
                setCalBusy(false)
                showToast?.(r?.error ? `Sync failed: ${r.error}` : 'Calendar synced.', r?.error ? 'error' : 'success')
                setCalSync(await window.api.calendarSyncStatus?.())
              }} disabled={calBusy}>{calBusy ? 'Syncing…' : 'Sync now'}</button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12, fontSize: 13 }}>
              <input type="checkbox" style={{ width: 'auto' }}
                checked={!!form.calendarSyncEnabled}
                onChange={e => set('calendarSyncEnabled', e.target.checked)} />
              Keep interviews in sync automatically (every 15 minutes)
            </label>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="set-f27">Calendar</label>
                <select id="set-f27" value={form.calendarId || ''} onChange={e => set('calendarId', e.target.value)}>
                  <option value="">Default calendar</option>
                  {(calCalendars || []).map(c => (
                    <option key={c.id} value={c.id}>{c.label}{c.primary ? ' (primary)' : ''}</option>
                  ))}
                </select>
                <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 6, alignSelf: 'flex-start' }}
                  onClick={async () => {
                    const r = await window.api.calendarSyncListCalendars?.()
                    if (r?.success) setCalCalendars(r.calendars)
                    else showToast?.(r?.error || 'Could not list calendars.', 'error')
                  }}>Load my calendars</button>
              </div>
              <div className="form-group">
                <label htmlFor="set-f28">Remind me this many minutes before</label>
                <input id="set-f28" type="number" min="0" max="1440" value={form.calendarReminderMinutes ?? 60}
                  onChange={e => set('calendarReminderMinutes', Number(e.target.value))} />
              </div>
            </div>

            {/* Both of these are decisions a user would otherwise have to
                discover by experiment. */}
            <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
              Events you created yourself are never touched, in either direction — Hiro has no
              application to attach them to. Disconnecting leaves the interviews already in your
              calendar exactly where they are.
            </p>

            <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }}
              onClick={async () => {
                await window.api.calendarSyncDisconnect?.()
                setCalSync(await window.api.calendarSyncStatus?.())
                setCalCalendars(null)
                showToast?.('Calendar disconnected. Existing events were left in place.', 'success')
              }}>Disconnect</button>
          </>
        )}
      </div>

      {/* Webhook Notifications */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Webhook Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Get notified on Discord or Slack when jobs need attention, scans complete, or inbox replies arrive.
        </p>
        {(form.webhooks || []).map((wh, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0, fontSize: 13 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={!!wh.enabled} onChange={e => {
                    const webhooks = [...(form.webhooks || [])]
                    webhooks[i] = { ...webhooks[i], enabled: e.target.checked }
                    set('webhooks', webhooks)
                  }} />
                  Enabled
                </label>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)' }} onClick={() => {
                const webhooks = (form.webhooks || []).filter((_, j) => j !== i)
                set('webhooks', webhooks)
              }}>Remove</button>
            </div>
            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="set-f29">Provider</label>
                <select id="set-f29" value={wh.provider || 'discord'} onChange={e => {
                  const webhooks = [...(form.webhooks || [])]
                  webhooks[i] = { ...webhooks[i], provider: e.target.value }
                  set('webhooks', webhooks)
                }}>
                  <option value="discord">Discord</option>
                  <option value="slack">Slack</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 3 }}>
                <label htmlFor="set-f30">Webhook URL</label>
                <input id="set-f30" value={wh.url || ''} placeholder="https://discord.com/api/webhooks/..." onChange={e => {
                  const webhooks = [...(form.webhooks || [])]
                  webhooks[i] = { ...webhooks[i], url: e.target.value }
                  set('webhooks', webhooks)
                }} />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label>Events</label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {['attention', 'scan-complete', 'inbox-reply', 'weekly-report'].map(evt => (
                  <label key={evt} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, marginBottom: 0 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={(wh.events || ['attention', 'scan-complete', 'inbox-reply', 'weekly-report']).includes(evt)} onChange={e => {
                      const webhooks = [...(form.webhooks || [])]
                      const currentEvents = webhooks[i].events || ['attention', 'scan-complete', 'inbox-reply', 'weekly-report']
                      webhooks[i] = { ...webhooks[i], events: e.target.checked ? [...currentEvents, evt] : currentEvents.filter(x => x !== evt) }
                      set('webhooks', webhooks)
                    }} />
                    {evt.replace('-', ' ')}
                  </label>
                ))}
              </div>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
              try {
                const res = await window.api.testWebhook(wh.provider || 'discord', wh.url)
                showToast?.(res.success ? 'Test notification sent!' : 'Failed to send test notification', res.success ? 'success' : 'error')
              } catch { showToast?.('Error testing webhook', 'error') }
            }}>Send Test</button>
          </div>
        ))}
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => {
          const webhooks = [...(form.webhooks || []), { provider: 'discord', url: '', enabled: true, events: ['attention', 'scan-complete', 'inbox-reply', 'weekly-report'] }]
          set('webhooks', webhooks)
        }}>+ Add Webhook</button>
      </div>

      {/* Desktop Notifications */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Desktop Notifications</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Show a system notification when a scan finishes, a job needs attention, or a recruiter replies —
          only while Hiro is in the background.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.enableDesktopNotifications !== false} onChange={e => set('enableDesktopNotifications', e.target.checked)} />
          Enable desktop notifications
        </label>
      </div>

      {/* Weekly Report */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Weekly Report</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Automatically send a weekly application summary to your webhooks every Monday at 9am.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!form.enableWeeklyReport} onChange={e => set('enableWeeklyReport', e.target.checked)} />
          Enable weekly report
        </label>
      </div>

      {/* Mobile App */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Mobile App</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Pair the Hiro mobile app to check stats and update application statuses from your phone.
          The phone connects directly to this computer over your local network — no data leaves your machine.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!mobileInfo?.enabled} disabled={mobileBusy} onChange={async e => {
            setMobileBusy(true)
            const info = await window.api.setMobileEnabled(e.target.checked)
            setMobileInfo(info)
            setMobileBusy(false)
          }} />
          Enable mobile companion server
        </label>
        {mobileInfo?.enabled && (
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: 14, fontSize: 13 }}>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Status: </span>
              <span style={{ color: mobileInfo.running ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                {mobileInfo.running ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Server address: </span>
              {(mobileInfo.addresses || []).length
                ? mobileInfo.addresses.map(a => <code key={a} style={{ marginRight: 8 }}>{a}:{mobileInfo.port}</code>)
                : <span style={{ color: 'var(--text-muted)' }}>no network connection found</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)' }}>Pairing token: </span>
              <code style={{ wordBreak: 'break-all' }}>{mobileInfo.token}</code>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => {
                navigator.clipboard.writeText(mobileInfo.token)
                showToast?.('Token copied', 'success')
              }}>Copy</button>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                const info = await window.api.regenerateMobileToken()
                setMobileInfo(info)
                showToast?.('New token generated — re-pair your phone', 'info')
              }}>Regenerate</button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              The token above is shared by every phone that has ever used it and never expires.
              Pairing below gives each phone its own token instead — one you can age out and
              withdraw from a single lost device.
            </p>

            {/* ── QR pairing ───────────────────────────────────── */}
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              {!pairingSession ? (
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={async () => {
                  const s = await window.api.startPairing?.()
                  if (s?.error) return showToast?.(`Could not start pairing: ${s.error}`, 'error')
                  setPairingSession(s)
                }}>Pair a phone</button>
              ) : (
                <div>
                  <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    {pairingSession.svg && (
                      // Rendered in the main process; the renderer only draws it.
                      <div
                        style={{ background: '#fff', padding: 8, borderRadius: 8, width: 180, height: 180 }}
                        dangerouslySetInnerHTML={{ __html: pairingSession.svg }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                        Scan this in the Hiro app, or type the code:
                      </div>
                      <code style={{ fontSize: 22, letterSpacing: 3, fontWeight: 600 }}>
                        {pairingSession.code}
                      </code>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                        Address: <code>{(pairingSession.addresses || [])[0] || '—'}:{pairingSession.port}</code>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                        Single use, and expires{' '}
                        {new Date(pairingSession.expiresAt).toLocaleTimeString()}.
                      </div>
                      <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 10 }} onClick={async () => {
                        await window.api.cancelPairing?.()
                        setPairingSession(null)
                        setPairedDevices(await window.api.listPairedDevices?.() || [])
                      }}>Done</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Trusted devices */}
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
                  if (pairedDevices) return setPairedDevices(null)
                  setPairedDevices(await window.api.listPairedDevices?.() || [])
                }}>{pairedDevices ? 'Hide paired phones' : 'Show paired phones'}</button>

                {pairedDevices && (
                  <div style={{ marginTop: 10 }}>
                    {pairedDevices.length === 0 && (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        No phones paired yet. Anything still connecting is using the shared token above.
                      </p>
                    )}
                    {pairedDevices.map(d => (
                      <div key={d.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface2)',
                        borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: 12,
                      }}>
                        <div style={{ flex: 1 }}>
                          <strong>{d.name}</strong>
                          {d.expired && <span style={{ color: 'var(--red)' }}> · expired</span>}
                          <div style={{ color: 'var(--text-muted)' }}>
                            {d.platform} · paired {new Date(d.createdAt).toLocaleDateString()}
                            {' · last seen '}{new Date(d.lastSeenAt).toLocaleString()}
                            {d.expiresAt && ` · expires ${new Date(d.expiresAt).toLocaleDateString()}`}
                          </div>
                        </div>
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={async () => {
                            const r = await window.api.revokePairedDevice?.(d.id)
                            showToast?.(r?.success ? `${d.name} revoked` : `Could not revoke: ${r?.reason}`,
                              r?.success ? 'success' : 'error')
                            setPairedDevices(await window.api.listPairedDevices?.() || [])
                          }}>Revoke</button>
                      </div>
                    ))}
                    {pairedDevices.length > 0 && (
                      <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                        if (!window.confirm('Revoke every paired phone? Each will need pairing again.')) return
                        await window.api.revokeAllPairedDevices?.()
                        setPairedDevices(await window.api.listPairedDevices?.() || [])
                        showToast?.('All phones revoked', 'success')
                      }}>Revoke all</button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* The token and the data it returns cross the network unencrypted,
                so the choice of network is a security decision the user has to
                be able to make knowingly. */}
            <p style={{ color: 'var(--amber)', fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              ⚠ This connection is not encrypted. Use it only on networks you trust —
              on shared or public Wi-Fi, anyone watching the traffic can capture the
              token and read your application data. Turn this off when you're away
              from home, or use cloud sync instead.
            </p>
          </div>
        )}
      </div>

      {/* Cloud Sync */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Cloud Sync</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Sign in with a Supabase account to sync your applications to the cloud, so the
          mobile app can see them from anywhere — not just your home Wi-Fi. Your local
          database stays the source of truth; the cloud is a private mirror.{' '}
          See <code>supabase/SETUP.md</code> for the one-time project setup.
        </p>

        {cloudStatus?.signedIn ? (
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: 14, fontSize: 13 }}>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--text-muted)' }}>Signed in as </span>
              <strong>{cloudStatus.email}</strong>
            </div>
            <div style={{ marginBottom: 10 }}>
              <span style={{ color: 'var(--text-muted)' }}>Status: </span>
              <span style={{ color: cloudStatus.error ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                {cloudStatus.syncing ? 'Syncing…' : cloudStatus.error ? `Error: ${cloudStatus.error}` : 'Synced'}
              </span>
              {cloudStatus.lastSyncAt && !cloudStatus.error && (
                <span style={{ color: 'var(--text-muted)' }}> · last {new Date(cloudStatus.lastSyncAt).toLocaleString()}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={cloudBusy} onClick={async () => {
                setCloudBusy(true)
                const r = await window.api.cloudSyncNow()
                if (r.status) setCloudStatus(r.status)
                setCloudBusy(false)
                showToast?.(r.success ? 'Synced' : `Sync failed: ${r.error}`, r.success ? 'success' : 'error')
              }}>Sync now</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={cloudBusy} onClick={async () => {
                setCloudBusy(true)
                const r = await window.api.cloudSignOut()
                setCloudStatus(r.status)
                setCloudPassword('')
                setCloudBusy(false)
              }}>Sign out</button>
            </div>

            {/* Sync has stopped on purpose. Both this device and the account
                hold data, and merging is only one of three answers. */}
            {cloudStatus.pendingFirstSync && (
              <div style={{
                marginTop: 14, padding: 14, borderRadius: 8,
                background: 'var(--surface2)', borderLeft: '3px solid var(--yellow)',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  Sync paused — how should these be combined?
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  This device has <strong>{cloudStatus.pendingFirstSync.localCount}</strong> application(s)
                  and the account has <strong>{cloudStatus.pendingFirstSync.remoteCount}</strong>. Nothing
                  has been changed on either side. This is asked once.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { id: 'merge', label: 'Keep both', hint: 'Combine them. Nothing is deleted.' },
                    { id: 'cloud', label: 'Use the cloud copy', hint: 'Replaces this device’s history.' },
                    { id: 'local', label: 'Use this device', hint: 'Replaces the account’s history.' },
                  ].map(opt => (
                    <button
                      key={opt.id}
                      className={opt.id === 'merge' ? 'btn btn-primary' : 'btn btn-ghost'}
                      style={{ fontSize: 12 }}
                      disabled={cloudBusy}
                      title={opt.hint}
                      onClick={async () => {
                        if (opt.id !== 'merge' && !window.confirm(
                          `${opt.hint}\n\nThis cannot be undone. Continue?`)) return
                        setCloudBusy(true)
                        const r = await window.api.cloudResolveFirstSync?.(opt.id)
                        const s = await window.api.cloudStatus?.()
                        if (s) setCloudStatus(s)
                        setCloudBusy(false)
                        showToast?.(r?.success ? 'Sync resumed' : `Could not resolve: ${r?.reason}`,
                          r?.success ? 'success' : 'error')
                      }}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Conflicts: what sync discarded, and a way to take it back. */}
            {cloudStatus.conflicts > 0 && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
                  if (syncConflicts) return setSyncConflicts(null)
                  setSyncConflicts(await window.api.cloudConflicts?.() || [])
                }}>
                  {syncConflicts ? 'Hide' : `Show ${cloudStatus.conflicts} sync conflict${cloudStatus.conflicts === 1 ? '' : 's'}`}
                </button>
                {syncConflicts && (
                  <div style={{ marginTop: 10 }}>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                      This device and your phone changed the same field between syncs. The desktop copy
                      was kept — it owns far more of the record — and the phone’s value is listed here
                      rather than discarded silently.
                    </p>
                    {syncConflicts.map(c => (
                      <div key={c.id} style={{
                        background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px',
                        marginBottom: 6, fontSize: 12,
                      }}>
                        <div style={{ fontWeight: 600 }}>{c.job_title} · {c.company}</div>
                        <div style={{ color: 'var(--text-muted)' }}>
                          {c.field}: kept <strong>{c.local_value}</strong> · phone had <strong>{c.remote_value}</strong>
                          {' · '}{new Date(String(c.detected_at).replace(' ', 'T') + 'Z').toLocaleString()}
                        </div>
                        {c.resolved_as === 'local-kept' && (c.field === 'status' || c.field === 'comment') && (
                          <button className="btn btn-ghost" style={{ fontSize: 11, marginTop: 6, padding: '2px 8px' }}
                            onClick={async () => {
                              const r = await window.api.cloudApplyConflict?.(c.id)
                              showToast?.(r?.success ? 'Applied the phone’s value' : `Could not apply: ${r?.reason}`,
                                r?.success ? 'success' : 'error')
                              setSyncConflicts(await window.api.cloudConflicts?.() || [])
                            }}>Use the phone’s value instead</button>
                        )}
                        {c.resolved_as === 'remote-applied' && (
                          <div style={{ color: 'var(--green)', marginTop: 4 }}>Phone’s value applied</div>
                        )}
                      </div>
                    ))}
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                      await window.api.cloudClearConflicts?.()
                      setSyncConflicts([])
                      const s = await window.api.cloudStatus?.()
                      if (s) setCloudStatus(s)
                    }}>Clear the log</button>
                  </div>
                )}
              </div>
            )}

            {/* Devices on the account. A device you cannot see is one you cannot
                cut off — and the three actions here have genuinely different
                strengths, so each is labelled with what it actually does rather
                than all three being called "revoke". */}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
                if (devices) return setDevices(null)
                setDevices(await window.api.cloudListDevices?.() || [])
              }}>{devices ? 'Hide devices' : 'Show devices on this account'}</button>
              {devices && (
                <div style={{ marginTop: 10 }}>
                  {devices.length === 0 && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      No devices registered yet. Run <strong>schema.sql</strong> against your Supabase
                      project if you added cloud sync before this feature existed, then sync once.
                    </p>
                  )}
                  {devices.map(d => (
                    <div key={d.device_id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface2)',
                      borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: 12,
                      opacity: d.revokePending ? 0.6 : 1,
                    }}>
                      <div style={{ flex: 1 }}>
                        <strong>{d.name || d.device_id}</strong>
                        {d.isThisDevice && <span style={{ color: 'var(--accent)' }}> · this device</span>}
                        {d.pushRegistered && <span style={{ color: 'var(--text-muted)' }}> · notifications on</span>}
                        {d.revokePending && <span style={{ color: 'var(--red)' }}> · sign-out pending</span>}
                        <div style={{ color: 'var(--text-muted)' }}>
                          {d.platform} · {d.kind}
                          {d.app_version ? ` · v${d.app_version}` : ''}
                          {d.sessionAgeDays != null && ` · signed in ${d.sessionAgeDays === 0 ? 'today' : `${d.sessionAgeDays}d ago`}`}
                          {' · '}
                          {/* Time since last contact is the number that reveals a
                              device nobody is using any more. */}
                          {d.lastSeenDaysAgo === 0
                            ? `last seen ${new Date(d.last_seen_at).toLocaleTimeString()}`
                            : `last seen ${d.lastSeenDaysAgo}d ago`}
                        </div>
                      </div>
                      {!d.isThisDevice && !d.revokePending && (
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                          title="Ask this device to sign itself out the next time it connects, and stop its notifications now"
                          onClick={async () => {
                            const r = await window.api.cloudRevokeDevice?.(d.device_id)
                            showToast?.(
                              r?.success
                                ? 'Device will sign itself out on next contact; its notifications stopped now.'
                                : `Could not revoke: ${r?.reason}`,
                              r?.success ? 'success' : 'error')
                            setDevices(await window.api.cloudListDevices?.() || [])
                          }}>Sign out</button>
                      )}
                      {!d.isThisDevice && (
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                          title="Remove from this list only. A device that is still signed in will reappear."
                          onClick={async () => {
                            const r = await window.api.cloudForgetDevice?.(d.device_id)
                            if (!r?.success) showToast?.(`Could not remove: ${r?.reason}`, 'error')
                            setDevices(await window.api.cloudListDevices?.() || [])
                          }}>Remove from list</button>
                      )}
                    </div>
                  ))}

                  {/* Said plainly, because the difference matters when a phone
                      has actually been lost. */}
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    <strong>Sign out</strong> stops that device’s notifications immediately and asks it to
                    sign itself out and forget its saved session the next time it connects. It cannot reach
                    a device that is switched off.<br />
                    <strong>Remove from list</strong> is bookkeeping only — a device that is still signed in
                    will register itself again.<br />
                    For a phone you have actually lost, use <strong>Sign out everywhere</strong> below: that
                    invalidates every saved session on the account server-side, including this desktop’s.
                  </p>

                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}
                    onClick={async () => {
                      // Not a toast: this is a decision that cannot be undone, so it must block.
                      if (!window.confirm(
                        'Sign every device out of this Hiro account, including this desktop?\n\n'
                        + 'This invalidates every saved session server-side. You will need to sign in again '
                        + 'here and on your phone. Nothing is deleted.'
                      )) return
                      const r = await window.api.cloudSignOutEverywhere?.()
                      showToast?.(
                        r?.success
                          ? 'Every device has been signed out. Sign in again to resume syncing.'
                          : `Could not sign out everywhere: ${r?.reason}`,
                        r?.success ? 'success' : 'error')
                      setDevices(null)
                      window.api.cloudStatus?.().then(setCloudStatus)
                    }}>Sign out everywhere</button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label htmlFor="set-f31">Supabase Project URL</label>
              <input id="set-f31" value={cloudUrl} onChange={e => setCloudUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
            </div>
            <div className="form-group">
              <label htmlFor="set-f32">Supabase anon key</label>
              <input id="set-f32" value={cloudKey} onChange={e => setCloudKey(e.target.value)} placeholder="anon / public key" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="set-f33">Email</label>
                <input id="set-f33" value={cloudEmail} onChange={e => setCloudEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="form-group">
                <label htmlFor="set-f34">Password</label>
                <input id="set-f34" type="password" value={cloudPassword} onChange={e => setCloudPassword(e.target.value)} placeholder="password" />
              </div>
            </div>
            {!!cloudMsg && <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 4 }}>{cloudMsg}</p>}
            <button className="btn btn-primary" disabled={cloudBusy} onClick={async () => {
              setCloudMsg('')
              if (!cloudUrl.trim() || !cloudKey.trim() || !cloudEmail.trim() || !cloudPassword) {
                setCloudMsg('Project URL, anon key, email and password are all required.')
                return
              }
              setCloudBusy(true)
              // Persist the URL + key so the sign-in can build the Supabase client.
              const cfg = await window.api.getConfig()
              await window.api.saveConfig({ ...cfg, supabaseUrl: cloudUrl.trim(), supabaseAnonKey: cloudKey.trim() })
              // Keep the main form in sync — its snapshot still holds the old
              // values and a later "Save Changes" would clobber these.
              setForm(f => ({ ...f, supabaseUrl: cloudUrl.trim(), supabaseAnonKey: cloudKey.trim() }))
              const r = await window.api.cloudSignIn(cloudEmail.trim(), cloudPassword)
              setCloudBusy(false)
              if (r.success) {
                setCloudStatus(r.status)
                setCloudPassword('')
                showToast?.('Signed in — syncing to the cloud', 'success')
              } else {
                setCloudMsg(r.error)
              }
            }}>{cloudBusy ? 'Signing in…' : 'Sign in & sync'}</button>
          </>
        )}
      </div>
      </div>} {/* end notifications tab */}

      {settingsTab === 'criteria' && <div>

      {/* The facts every form asks for, answered without a model call. */}
      <ApplicationProfile form={form} set={set} />

      {/* Answers worked out once, kept for the next time the question comes up. */}
      <AnswerBank showToast={showToast} />

      {/* Job Criteria */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 16, fontSize: 15 }}>Job Criteria</h3>
        <div className="form-group">
          <label htmlFor="set-f35">Keywords</label>
          <input id="set-f35" value={form.jobKeywords} onChange={e => set('jobKeywords', e.target.value)} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="set-f36">Location</label>
            <input id="set-f36" value={form.jobLocation} onChange={e => set('jobLocation', e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="set-f37">Min Salary</label>
            <input id="set-f37" type="number" value={form.salaryMin} onChange={e => set('salaryMin', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="set-f38">Match Threshold: {form.matchThreshold}%</label>
          <input id="set-f38" type="range" min={50} max={100} value={form.matchThreshold}
            onChange={e => set('matchThreshold', e.target.value)}
            style={{ padding: 0, border: 'none', background: 'transparent' }} />
        </div>
        <div className="form-group">
          <label htmlFor="set-f39">Company Cooldown (days)</label>
          <input id="set-f39" type="number" min={0} max={365}
            value={form.companyCooldownDays ?? 30}
            onChange={e => set('companyCooldownDays', e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            After applying to a company, wait this many days before applying to another
            role there. Set to 0 to allow multiple roles at the same company right away.
            Duplicate listings and cross-platform repeats are always skipped regardless.
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="set-f40">Pages per scan</label>
          <input id="set-f40" type="number" min={1} max={10}
            value={form.scrapePages ?? 3}
            onChange={e => set('scrapePages', e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            How many pages of search results to walk on each platform. One page is
            roughly 20 listings, and because already-seen jobs are skipped, a single
            page stops turning up anything new within a few days. More pages find more
            work but take longer and raise the chance of being rate-limited — if scans
            start reporting blocks, lower this.
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="set-f41">Mark as No Response after (days)</label>
          <input id="set-f41" type="number" min={0} max={365}
            value={form.staleAfterDays ?? 45}
            onChange={e => set('staleAfterDays', e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            An application with no reply after this long moves to No Response, so it
            stops dragging down your response rate. Nothing is deleted, and the inbox
            check keeps watching it in case a late reply arrives. Set to 0 to leave
            everything at Applied indefinitely.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}
              disabled={sweeping}
              onClick={async () => {
                setSweeping(true); setSweepResult(null)
                const res = await window.api.sweepStaleApplications()
                setSweeping(false); setSweepResult(res)
              }}>
              {sweeping ? 'Sweeping...' : 'Run Now'}
            </button>
            {sweepResult && (
              <span style={{ fontSize: 12, color: sweepResult.success ? 'var(--green)' : 'var(--red)' }}>
                {sweepResult.success
                  ? `✓ ${sweepResult.updated || 0} application${sweepResult.updated === 1 ? '' : 's'} marked No Response`
                  : `✗ ${sweepResult.error}`}
              </span>
            )}
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ marginBottom: 8 }}>Platforms</label>
          <div style={{ display: 'flex', gap: 16 }}>
            {['Seek', 'Indeed', 'LinkedIn'].map(p => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 0 }}>
                <input type="checkbox" style={{ width: 'auto' }}
                  checked={form[`enable${p}`]}
                  onChange={e => set(`enable${p}`, e.target.checked)} />
                {p}
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {['Seek', 'Indeed', 'LinkedIn'].map(p => (
            <div className="form-group" key={p}>
              <label htmlFor="set-f42">Daily Limit — {p}</label>
              <input id="set-f42" type="number" min={1} max={50}
                value={form[`dailyLimit${p}`]}
                onChange={e => set(`dailyLimit${p}`, e.target.value)} />
            </div>
          ))}
        </div>
        <div className="form-group">
          <label>Blacklisted Companies</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {(form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean).map(company => (
              <span key={company} className="chip">
                {company}
                <button className="chip-remove" onClick={() => {
                  const list = (form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean).filter(c => c !== company)
                  set('blacklistedCompanies', list.join(', '))
                  window.api.removeBlacklistCompany(company)
                }}>✕</button>
              </span>
            ))}
            {!(form.blacklistedCompanies || '').trim() && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No companies blacklisted</span>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newBlacklist}
              onChange={e => setNewBlacklist(e.target.value)}
              placeholder="Add company to blacklist..."
              onKeyDown={e => {
                if (e.key === 'Enter' && newBlacklist.trim()) {
                  const existing = (form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean)
                  if (!existing.map(c => c.toLowerCase()).includes(newBlacklist.trim().toLowerCase())) {
                    set('blacklistedCompanies', [...existing, newBlacklist.trim()].join(', '))
                  }
                  setNewBlacklist('')
                }
              }}
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }} onClick={() => {
              if (!newBlacklist.trim()) return
              const existing = (form.blacklistedCompanies || '').split(',').map(c => c.trim()).filter(Boolean)
              if (!existing.map(c => c.toLowerCase()).includes(newBlacklist.trim().toLowerCase())) {
                set('blacklistedCompanies', [...existing, newBlacklist.trim()].join(', '))
              }
              setNewBlacklist('')
            }}>Add</button>
          </div>
        </div>
      </div>

      {/* Resumes */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Resumes <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 13 }}>({(form.resumes || []).length}/5)</span></h3>
          {(form.resumes || []).length < 5 && !addingResume && (
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setAddingResume(true); setNewResumeName(''); setNewResumeText(''); setUploadError('') }}>
              + Add Resume
            </button>
          )}
        </div>

        {(form.resumes || []).length === 0 && !addingResume && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
            No resumes added yet.
          </div>
        )}

        {(form.resumes || []).map(r => (
          <div key={r.id} style={{
            border: `1px solid ${r.id === form.defaultResumeId ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 8, padding: 12, marginBottom: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</span>
                {r.id === form.defaultResumeId && (
                  <span style={{ fontSize: 11, background: 'var(--accent)', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>Default</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {r.id !== form.defaultResumeId && (
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => saveResumes(form.resumes, r.id)}>
                    Set Default
                  </button>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  disabled={improvingId === r.id}
                  onClick={async () => {
                    setImprovingId(r.id)
                    const res = await window.api.improveResume(r.text)
                    setImprovingId(null)
                    if (res.success) setImproveModal({ sourceId: r.id, sourceName: r.name, text: res.text })
                  }}>
                  {improvingId === r.id ? 'Improving...' : 'Improve with AI'}
                </button>
                {r.originalExt === 'docx' || r.originalExt === 'doc' ? (<>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    disabled={pdfLoading === r.name + '_docx'}
                    onClick={async () => {
                      setPdfLoading(r.name + '_docx')
                      await window.api.openResumeDocx(r.text, r.originalPath || null)
                      setPdfLoading(false)
                    }}>
                    {pdfLoading === r.name + '_docx' ? 'Opening...' : 'Preview DOCX'}
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => window.api.downloadResume(r.text, r.name, 'docx')}>
                    Save DOCX
                  </button>
                </>) : (<>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    disabled={pdfLoading === r.name}
                    onClick={() => viewPDF(r.text, r.name, r.originalPath, r.originalExt)}>
                    {pdfLoading === r.name ? 'Loading...' : 'View PDF'}
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }}
                    onClick={() => window.api.downloadResume(r.text, r.name, 'pdf')}>
                    Save PDF
                  </button>
                </>)}
                <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)' }} onClick={() => {
                  const resumes = (form.resumes || []).filter(x => x.id !== r.id)
                  const defaultResumeId = form.defaultResumeId === r.id ? (resumes[0]?.id || '') : form.defaultResumeId
                  saveResumes(resumes, defaultResumeId)
                }}>
                  Delete
                </button>
              </div>
            </div>
            <ParseCheck resume={r} />
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6 }}>
              {r.text.slice(0, 120).replace(/\n/g, ' ')}…
            </div>
          </div>
        ))}

        {addingResume && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label htmlFor="set-f43" style={{ fontSize: 12 }}>Name</label>
              <input id="set-f43" value={newResumeName} onChange={e => setNewResumeName(e.target.value)} placeholder="e.g. Software Engineer Resume" />
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              {newResumeOriginalPath ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface2)', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 20 }}>{newResumeOriginalExt === 'pdf' ? '📄' : '📝'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{newResumeName || 'Resume'}.{newResumeOriginalExt}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>File uploaded — AI can tailor this for each job</div>
                  </div>
                  <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                    setUploadError('')
                    const res = await window.api.importResumeFile()
                    if (res.canceled) return
                    if (res.success) {
                      setNewResumeText(res.text)
                      if (!newResumeName) setNewResumeName(res.fileName)
                      setNewResumeOriginalPath(res.originalPath || null)
                      setNewResumeOriginalExt(res.originalExt || null)
                    } else { setUploadError(res.error || 'Failed to read file') }
                  }}>Replace</button>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: 12, marginBottom: 0 }}>Resume</label>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
                      setUploadError('')
                      const res = await window.api.importResumeFile()
                      if (res.canceled) return
                      if (res.success) {
                        setNewResumeText(res.text)
                        if (!newResumeName) setNewResumeName(res.fileName)
                        setNewResumeOriginalPath(res.originalPath || null)
                        setNewResumeOriginalExt(res.originalExt || null)
                      } else { setUploadError(res.error || 'Failed to read file') }
                    }}>Upload File (PDF / DOCX)</button>
                  </div>
                  <textarea value={newResumeText} onChange={e => setNewResumeText(e.target.value)}
                    placeholder="Paste resume text or upload a file..." style={{ minHeight: 120 }} />
                </>
              )}
              {uploadError && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{uploadError}</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setAddingResume(false); setNewResumeName(''); setNewResumeText(''); setNewResumeOriginalPath(null); setNewResumeOriginalExt(null) }}>Cancel</button>
              <button className="btn btn-primary" style={{ fontSize: 12 }}
                disabled={!newResumeName.trim() || !newResumeText.trim()}
                onClick={() => {
                  const id = Date.now().toString()
                  const resumes = [...(form.resumes || []), { id, name: newResumeName.trim(), text: newResumeText.trim(), originalPath: newResumeOriginalPath, originalExt: newResumeOriginalExt }]
                  const defaultResumeId = form.defaultResumeId || id
                  saveResumes(resumes, defaultResumeId)
                  setAddingResume(false)
                  setNewResumeName(''); setNewResumeText(''); setNewResumeOriginalPath(null); setNewResumeOriginalExt(null)
                }}>
                Save Resume
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resume routing rules — pick a different base resume per job type */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>Resume Routing</h3>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}
            disabled={(form.resumes || []).length < 2}
            onClick={() => set('resumeRules', [
              ...(form.resumeRules || []),
              { id: Date.now().toString(), keywords: '', resumeId: form.resumes?.[0]?.id || '' },
            ])}>
            + Add Rule
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
          Route jobs to a different base resume by keyword. The first rule whose keywords
          appear in the job title or description wins; anything unmatched uses your default
          resume. Rules are checked top to bottom.
        </p>

        {(form.resumes || []).length < 2 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Add a second resume above to start routing.
          </p>
        )}

        {(form.resumeRules || []).length === 0 && (form.resumes || []).length >= 2 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            No rules yet — every job uses your default resume.
          </p>
        )}

        {(form.resumeRules || []).map((rule, i) => (
          <div key={rule.id} style={{
            display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8,
            border: '1px solid var(--border)', borderRadius: 8, padding: 10,
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 9, width: 16, flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1 }}>
              <input
                value={rule.keywords}
                placeholder="data, analytics, sql"
                onChange={e => set('resumeRules', (form.resumeRules || []).map(r =>
                  r.id === rule.id ? { ...r, keywords: e.target.value } : r))}
              />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Comma-separated. Matches anywhere in the title or description.
              </div>
            </div>
            <select
              value={rule.resumeId}
              style={{ width: 190, flexShrink: 0 }}
              onChange={e => set('resumeRules', (form.resumeRules || []).map(r =>
                r.id === rule.id ? { ...r, resumeId: e.target.value } : r))}>
              {(form.resumes || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="btn btn-ghost" style={{ fontSize: 11, flexShrink: 0 }}
              onClick={() => set('resumeRules', (form.resumeRules || []).filter(r => r.id !== rule.id))}>
              Remove
            </button>
          </div>
        ))}
      </div>

      {/* Resume A/B test. Sits below routing on purpose: rules take priority,
          and the experiment fills the space the default resume would have. */}
      {(() => {
        const exp = form.resumeExperiment || {}
        const resumes = form.resumes || []
        const setExp = (patch) => set('resumeExperiment', { ...exp, ...patch })
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>Resume A/B Test</h3>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!exp.enabled}
                  disabled={resumes.length < 2}
                  onChange={e => setExp({ enabled: e.target.checked })}
                />
                Running
              </label>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
              Splits the jobs no routing rule claimed between two resumes, decided by a hash of the
              job URL. “Which Resume Converts” compares resumes that were sent to different kinds of
              job, so a gap there can be the market rather than the document — this removes that
              confound, and Analytics reports whether the difference is bigger than chance.
            </p>
            {resumes.length < 2 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
                Add a second resume above to run a test.
              </p>
            ) : (
              <>
                <div className="form-group" style={{ marginBottom: 10 }}>
                  <label htmlFor="set-f44">Test name</label>
                  <input id="set-f44"
                    placeholder="e.g. Metrics-led vs narrative-led"
                    value={exp.name || ''}
                    onChange={e => setExp({ name: e.target.value })}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {['resumeA', 'resumeB'].map((slot, i) => (
                    <div className="form-group" key={slot} style={{ marginBottom: 0 }}>
                      <label htmlFor="set-f45">{i === 0 ? 'Resume A' : 'Resume B'}</label>
                      <select id="set-f45" value={exp[slot] || ''} onChange={e => setExp({ [slot]: e.target.value })}>
                        <option value="">Not set</option>
                        {resumes.map(r => (
                          <option key={r.id} value={r.id}>{r.name || r.id}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                {exp.enabled && exp.resumeA && exp.resumeA === exp.resumeB && (
                  <p style={{ color: 'var(--yellow)', fontSize: 12, marginTop: 10, marginBottom: 0 }}>
                    Both arms are the same resume — nothing is being compared. The default resume is
                    used until they differ.
                  </p>
                )}
                {exp.enabled && exp.startedAt && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10, marginBottom: 0 }}>
                    Running since {new Date(exp.startedAt).toLocaleDateString()}. Changing either arm
                    starts a new test — results are only read from applications sent after that point,
                    because earlier ones were never randomised.
                  </p>
                )}
              </>
            )}
          </div>
        )
      })()}

      {/* Personal Links */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 4, fontSize: 15 }}>Personal Links</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
          Used in resume PDFs as clickable links. Auto-detected from DOCX uploads, or enter manually here. Settings override DOCX-extracted links.
        </p>
        <div className="form-group" style={{ marginBottom: 10 }}>
          <label htmlFor="set-f46">Portfolio URL</label>
          <input id="set-f46"
            placeholder="https://yourportfolio.com"
            value={(form.personalLinks || {}).portfolio || ''}
            onChange={e => set('personalLinks', { ...(form.personalLinks || {}), portfolio: e.target.value })}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 10 }}>
          <label htmlFor="set-f47">GitHub URL</label>
          <input id="set-f47"
            placeholder="https://github.com/username"
            value={(form.personalLinks || {}).github || ''}
            onChange={e => set('personalLinks', { ...(form.personalLinks || {}), github: e.target.value })}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="set-f48">LinkedIn URL</label>
          <input id="set-f48"
            placeholder="https://linkedin.com/in/username"
            value={(form.personalLinks || {}).linkedin || ''}
            onChange={e => set('personalLinks', { ...(form.personalLinks || {}), linkedin: e.target.value })}
          />
        </div>
      </div>

      {/* Cover Letter */}
      <div className="card">
        <h3 style={{ marginBottom: 8, fontSize: 15 }}>Cover Letter</h3>
        <div className="form-group">
          <label htmlFor="set-f49">Tone</label>
          <select id="set-f49" value={form.coverLetterTone || 'professional'} onChange={e => set('coverLetterTone', e.target.value)}>
            <option value="professional">Professional (default)</option>
            <option value="casual">Casual &amp; Warm</option>
            <option value="confident">Confident &amp; Direct</option>
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label style={{ marginBottom: 0 }}>Template <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>(optional)</span></label>
            <div style={{ display: 'flex', gap: 6 }}>
            {form.coverLetterTemplate && (
              <button className="btn btn-ghost" style={{ fontSize: 11 }}
                disabled={pdfLoading === 'cl'}
                onClick={async () => {
                  setPdfLoading('cl')
                  const res = await window.api.getCoverLetterPDFBase64(form.coverLetterTemplate)
                  setPdfLoading(false)
                  if (res.success) setPdfModal({ url: res.url, title: 'Cover Letter Template' })
                }}>
                {pdfLoading === 'cl' ? 'Loading...' : 'Preview PDF'}
              </button>
            )}
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={async () => {
              setClUploadError('')
              const res = await window.api.importResumeFile()
              if (res.canceled) return
              if (res.success) set('coverLetterTemplate', res.text)
              else setClUploadError(res.error || 'Failed to read file')
            }}>
              Upload File
            </button>
            </div>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            AI will use this as a structural base. Leave blank for fully AI-generated letters. Supports .txt, .docx, .pdf
          </p>
          <textarea value={form.coverLetterTemplate || ''} onChange={e => set('coverLetterTemplate', e.target.value)}
            placeholder="Leave blank to let AI write freely..." style={{ minHeight: 120, fontSize: 12, fontFamily: 'monospace' }} />
          {clUploadError && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{clUploadError}</div>}
        </div>
      </div>
      </div>} {/* end criteria tab */}

      {settingsTab === 'data' && <div>
        {/* Storage Info */}
        <StorageCard />

        {/* Encryption at rest.
            What is in that database: every job description, tailored resume,
            cover letter, screening answer and recruiter address. A job search is
            often the one thing a person most wants kept from their current
            employer, and all of it sat in plaintext in the profile directory. */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 8, fontSize: 15 }}>Encrypt Local Data</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
            Encrypts the database <em>and every backup</em> with AES-256-GCM. The key is held by
            this computer’s keychain ({encryption?.keychainAvailable ? 'available' : 'unavailable on this system'}),
            so Hiro unlocks it without asking you for a passphrase. Your resumes, cover letters,
            job descriptions and screening answers are all in that file.
          </p>

          {encryption && !encryption.keychainAvailable && (
            <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>
              This system has no usable keychain, so a key cannot be stored safely.
              On Linux this needs a secret service such as gnome-keyring or kwallet.
            </p>
          )}

          {encryption?.keyError && (
            <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{encryption.keyError}</p>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface2)',
            borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: 13,
          }}>
            <span style={{ color: encryption?.databaseEncrypted ? 'var(--green)' : 'var(--text-muted)' }}>
              {encryption?.databaseEncrypted ? '🔒' : '○'}
            </span>
            <div style={{ flex: 1 }}>
              <strong>{encryption?.databaseEncrypted ? 'Database is encrypted' : 'Database is not encrypted'}</strong>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {encryption?.backupCount ?? 0} backup{encryption?.backupCount === 1 ? '' : 's'}
                {/* "Enabled" is not the same as "everything is encrypted": a
                    backup that failed to convert is still readable plaintext. */}
                {encryption?.plaintextBackups?.length
                  ? ` · ${encryption.plaintextBackups.length} still in plaintext`
                  : (encryption?.backupCount ? ' · all encrypted' : '')}
              </div>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} disabled={encBusy || !encryption?.keychainAvailable}
              onClick={async () => {
                const turningOn = !encryption?.enabled
                if (turningOn) {
                  // The one-way door has to be said out loud BEFORE it is walked
                  // through, not discovered afterwards.
                  // Not a toast: this is a decision that cannot be undone, so it must block.
                  if (!window.confirm(
                    'Encrypt the database and all backups?\n\n'
                    + 'The key is stored in this computer\'s keychain. If that keychain is lost — a wiped '
                    + 'machine, a reset user profile — the only way back in is the recovery key, which '
                    + 'Hiro will show you next. Save it somewhere that is not this computer.'
                  )) return
                }
                setEncBusy(true)
                const r = await window.api.setEncryption?.(turningOn)
                if (r?.success && turningOn) {
                  const key = await window.api.exportRecoveryKey?.()
                  if (key?.success) setRecoveryKey(key)
                }
                setEncryption(await window.api.getEncryptionStatus?.())
                setEncBusy(false)
                if (!r?.success) {
                  showToast?.(r?.error || 'Could not change encryption.', 'error')
                } else if (r.failed?.length) {
                  showToast?.(`${r.failed.length} backup(s) could not be converted — see the log.`, 'error')
                } else {
                  showToast?.(turningOn ? 'Database and backups encrypted.' : 'Encryption removed.', 'success')
                }
              }}>
              {encBusy ? 'Working…' : (encryption?.enabled ? 'Turn off' : 'Turn on')}
            </button>
          </div>

          {recoveryKey && (
            <div style={{
              border: '1px solid var(--accent)', borderRadius: 8, padding: 12, marginBottom: 14,
            }}>
              <strong style={{ fontSize: 13 }}>Your recovery key — save this now</strong>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 8px' }}>
                This is the only thing that can open your database on a machine whose keychain no
                longer has the key. Hiro will not show it again unless you ask.
              </p>
              <code style={{
                display: 'block', background: 'var(--surface2)', padding: '8px 10px', borderRadius: 6,
                fontSize: 12, wordBreak: 'break-all', userSelect: 'all', marginBottom: 8,
              }}>{recoveryKey.key}</code>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => {
                  navigator.clipboard?.writeText(recoveryKey.key)
                  showToast?.('Recovery key copied.', 'success')
                }}>Copy</button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }}
                  onClick={() => setRecoveryKey(null)}>I have saved it</button>
              </div>
            </div>
          )}

          {encryption?.enabled && !recoveryKey && (
            <button className="btn btn-ghost" style={{ fontSize: 11, marginBottom: 12 }} onClick={async () => {
              const key = await window.api.exportRecoveryKey?.()
              if (key?.success) setRecoveryKey(key)
              else showToast?.(key?.error || 'Could not read the key.', 'error')
            }}>Show my recovery key again</button>
          )}

          {/* The other half: a profile copied from another machine has an
              encrypted database and a key this keychain cannot unwrap. */}
          <details>
            <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              Restore from a recovery key
            </summary>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0' }}>
              Use this when the profile came from another machine or user account, so this
              computer’s keychain cannot unwrap the stored key.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={recoveryInput} onChange={e => setRecoveryInput(e.target.value)}
                placeholder="HIRO-RECOVERY-1:…" style={{ fontSize: 12 }} />
              <button className="btn btn-ghost" style={{ fontSize: 11, flexShrink: 0 }}
                disabled={!recoveryInput.trim()} onClick={async () => {
                  const r = await window.api.importRecoveryKey?.(recoveryInput)
                  showToast?.(
                    r?.success ? 'Key restored — restart Hiro to open the database.' : (r?.reason || 'Could not import that key.'),
                    r?.success ? 'success' : 'error')
                  if (r?.success) setRecoveryInput('')
                  setEncryption(await window.api.getEncryptionStatus?.())
                }}>Restore</button>
            </div>
          </details>
        </div>

        {/* Rotating database backups */}
        <BackupsCard showToast={showToast} />

        {/* Encrypted settings export / import */}
        <SettingsTransferCard showToast={showToast} onImported={() => window.location.reload()} />

        {/* The applications themselves, which neither the settings bundle nor
            the keychain-bound backups above can move to another machine. */}
        <DataTransferCard showToast={showToast} onImported={() => window.location.reload()} />

        {/* Screening Answer Cache */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ fontSize: 15, margin: 0 }}>Screening Answer Cache</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Answers saved from previous applications. These are reused automatically when the same
                question appears — including on applications to employers who never asked the original.
              </p>
              {staleAnswers.length > 0 && (
                <p style={{ color: 'var(--yellow)', fontSize: 12, marginTop: 6, fontWeight: 500 }}>
                  {staleAnswers.length} answer{staleAnswers.length === 1 ? '' : 's'} not confirmed in over{' '}
                  {staleAfterDays} days. Facts move — years of experience, notice periods, availability —
                  and these keep being submitted until you say otherwise.
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => {
                const data = await window.api.getCachedAnswers()
                setCachedAnswers(data)
              }}>Load Cache</button>
              {cachedAnswers.length > 0 && (
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--red)' }} onClick={async () => {
                  if (!window.confirm('Delete all cached screening answers? This cannot be undone.')) return
                  await window.api.clearAllCachedAnswers()
                  setCachedAnswers([])
                  showToast?.('Screening cache cleared', 'success')
                }}>Clear All</button>
              )}
            </div>
          </div>

          {cachedAnswers.length > 0 && (
            <>
              <input
                value={cachedSearch}
                onChange={e => setCachedSearch(e.target.value)}
                placeholder="Search questions..."
                style={{ marginBottom: 12, fontSize: 12 }}
              />
              {/* Stale first: the whole point is that the oldest answers are the
                  ones most likely to have drifted, and they were previously
                  buried under whatever had been used most recently. */}
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                {cachedAnswers
                  .filter(ca => !cachedSearch || ca.question.toLowerCase().includes(cachedSearch.toLowerCase()) || ca.answer.toLowerCase().includes(cachedSearch.toLowerCase()))
                  .map((ca, i) => ({ ca, i, age: answerAgeDays(ca.updated_at) }))
                  .sort((a, b) => (b.age ?? -1) - (a.age ?? -1))
                  .map(({ ca, i, age }) => {
                    const stale = staleAfterDays > 0 && age != null && age >= staleAfterDays
                    return (
                      <div key={ca.question} style={{
                        padding: 12, background: 'var(--surface2)', borderRadius: 8,
                        marginBottom: 8,
                        border: `1px solid ${stale ? 'var(--yellow)' : 'var(--border)'}`,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: 'var(--text)' }}>Q: {ca.question}</div>
                            <textarea
                              defaultValue={ca.answer}
                              onBlur={async (e) => {
                                const newAnswer = e.target.value.trim()
                                if (newAnswer && newAnswer !== ca.answer) {
                                  await window.api.updateCachedAnswer(ca.question, newAnswer)
                                  // Editing IS confirming: the user has just read it
                                  // and rewritten it, so it is fresh — and it is now
                                  // theirs rather than the model's.
                                  setCachedAnswers(prev => prev.map((c, j) => j === i
                                    ? { ...c, answer: newAnswer, source: 'user', updated_at: new Date().toISOString() }
                                    : c))
                                  showToast?.('Answer updated', 'success')
                                }
                              }}
                              style={{ width: '100%', fontSize: 12, minHeight: 40, padding: '6px 8px', resize: 'vertical' }}
                            />
                          </div>
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--red)', padding: '2px 6px', flexShrink: 0 }}
                            title="Delete this cached answer"
                            onClick={async () => {
                              await window.api.deleteCachedAnswer(ca.question)
                              setCachedAnswers(prev => prev.filter((_, j) => j !== i))
                            }}>✕</button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, color: stale ? 'var(--yellow)' : 'var(--text-muted)' }}>
                            Last confirmed {ca.updated_at ? new Date(ca.updated_at).toLocaleDateString() : 'unknown'}
                            {age != null ? ` · ${age} day${age === 1 ? '' : 's'} ago` : ''}
                          </span>
                          {/* Who wrote it decides whether the fabrication guard
                              re-checks it on every use, so it is worth showing. */}
                          <span className={ca.source === 'user' ? 'badge badge-blue' : 'badge badge-gray'} style={{ fontSize: 9 }}>
                            {ca.source === 'user' ? 'yours' : 'AI-written'}
                          </span>
                          {stale && (
                            <button className="btn btn-ghost" style={{ fontSize: 10, padding: '1px 8px' }}
                              title="Re-date this answer without changing it"
                              onClick={async () => {
                                const res = await window.api.confirmCachedAnswer?.(ca.question)
                                if (res?.success === false) { showToast?.(res.reason, 'error'); return }
                                setCachedAnswers(prev => prev.map((c, j) => j === i
                                  ? { ...c, updated_at: new Date().toISOString() } : c))
                                showToast?.('Marked as still correct', 'success')
                              }}>Still correct</button>
                          )}
                        </div>
                      </div>
                    )
                  })
                }
              </div>
            </>
          )}

          {cachedAnswers.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              Click "Load Cache" to view saved screening answers.
            </div>
          )}
        </div>

        {/* Data Actions */}
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 16 }}>Data Actions</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>Export Application History</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Download all applications as CSV</div>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => window.api.exportCSV({})}>Export CSV</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--red)' }}>Clear All Application History</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Permanently delete all application records</div>
              </div>
              <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={async () => {
                if (!window.confirm('Delete ALL application history? This cannot be undone.')) return
                await window.api.clearAllApplications()
                showToast?.('Application history cleared', 'success')
              }}>Clear All</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--red)' }}>Clear Needs Attention Queue</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Remove all jobs from the attention queue</div>
              </div>
              <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={async () => {
                if (!window.confirm('Clear all attention jobs? This cannot be undone.')) return
                await window.api.clearAllAttentionJobs()
                showToast?.('Attention queue cleared', 'success')
              }}>Clear All</button>
            </div>
          </div>
        </div>
      </div>}

      {settingsTab === 'automation' && <div>
        {/* Review before submit — the mitigation for this product's core risk:
            a bad tailoring pass reaching ten employers before anyone looks. */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>Review Before Submit</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Draft everything, send nothing. Jobs that clear your match threshold are fully prepared —
            resume tailored, cover letter written — then held on the Review page until you approve them.
            Approving costs no extra AI calls.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!form.reviewBeforeSubmit}
              onChange={e => set('reviewBeforeSubmit', e.target.checked)}
            />
            <span>Hold applications for review instead of submitting automatically</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginTop: 10 }}>
            <input
              type="checkbox"
              checked={!!form.confirmBeforeSubmit}
              onChange={e => set('confirmBeforeSubmit', e.target.checked)}
            />
            <span>Show me the screening answers before each one is sent</span>
          </label>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, marginLeft: 28 }}>
            Screening answers are written while the employer’s form is being filled in, so they cannot
            be shown on the Review page — there is nothing to show until then. With this on, approving
            pauses at the last step and asks. Only applies to submissions you start; a scheduled scan
            never waits on it.
          </p>

          {form.reviewBeforeSubmit && (
            <div className="form-group" style={{ marginTop: 14 }}>
              <label htmlFor="set-f50">Auto-submit jobs scoring at least (%)</label>
              <input id="set-f50"
                type="number"
                min="0"
                max="100"
                placeholder="Leave empty to review everything"
                value={form.autoSubmitThreshold ?? ''}
                onChange={e => {
                  const raw = e.target.value.trim()
                  if (raw === '') return set('autoSubmitThreshold', null)
                  const n = Number(raw)
                  set('autoSubmitThreshold', Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null)
                }}
              />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                {form.autoSubmitThreshold == null
                  ? 'Empty — every draft waits for your approval.'
                  : <>Jobs at <strong>{form.autoSubmitThreshold}%</strong> or above are sent without review. Anything
                     lower, or a job that could not be scored, still waits for you.</>}
              </p>
            </div>
          )}

          {form.reviewBeforeSubmit && (
            <div className="form-group" style={{ marginTop: 14 }}>
              <label htmlFor="set-f51">Draft at most, per platform per day</label>
              <input id="set-f51"
                type="number"
                min="0"
                value={form.dailyDraftLimit ?? 20}
                onChange={e => {
                  const n = Number(e.target.value)
                  set('dailyDraftLimit', Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 20)
                }}
              />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                {Number(form.dailyDraftLimit) === 0
                  ? 'No limit — a scan will draft every job it finds above the match threshold, and pay for each one.'
                  : <>The daily limits above count applications that were <em>sent</em>, so in review mode they never
                     apply — without this, a scan drafts and pays for every listing it scrapes. Checked before the
                     scoring and tailoring spend, not after.</>}
              </p>
            </div>
          )}
        </div>

        {/* AI budget & reliability */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>AI Budget &amp; Reliability</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Each scanned job costs several model calls. The cap is checked before every call, so it
            stops work rather than reporting an overrun after the money is spent. See the Analytics
            page for what you have actually used.
          </p>
          <div className="form-group">
            <label htmlFor="set-f52">Monthly spend cap (USD)</label>
            <input id="set-f52"
              type="number" min="0" step="1"
              value={form.aiMonthlyBudgetUsd ?? 0}
              onChange={e => set('aiMonthlyBudgetUsd', Number(e.target.value) || 0)}
            />
            <small style={{ color: 'var(--text-muted)' }}>0 disables the cap. Costs are estimated from published token prices.</small>
          </div>
          <div className="form-group">
            <label htmlFor="set-f53">Retries on a failed AI call</label>
            <input id="set-f53"
              type="number" min="0" max="6"
              value={form.aiMaxRetries ?? 3}
              onChange={e => set('aiMaxRetries', Math.max(0, Math.min(6, Number(e.target.value) || 0)))}
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Retried with exponential backoff. A job that still can't be scored is left unsaved and
              retried on the next scan, rather than recorded with a guessed score.
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="set-f54">Retry budget per scan</label>
            <input id="set-f54"
              type="number" min="0" max="500"
              value={form.aiRetryBudgetPerScan ?? 20}
              onChange={e => set('aiRetryBudgetPerScan', Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Total retries allowed across one scan. The setting above bounds a single flaky
              request; this bounds a provider having a bad twenty minutes, where every job burns
              its full allowance and you are billed for each retry that succeeds. Once spent,
              calls still run — they just stop being retried. 0 removes the cap.
            </small>
          </div>
        </div>

        {/* Company career boards */}
        <AtsBoards form={form} set={set} showToast={showToast} />

        {/* The lever automation health never had: somewhere else to send the
            traffic, rather than only backing off from where it was going. */}
        <ProxySettings form={form} set={set} />

        {/* Background operation */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>Background Operation</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Scheduled scans, inbox checks, follow-ups and the stale sweep only run while Hiro is
            running. With these on, closing the window keeps it working in the tray instead of quitting.
          </p>
          {[
            { key: 'minimizeToTray', label: 'Keep running in the tray when the window is closed' },
            { key: 'launchOnLogin', label: 'Start Hiro when I log in' },
            { key: 'startMinimised', label: 'Start minimised to the tray' },
          ].map(opt => (
            <label key={opt.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" checked={!!form[opt.key]} onChange={e => set(opt.key, e.target.checked)} />
              <span>{opt.label}</span>
            </label>
          ))}
          <small style={{ color: 'var(--text-muted)' }}>
            Launch-on-login applies to the installed app only — it has no effect in a development run.
          </small>
        </div>

        {/* Recruiter contact extraction */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 6, fontSize: 15 }}>Recruiter Contact</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Auto follow-up needs an address to write to. With this on, Hiro reads one out of the job ad
            and out of any recruiter reply. Platform, no-reply and placeholder addresses are ignored,
            and an ambiguous ad yields nothing rather than a guess — you can always set it by hand in
            the job detail panel.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.extractRecruiterEmail !== false}
              onChange={e => set('extractRecruiterEmail', e.target.checked)}
            />
            <span>Find a follow-up address automatically</span>
          </label>
        </div>

        {/* Updates */}
        <UpdatePanel form={form} set={set} showToast={showToast} />
      </div>}

      {settingsTab === 'about' && <div>
        {/* About */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <HiroLogo size={48} style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>Hiro</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Version 1.0.0</div>
            </div>
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text-muted)', marginBottom: 16 }}>
            Hiro is an AI-powered desktop app that automatically finds and applies to jobs for you. It scrapes Seek, Indeed, and LinkedIn on a schedule, uses AI to score each job against your resume, tailors your application, and submits — all while you sleep.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[
              { label: 'Desktop', value: 'Electron' },
              { label: 'Frontend', value: 'React + Vite' },
              { label: 'Database', value: 'SQLite (sql.js)' },
              { label: 'Scraping', value: 'Playwright' },
              { label: 'Scheduling', value: 'node-cron' },
              { label: 'AI', value: 'Claude / GPT / DeepSeek / Gemini' },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Privacy Policy */}
        <div className="card">
          <h3 style={{ marginBottom: 16, fontSize: 15 }}>Privacy Policy</h3>
          {[
            {
              title: 'Local-only data storage',
              body: 'All your data — config, resume text, application history, session cookies — is stored exclusively on your local machine under ~/.hiro/. Nothing is uploaded to any Hiro server.',
            },
            {
              title: 'AI API calls',
              body: 'When AI features are used (resume tailoring, cover letter generation, match scoring, etc.), your resume text and job descriptions are sent to the AI provider you configured (Anthropic, OpenAI, DeepSeek, or Google). This is governed by that provider\'s own privacy policy. Hiro does not store or forward this data.',
            },
            {
              title: 'Job platforms',
              body: 'Hiro interacts with Seek, Indeed, and LinkedIn on your behalf using your saved session. Your credentials are never stored by Hiro — only the browser session state (cookies) needed to stay logged in.',
            },
            {
              title: 'Email notifications',
              body: 'If you configure Gmail notifications, your Gmail address and App Password are stored locally in your config file. Emails are sent directly via Gmail SMTP — no third-party relay is involved.',
            },
            {
              title: 'No telemetry',
              body: 'Hiro collects no analytics, crash reports, or usage data of any kind. The app operates entirely offline except for the AI API calls and job platform interactions you explicitly trigger.',
            },
          ].map(({ title, body }) => (
            <div key={title} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{title}</div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, margin: 0 }}>{body}</p>
            </div>
          ))}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Last updated: March 2026
          </p>
        </div>
      </div>} {/* end about tab */}

      {pdfModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'var(--scrim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
        }} onClick={() => setPdfModal(null)} onKeyDown={e => { if (e.key === 'Escape') setPdfModal(null) }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: '82vw', height: '92vh', display: 'flex', flexDirection: 'column',
            background: 'var(--surface)', borderRadius: 12, overflow: 'hidden',
            boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{pdfModal.title}</span>
              <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setPdfModal(null)}>✕ Close</button>
            </div>
            <iframe
              src={pdfModal.url}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title={pdfModal.title}
            />
          </div>
        </div>
      )}

      {improveModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }} onClick={() => setImproveModal(null)} onKeyDown={e => { if (e.key === 'Escape') setImproveModal(null) }}>
          <div className="card" style={{ width: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 17 }}>AI-Improved Resume</h2>
              <button className="btn btn-ghost" onClick={() => setImproveModal(null)}>✕</button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
              Review the improved version below. Replace the original or save as a new resume.
            </p>
            <textarea
              value={improveModal.text}
              onChange={e => setImproveModal(m => ({ ...m, text: e.target.value }))}
              style={{ flex: 1, minHeight: 340, marginBottom: 16, fontFamily: 'monospace', fontSize: 12 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setImproveModal(null)}>Cancel</button>
              {(form.resumes || []).length < 5 && (
                <button className="btn btn-ghost" onClick={() => {
                  const id = Date.now().toString()
                  const source = (form.resumes || []).find(r => r.id === improveModal.sourceId)
                  const resumes = [...(form.resumes || []), { id, name: `${improveModal.sourceName} (Improved)`, text: improveModal.text, originalExt: source?.originalExt || null, originalPath: source?.originalPath || null }]
                  saveResumes(resumes, form.defaultResumeId)
                  setImproveModal(null)
                }}>
                  Save as New
                </button>
              )}
              <button className="btn btn-primary" onClick={() => {
                const resumes = (form.resumes || []).map(r => {
                  if (r.id !== improveModal.sourceId) return r
                  // For PDF originals, the old file no longer reflects improved text — clear it so View PDF regenerates
                  const keepOriginal = r.originalExt === 'docx' || r.originalExt === 'doc'
                  return { ...r, text: improveModal.text, originalPath: keepOriginal ? r.originalPath : null, originalExt: keepOriginal ? r.originalExt : null }
                })
                saveResumes(resumes, form.defaultResumeId)
                setImproveModal(null)
              }}>
                Replace Original
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
