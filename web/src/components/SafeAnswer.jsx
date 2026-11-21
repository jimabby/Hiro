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
// Everything a model wrote (job-deck answers, generated decks, Ask AI replies)
// arrives already converted to text blocks by the main process
// (practiceCore.markdownBlocks) and is drawn by TextBlocks — as text, so
// nothing in it can become markup either.

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

function Spans({ spans, inPre }) {
  return spans.map((s, i) => {
    let el = s.text
    if (s.code && !inPre) el = <code key={`c${i}`}>{el}</code>
    if (s.italic) el = <em key={`i${i}`}>{el}</em>
    if (s.bold) el = <strong key={`b${i}`}>{el}</strong>
    return <Fragment key={i}>{el}</Fragment>
  })
}

// Blocks: [{ type: 'p' | 'li' | 'pre', marker?, spans: [{ text, bold?, italic?, code? }] }].
// Consecutive list items are grouped into one list.
export function TextBlocks({ blocks, empty = null }) {
  if (!Array.isArray(blocks) || !blocks.length) return empty
  const out = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'li') {
      const items = []
      const ordered = /^\d/.test(b.marker || '')
      while (i < blocks.length && blocks[i].type === 'li') { items.push(blocks[i]); i++ }
      i--
      const List = ordered ? 'ol' : 'ul'
      out.push(<List key={i}>{items.map((it, j) => <li key={j}><Spans spans={it.spans} /></li>)}</List>)
    } else if (b.type === 'pre') {
      out.push(<pre key={i}><code><Spans spans={b.spans} inPre /></code></pre>)
    } else {
      out.push(<p key={i}><Spans spans={b.spans} /></p>)
    }
  }
  return out
}

export default function SafeAnswer({ answer, format = 'html', blocks }) {
  if (format !== 'html') {
    const list = blocks || String(answer || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).map(text => ({ type: 'p', spans: [{ text }] }))
    return (
      <div className="practice-answer">
        <TextBlocks blocks={list} empty={<p style={{ color: 'var(--text-muted)' }}>No sample answer yet. Write your own in the application&apos;s interview prep, or ask the AI.</p>} />
      </div>
    )
  }
  return <div className="practice-answer">{sanitizeAnswer(answer)}</div>
}
