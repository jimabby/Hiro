// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// The handful of facts every application form asks for, answered from what the
// user told Hiro rather than from a model call.

import { useEffect, useState } from 'react'

export function ApplicationProfile({ form, set }) {
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
