// Writing a tailored résumé back into the candidate's own DOCX.
//
// The point of keeping the original file is that it looks like the candidate's
// résumé — their font, their spacing, their bold labels and right-aligned
// dates — rather than one of Hiro's generated layouts. This used to undo that
// in two ways:
//
//   Lines were matched to paragraphs by position. One extra bullet from the
//   model shifted every line below it into the wrong paragraph: a bullet in a
//   job-title paragraph, a certification against the previous one's year, and
//   the last line dropped off the end. Now the tailored lines are aligned to
//   the paragraphs with an LCS diff (textDiff.js), so an unchanged paragraph is
//   left byte-for-byte alone, a reworded one is edited in place, an added line
//   is cloned from its neighbour, and a removed one is removed.
//
//   A reworded paragraph had its whole text poured into its first run. "Skills:"
//   in bold followed by plain text came out entirely bold, and a title<TAB>date
//   line lost its tab, so the date no longer sat on the right. Now only the
//   characters that changed are rewritten, inside the run where the change
//   starts, and tab-separated parts are edited separately around their tabs.

const { diffLines } = require('./textDiff')
const { stripMarkdown } = require('./ai/markdown')
const { stripUnprintable } = require('./textClean')

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
})
const escXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The lookaheads matter: without them <w:p also matches <w:pPr>, <w:r matches
// <w:rPr>, and <w:t matches <w:tab>, <w:tbl> and <w:tc>.
const PARA_RE = /<w:p(?=[\s>])[\s\S]*?<\/w:p>/g
const RUN_RE = /<w:r(?=[\s>])[\s\S]*?<\/w:r>/g
// A text element, an empty one, or a tab character. Only ever applied inside a
// run: the <w:tab/> elements in a paragraph's <w:tabs> are tab STOPS, not text.
const SLOT_RE = /(<w:t(?=[\s>])[^>]*>)([\s\S]*?)<\/w:t>|<w:t(?=[\s/])[^>]*\/>|<w:tab(?=[\s/])[^>]*\/>/g

