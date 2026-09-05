// Extracted from Settings.jsx, which had grown to 3,724 lines — twice the next
// largest file in the renderer, and the one the lazy-loading note in App.jsx
// singles out as "by some distance the largest and opened least often". The
// panels were already cleanly separated by concern inside it; this only gives
// each of them a file. No behaviour changed.
//
// The proxy every browser Hiro launches is routed through.

export function ProxySettings({ form, set }) {
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
