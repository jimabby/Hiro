import { createElement, Fragment } from 'react'

// A practice answer, rendered without ever handing HTML to the DOM.
//
// Bank answers are written in a small HTML subset (paragraphs, lists, bold,
// italic, code). The bank is data that will later be downloaded, so it is not
// trusted: the text is parsed into an inert document (DOMParser runs no scripts
// and loads no images), then rebuilt as React elements tag by tag. Only the
// tags below survive, with no attributes at all; anything else keeps its text
// and loses its element, except script-like elements, which are dropped whole.
//
// Job-deck answers are plain text from a model and are shown as paragraphs.

const ALLOWED = new Set(['p', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'code', 'pre', 'br'])
const DROP = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math'])

function rebuild(node, key) {
  if (node.nodeType === 3) return node.textContent
  if (node.nodeType !== 1) return null
  const tag = node.tagName.toLowerCase()
  if (DROP.has(tag)) return null
  if (tag === 'br') return createElement('br', { key })
  const children = Array.from(node.childNodes).map((c, i) => rebuild(c, i)).filter(c => c !== null && c !== '')
  if (!ALLOWED.has(tag)) return children.length ? createElement(Fragment, { key }, ...children) : null
  return createElement(tag, { key }, ...children)
}

export function sanitizeAnswer(html) {
  if (typeof DOMParser === 'undefined') return [String(html || '')]
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  return Array.from(doc.body.childNodes).map((n, i) => rebuild(n, i)).filter(c => c !== null && c !== '')
}

export default function SafeAnswer({ answer, format = 'html' }) {
  if (format === 'text') {
    const paras = String(answer || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
    return (
      <div className="practice-answer">
        {paras.length ? paras.map((p, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)
          : <p style={{ color: 'var(--text-muted)' }}>No sample answer yet. Write your own in the application&apos;s interview prep.</p>}
      </div>
    )
  }
  return <div className="practice-answer">{sanitizeAnswer(answer)}</div>
}
