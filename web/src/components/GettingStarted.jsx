import { useEffect, useState } from 'react'

// The first ten minutes.
//
// A fresh install lands on a Dashboard whose only content is an empty table
// and a "Run Scan Now" button — and pressing that button with no resume, no
// AI key or no board login ends in an error toast. The wizard collects some of
// this, but two of its steps are skippable and the board logins live in
// Settings, so most first runs arrive here with something missing and nothing
// on screen saying what.
//
// This card says what. It is derived from the same config and session state
// the scan itself checks, so a tick here means that step really is done, and
// it goes away on its own once the first application exists — a checklist that
// outlives the thing it was for is furniture.

const DISMISS_KEY = 'gettingStartedDismissed'

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

// What the checklist needs to know, gathered in one place so the Dashboard
// does not have to. Every call is guarded: a build without one of these
// handlers must still render the card, just with that step unknown.
async function gather() {
  const cfg = await window.api.getConfig().catch(() => ({}))
  const status = async (fn) => {
    try { return !!(await fn?.())?.loggedIn } catch { return false }
  }
  const [seek, indeed, linkedin] = await Promise.all([
    status(window.api.seekStatus),
    status(window.api.indeedStatus),
    status(window.api.linkedinStatus),
  ])
  return { cfg: cfg || {}, sessions: { Seek: seek, Indeed: indeed, LinkedIn: linkedin } }
}

export function deriveSteps({ cfg, sessions }, hasScanned) {
  const resumes = Array.isArray(cfg.resumes) ? cfg.resumes : []
  const hasResume = resumes.length > 0 || !!String(cfg.masterResume || '').trim()

  const aiReady = cfg.aiProvider === 'local'
    ? !!(String(cfg.localAiBaseUrl || '').trim() && String(cfg.localAiModel || '').trim())
    : !!String(cfg.aiApiKey || '').trim()

  const enabled = ['Seek', 'Indeed', 'LinkedIn'].filter(p => !!cfg[`enable${p}`])
  const loggedIn = enabled.filter(p => sessions[p])
  const notLoggedIn = enabled.filter(p => !sessions[p])
  const boards = Array.isArray(cfg.atsBoards) ? cfg.atsBoards.length : 0
  const sourceReady = loggedIn.length > 0 || boards > 0

  let sourceHint
  if (sourceReady && notLoggedIn.length) sourceHint = `Not logged in to ${notLoggedIn.join(', ')} — those will be skipped.`
  else if (sourceReady) sourceHint = boards && !loggedIn.length
    ? `${boards} career board${boards === 1 ? '' : 's'} watched.`
    : `Logged in to ${loggedIn.join(', ')}.`
  else if (enabled.length) sourceHint = `${enabled.join(', ')} ${enabled.length === 1 ? 'is' : 'are'} enabled but not logged in, so a scan finds nothing.`
  else sourceHint = 'No platform is enabled and no career board is watched.'

  return [
    {
      id: 'resume', done: hasResume, page: 'settings',
      title: 'Add your resume',
      hint: hasResume
        ? `${resumes.length || 1} resume${resumes.length === 1 ? '' : 's'} on file.`
        : 'Every match score and every tailored application starts from it.',
    },
    {
      id: 'ai', done: aiReady, page: 'settings',
      title: 'Connect an AI provider',
      hint: aiReady
        ? `Using ${cfg.aiProvider === 'local' ? 'a local model' : cfg.aiProvider || 'the configured provider'}.`
        : 'Scoring and tailoring need a key, or a local model server.',
    },
    {
      id: 'source', done: sourceReady, page: 'settings',
      title: 'Log in to a job board',
      hint: sourceHint,
    },
    {
      id: 'scan', done: hasScanned, action: 'dryRun',
      title: 'Run a Test Scan',
      hint: hasScanned
        ? 'A scan has run. Real scans send applications; test scans only score and draft.'
        : 'Scores and drafts everything it finds without sending anything — the safe way to see what Hiro would do.',
    },
  ]
}

export default function GettingStarted({ hasScanned, onNavigate, onDryRun }) {
  const [state, setState] = useState(null)
  const [dismissed, setDismissed] = useState(readDismissed)

  useEffect(() => {
    let cancelled = false
    gather().then(s => { if (!cancelled) setState(s) })
    return () => { cancelled = true }
  }, [])

  if (dismissed || !state) return null

  const steps = deriveSteps(state, hasScanned)
  const remaining = steps.filter(s => !s.done).length
  // Nothing left to say once every box is ticked.
  if (remaining === 0) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* per-viewer convenience only */ }
    setDismissed(true)
  }

  return (
    <div className="card" data-testid="getting-started" style={{ marginBottom: 24, borderLeft: '3px solid var(--accent)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Getting started</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {remaining} of {steps.length} left before a scan can find and apply to anything.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={dismiss} title="Hide this checklist">Hide</button>
      </div>

      <ol style={{ listStyle: 'none', display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {steps.map((s, i) => (
          <li key={s.id} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '10px 12px', borderRadius: 'var(--radius-sm)',
            background: 'var(--surface2)', opacity: s.done ? 0.65 : 1,
          }}>
            <span aria-hidden="true" style={{
              width: 20, height: 20, borderRadius: '50%', flexShrink: 0, fontSize: 11, fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: s.done ? 'var(--green)' : 'var(--surface3)',
              color: s.done ? '#fff' : 'var(--text-muted)',
            }}>{s.done ? '✓' : i + 1}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, textDecoration: s.done ? 'line-through' : 'none' }}>
                {s.title}
                <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                  {s.done ? ' — done' : ' — to do'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{s.hint}</div>
              {!s.done && (
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
                  onClick={() => (s.action === 'dryRun' ? onDryRun?.() : onNavigate?.(s.page))}>
                  {s.action === 'dryRun' ? 'Run Test Scan' : 'Open Settings'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
