import { Component } from 'react'

// The bug this exists for.
//
// React unmounts the entire tree when a render throws and nothing catches it.
// This app renders every page inside one shell, so a single bad row on a single
// page took down the sidebar, the nav, the toasts and every other page with it
// — the window went blank, with no message, and the only way back was quitting
// and reopening. It is reproducible today: Pipeline's useMemo defends with
// `data?.items || []` but the render body below then reads `data.items.length`
// straight, so any pipeline payload missing that key blanks the whole app.
//
// A boundary per page rather than one around the shell, deliberately. Wrapping
// the shell would keep the process alive but still replace the entire UI with
// an error card. Wrapping each page means a page that cannot render says so in
// its own column, while the sidebar, the scan controls and the other nine pages
// keep working — which matters here, because this app runs unattended and the
// thing it is holding is the user's record of every job they have applied for.
//
// Deliberately not a toast: a toast is dismissible and time-limited, and this
// state persists until the data or the code changes.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // The renderer's console is not visible in a packaged build, so send this
    // to the activity log the user can actually open. Guarded because the whole
    // point of this component is running when other things are broken.
    try {
      window.api?.logRendererError?.({
        page: this.props.name,
        message: String(error?.message || error),
        stack: String(error?.stack || ''),
        componentStack: String(info?.componentStack || ''),
      })
    } catch { /* nothing useful left to do */ }
    console.error(`[${this.props.name}]`, error, info?.componentStack)
  }

  // Re-mounting is worth offering because most of these are transient: a row
  // that failed to parse is usually fixed by the next scan or by editing it
  // somewhere else in the app.
  retry = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="card" role="alert" style={{ borderLeft: '3px solid var(--red)' }}>
        <h2 style={{ fontSize: 15, marginBottom: 6 }}>
          The {this.props.name} page couldn’t be displayed
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Nothing has been lost — this is a display problem, not a data one. The rest
          of Hiro is still running, and scans, follow-ups and inbox checks are unaffected.
        </p>
        <pre style={{
          background: 'var(--bg-subtle)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', padding: '10px 12px',
          fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 12,
        }}>{String(this.state.error?.message || this.state.error)}</pre>
        <button className="btn btn-primary" onClick={this.retry}>Try again</button>
      </div>
    )
  }
}
