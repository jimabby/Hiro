// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// Which mail servers an address actually resolves to, shown as it is typed.

import { useEffect, useState } from 'react'

export function MailServers({ form, set }) {
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
