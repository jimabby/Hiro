// Splits an Ask Hiro reply into what to show as conversation and the full
// documents the assistant wrote. The assistant puts a complete résumé between
// "<<<RESUME>>>" and "<<<END>>>" lines, and a cover letter between
// "<<<COVER_LETTER>>>" and "<<<END>>>" (see services/askHiro.js, whose
// extractDrafts reads them the same way to check each one against the résumé).
//
// Returns [{ type: 'text', text }] and [{ type: 'draft', kind, text, index }]
// segments in order; `index` counts drafts, matching the order of the checks
// the main process returned. A block the model never closed runs to the end.

const OPEN = /^<<<(RESUME|COVER_LETTER)>>>$/

export function splitDrafts(content) {
  const segments = []
  let text = []
  let draft = null
  let index = 0
  const flushText = () => {
    const t = text.join('\n').trim()
    if (t) segments.push({ type: 'text', text: t })
    text = []
  }
  const flushDraft = () => {
    if (draft) {
      const body = draft.lines.join('\n').trim()
      if (body) segments.push({ type: 'draft', kind: draft.kind, text: body, index: index++ })
    }
    draft = null
  }
  for (const line of String(content || '').split('\n')) {
    const t = line.trim()
    const open = OPEN.exec(t)
    if (open) {
      flushText()
      flushDraft()
      draft = { kind: open[1] === 'RESUME' ? 'resume' : 'coverLetter', lines: [] }
      continue
    }
    if (t === '<<<END>>>') { flushDraft(); continue }
    if (draft) draft.lines.push(line)
    else text.push(line)
  }
  flushText()
  flushDraft()
  return segments
}

export function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length
}