// The same clean-up the importer applies (main.js resume:importFile), so a
// paragraph read straight from the XML compares equal to its imported line.
function lineKey(text) {
  return stripUnprintable(text)
    .replace(/\s*\{\{https?:\/\/[^}]+\}\}/g, '')
    .replace(/•(?=[A-Za-z0-9])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Every text slot and tab in a paragraph, in order, with its offset in the XML.
function readSlots(paraXml) {
  const slots = []
  RUN_RE.lastIndex = 0
  let run
  while ((run = RUN_RE.exec(paraXml)) !== null) {
    const inner = new RegExp(SLOT_RE.source, 'g')
    let m
    while ((m = inner.exec(run[0])) !== null) {
      const start = run.index + m.index
      const end = start + m[0].length
      if (m[0].startsWith('<w:tab')) slots.push({ kind: 'tab', start, end })
      else slots.push({ kind: 't', start, end, open: m[1] || '<w:t>', text: m[1] ? unescXml(m[2]) : '' })
    }
  }
  return slots
}

const slotsText = slots => slots.map(s => (s.kind === 'tab' ? '\t' : s.text)).join('')

// Rewrite one tab-delimited part of a paragraph: keep the common prefix and
// suffix where they are, and put the changed middle into the run where the
// change begins — so a new word after a bold "Label: " lands in the plain run.
function editSegment(textSlots, next) {
  const old = textSlots.map(s => s.text).join('')
  if (old === next) return
  if (!textSlots.length) return
  let p = 0
  const max = Math.min(old.length, next.length)
  while (p < max && old[p] === next[p]) p++
  let s = 0
  while (s < max - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++
  const delEnd = old.length - s
  const insert = next.slice(p, next.length - s)

  // The run holding the first changed character; past the end, the last run.
  let offset = 0
  let target = null
  for (const slot of textSlots) {
    const a = offset
    const len = slot.text.length
    offset += len
    if (!target && p >= a && p < a + len) target = slot
    const clamp = n => Math.max(0, Math.min(len, n))
    slot.before = slot.text.slice(0, clamp(p - a))
    slot.after = slot.text.slice(clamp(delEnd - a))
  }
  target = target || textSlots[textSlots.length - 1]
  for (const slot of textSlots) {
    slot.next = slot === target ? slot.before + insert + slot.after : slot.before + slot.after
    slot.changed = slot.next !== slot.text
  }
}

// The paragraph with its visible text replaced by `nextText`, every run, run
// property, hyperlink and tab otherwise kept.
function rewriteParagraph(paraXml, nextText) {
  const slots = readSlots(paraXml)
  const textSlots = slots.filter(s => s.kind === 't')
  if (!textSlots.length) return paraXml

  // Split both sides at the tabs. A model that turned the tab into spaces gets
  // it back if the part count then matches; otherwise the line goes in whole.
  const segments = [[]]
  for (const slot of slots) {
    if (slot.kind === 'tab') segments.push([])
    else segments[segments.length - 1].push(slot)
  }
  let parts = String(nextText).split('\t')
  if (parts.length !== segments.length) {
    const spaced = String(nextText).split(/\t| {2,}/)
    parts = spaced.length === segments.length ? spaced : [String(nextText).replace(/\t/g, ' ')]
  }

  if (parts.length === segments.length) {
    segments.forEach((seg, i) => {
      if (seg.length) editSegment(seg, parts[i])
      else if (parts[i]) {
        // A part with no run of its own (a tab with nothing after it): append to the last text before it.
        const prev = segments.slice(0, i).flat().pop()
        if (prev) editSegment([prev], (prev.next ?? prev.text) + parts[i])
      }
    })
  } else {
    editSegment(textSlots, parts[0])
  }

  let out = paraXml
  for (const slot of [...textSlots].reverse()) {
    if (!slot.changed) continue
    const open = /xml:space=/.test(slot.open) ? slot.open : slot.open.replace(/^<w:t/, '<w:t xml:space="preserve"')
    out = out.slice(0, slot.start) + `${open}${escXml(slot.next)}</w:t>` + out.slice(slot.end)
  }
  return out
}

// A copy of `paraXml` to hold an added line. IDs Word expects to be unique in
// the document — paragraph ids and bookmarks — are dropped from the copy.
function cloneParagraph(paraXml, nextText) {
  const copy = paraXml
    .replace(/\s+w14:(paraId|textId)="[^"]*"/g, '')
    .replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, '')
  return rewriteParagraph(copy, nextText)
}

// The document XML with the tailored text applied. Exported for tests.
function applyTailoring(xml, tailoredText) {
  const tailoredLines = stripMarkdown(tailoredText || '')
    .replace(/\s*\{\{https?:\/\/[^}]+\}\}/g, '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim())

  const paras = []
  PARA_RE.lastIndex = 0
  let m
  while ((m = PARA_RE.exec(xml)) !== null) {
    const text = slotsText(readSlots(m[0]))
    if (text.trim()) paras.push({ start: m.index, end: m.index + m[0].length, xml: m[0], key: lineKey(text) })
  }
  if (!paras.length) throw new Error('Invalid DOCX: no text paragraphs')

  const diff = diffLines(paras.map(p => p.key).join('\n'), tailoredLines.map(lineKey).join('\n'))

  // Per paragraph: replacement XML (null = delete) and paragraphs to insert after it.
  const replace = new Map()
  const insertAfter = new Map()
  const queue = (idx, x) => insertAfter.set(idx, [...(insertAfter.get(idx) || []), x])

  let i = 0
  let j = 0
  let k = 0
  while (k < diff.length) {
    if (diff[k].type === 'same') { i++; j++; k++; continue }
    const removed = []
    const added = []
    while (k < diff.length && diff[k].type !== 'same') {
      if (diff[k].type === 'removed') removed.push(i++)
      else added.push(j++)
      k++
    }
    const pairs = Math.min(removed.length, added.length)
    for (let n = 0; n < pairs; n++) replace.set(removed[n], rewriteParagraph(paras[removed[n]].xml, tailoredLines[added[n]]))
    // Lines the model dropped. The paragraph holding the section properties
    // carries the page layout and is emptied, never deleted.
    for (const idx of removed.slice(pairs)) {
      replace.set(idx, /<w:sectPr\b/.test(paras[idx].xml) ? rewriteParagraph(paras[idx].xml, '') : null)
    }
    // Lines the model added, cloned from the paragraph they follow (-1: before
    // the first). When lines are added, every removed one was paired, so the
    // last removed paragraph is still there to follow.
    const anchor = removed.length ? removed[removed.length - 1] : i - 1
    const template = paras[Math.max(anchor, 0)].xml
    for (const lineIdx of added.slice(pairs)) {
      queue(anchor, cloneParagraph(template, tailoredLines[lineIdx]).replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, ''))
    }
  }

  let out = ''
  let cursor = 0
  paras.forEach((p, idx) => {
    out += xml.slice(cursor, p.start)
    if (idx === 0) out += (insertAfter.get(-1) || []).join('')
    const r = replace.has(idx) ? replace.get(idx) : p.xml
    if (r !== null) out += r
    out += (insertAfter.get(idx) || []).join('')
    cursor = p.end
  })
  return out + xml.slice(cursor)
}

module.exports = { applyTailoring, rewriteParagraph, lineKey }
