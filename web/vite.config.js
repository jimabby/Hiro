import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer talks to the main process exclusively over IPC and makes no
// network requests of its own, so the shipped page can afford a very strict
// policy: no remote script, no remote connections, no plugins, no framing.
//
// Injected at build time rather than written into index.html directly, because
// the dev server needs 'unsafe-inline'/'unsafe-eval' and a websocket for HMR —
// baking those into the source file would ship them to users.
//
// `style-src 'unsafe-inline'` is the one concession: React sets element style
// attributes, which CSP counts as inline styles. It carries none of the script
// execution risk that makes 'unsafe-inline' dangerous for script-src.
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

function injectCsp() {
  return {
    name: 'hiro-inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), injectCsp()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
})
