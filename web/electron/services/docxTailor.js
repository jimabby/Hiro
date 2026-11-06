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
//
// Text boxes. Two-column résumé templates put the sidebar in a text box, which
// holds whole paragraphs INSIDE a paragraph. Paragraphs were found with a regex
// that cannot nest, so the outer match ended at the first inner </w:p>, and
// removing that "paragraph" left a dangling </w:p> — a file Word will not open,
// uploaded to the employer. The document is now parsed for nesting: each
// paragraph owns only the text outside its children, a paragraph holding a
// text box is emptied rather than deleted, and a text box or table cell always
// keeps at least one paragraph (Word requires one). Word stores each text box
// twice — a modern copy (mc:Choice) and a legacy one (mc:Fallback). Mammoth,
// the importer, reads the legacy one and Word displays the modern one, so the
// modern one is edited and then copied over the legacy one.

const { diffLines } = require('./textDiff')
const { stripMarkdown } = require('./ai/markdown')
const { stripUnprintable } = require('./textClean')

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
})
const escXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The lookaheads matter: without them <w:r matches <w:rPr>, and <w:t matches
// <w:tab>, <w:tbl> and <w:tc>.
const RUN_RE = /<w:r(?=[\s>])[\s\S]*?<\/w:r>/g
// A text element, an empty one, or a tab character. The <w:tab/> elements in a
// paragraph's <w:tabs> are tab STOPS, not text: they carry w:pos, a run's tab
// character never does.
const SLOT_RE = /(<w:t(?=[\s>])[^>]*>)([\s\S]*?)<\/w:t>|<w:t(?=[\s/])[^>]*\/>|<w:tab(?=[\s/])[^>]*\/>/g
const isTabStop = tag => /\bw:pos=/.test(tag)

// The same clean-up the importer applies (main.js resume:importFile), so a
// paragraph read straight from the XML compares equal to its imported line.
function lineKey(text) {
  return stripUnprintable(text)
    .replace(/\s*\{\{https?:\/\/[^}]+\}\}/g, '')
    .replace(/•(?=[A-Za-z0-9])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function slotFrom(m, offset) {
  const start = offset + m.index
  const end = start + m[0].length
  if (m[0].startsWith('<w:tab')) return isTabStop(m[0]) ? null : { kind: 'tab', start, end }
  return { kind: 't', start, end, open: m[1] || '<w:t>', text: m[1] ? unescXml(m[2]) : '' }
}

// Every text slot and tab in a single (leaf) paragraph's XML, in order.
function readSlots(paraXml) {
  const slots = []
  RUN_RE.lastIndex = 0
  let run
  while ((run = RUN_RE.exec(paraXml)) !== null) {
    const inner = new RegExp(SLOT_RE.source, 'g')
    let m
    while ((m = inner.exec(run[0])) !== null) {
      const slot = slotFrom(m, run.index)
      if (slot) slots.push(slot)
    }
  }
  return slots
}

const slotsText = slots => slots.map(s => (s.kind === 'tab' ? '\t' : s.text)).join('')

// Rewrite one tab-delimited part of a paragraph: keep the common prefix and
// suffix where they are, and put the changed middle into the run where the
// change begins — so a new word after a bold "Label: " lands in the plain run.
function editSegment(textSlots, next) {
  const old = textSlots.map(s => s.next ?? s.text).join('')
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
  const parts = textSlots.map((slot) => {
    const cur = slot.next ?? slot.text
    const a = offset
    const len = cur.length
    offset += len
    if (!target && p >= a && p < a + len) target = slot
    const clamp = n => Math.max(0, Math.min(len, n))
    return { slot, before: cur.slice(0, clamp(p - a)), after: cur.slice(clamp(delEnd - a)) }
  })
  target = target || textSlots[textSlots.length - 1]
  for (const { slot, before, after } of parts) {
    slot.next = slot === target ? before + insert + after : before + after
    slot.changed = slot.next !== slot.text
  }
}

// The edits that give `slots` the visible text `nextText`, every run, run
// property, hyperlink and tab otherwise kept. Positions are the slots' own.
function slotEdits(slots, nextText) {
  const textSlots = slots.filter(s => s.kind === 't')
  if (!textSlots.length) return []

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

  return textSlots.filter(s => s.changed).map((slot) => {
    const open = /xml:space=/.test(slot.open) ? slot.open : slot.open.replace(/^<w:t/, '<w:t xml:space="preserve"')
    return { start: slot.start, end: slot.end, text: `${open}${escXml(slot.next)}</w:t>` }
  })
}

// Apply non-overlapping edits ({start, end, text}) to a string.
function applyEdits(str, edits) {
  let out = str
  // Later positions first, so earlier offsets stay valid. At one position, a
  // replacement goes before an insertion queued at its end.
  const sorted = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.i - a.i)
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

// A single paragraph with its visible text replaced.
function rewriteParagraph(paraXml, nextText) {
  return applyEdits(paraXml, slotEdits(readSlots(paraXml), nextText))
}

// A copy of `paraXml` to hold an added line. IDs Word expects to be unique in
// the document — paragraph ids and bookmarks — are dropped from the copy.
function cloneParagraph(paraXml, nextText) {
  const copy = paraXml
    .replace(/\s+w14:(paraId|textId)="[^"]*"/g, '')
    .replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, '')
  return rewriteParagraph(copy, nextText).replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, '')
}

// ─── Structure ───────────────────────────────────────────────────
// Just the elements whose nesting matters, as a tree with offsets.
const TAG_RE = /<(\/?)(w:p|w:tc|w:txbxContent|w:body|w:hdr|w:ftr|mc:AlternateContent|mc:Choice|mc:Fallback)(?=[\s>/])[^>]*?(\/?)>/g

function parseTree(xml) {
  const root = { name: '#root', start: 0, end: xml.length, children: [], parent: null }
  let cur = root
  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [tag, closing, name, selfClosing] = m
    if (closing) {
      // Close back to the matching element; a malformed file is refused below.
      let n = cur
      while (n !== root && n.name !== name) n = n.parent
      if (n === root) throw new Error(`Invalid DOCX: unexpected </${name}>`)
      n.end = m.index + tag.length
      cur = n.parent
      continue
    }
    const node = { name, start: m.index, end: null, children: [], parent: cur }
    cur.children.push(node)
    if (selfClosing) node.end = m.index + tag.length
    else cur = node
  }
  if (cur !== root) throw new Error(`Invalid DOCX: <${cur.name}> is never closed`)
  return root
}

function walk(node, fn) {
  for (const child of node.children) {
    if (fn(child) === false) continue
    walk(child, fn)
  }
}

const hasChildParagraph = node => { let found = false; walk(node, (n) => { if (n.name === 'w:p') found = true }); return found }
// The element a paragraph belongs to, for "never leave it empty".
function containerOf(p) {
  for (let n = p.parent; n; n = n.parent) if (n.name !== 'mc:AlternateContent' && n.name !== 'mc:Choice' && n.name !== 'w:p') return n
  return null
}

// Paragraphs in reading order — a paragraph, then the text boxes inside it,
// which is the order the importer reads them — leaving out the legacy copies.
function paragraphsOf(root) {
  const out = []
  walk(root, (n) => {
    if (n.name === 'mc:Fallback') return false
    if (n.name === 'w:p') out.push(n)
  })
  return out
}

// Every text slot in the document outside legacy copies, given to the
// innermost paragraph that contains it.
function assignSlots(xml, paras, root) {
  const fallbacks = []
  walk(root, (n) => { if (n.name === 'mc:Fallback') fallbacks.push(n) })
  const inFallback = pos => fallbacks.some(f => pos >= f.start && pos < f.end)
  const owned = new Map(paras.map(p => [p, []]))
  const re = new RegExp(SLOT_RE.source, 'g')
  let m
  while ((m = re.exec(xml)) !== null) {
    const slot = slotFrom(m, 0)
    if (!slot || inFallback(slot.start)) continue
    let owner = null
    for (const p of paras) {
      if (slot.start >= p.start && slot.end <= p.end && (!owner || p.start > owner.start)) owner = p
    }
    if (owner) owned.get(owner).push(slot)
  }
  return owned
}

// Word displays mc:Choice; mammoth and older readers use mc:Fallback. After
// editing, each fallback text box is given the edited modern text box's
// paragraphs, so both readers see the same résumé.
function syncFallbacks(xml) {
  const root = parseTree(xml)
  const edits = []
  walk(root, (n) => {
    if (n.name !== 'mc:AlternateContent') return
    const boxesIn = (node) => { const b = []; walk(node, (c) => { if (c.name === 'w:txbxContent') { b.push(c); return false } }); return b }
    const choice = n.children.find(c => c.name === 'mc:Choice')
    const fallback = n.children.find(c => c.name === 'mc:Fallback')
    if (!choice || !fallback) return
    const modern = boxesIn(choice)
    const legacy = boxesIn(fallback)
    if (!modern.length || modern.length !== legacy.length) return
    modern.forEach((box, i) => {
      const inner = b => xml.slice(xml.indexOf('>', b.start) + 1, b.end - '</w:txbxContent>'.length)
      const want = inner(box)
      if (inner(legacy[i]) !== want) {
        const from = xml.indexOf('>', legacy[i].start) + 1
        edits.push({ start: from, end: legacy[i].end - '</w:txbxContent>'.length, text: want })
      }
    })
    return false
  })
  return edits.length ? applyEdits(xml, edits) : xml
}

// A file Word cannot open must never be uploaded: paragraphs balance, and no
// table cell or text box is left without a paragraph.
function assertWellFormed(xml) {
  const count = re => (xml.match(re) || []).length
  if (count(/<w:p(?=[\s>])/g) !== count(/<\/w:p>/g)) throw new Error('Tailored DOCX would be malformed')
  const root = parseTree(xml)
  walk(root, (n) => {
    if ((n.name === 'w:tc' || n.name === 'w:txbxContent') && !n.children.some(c => c.name === 'w:p' || hasChildParagraph(c))) {
      throw new Error(`Tailored DOCX would leave an empty ${n.name === 'w:tc' ? 'table cell' : 'text box'}`)
    }
  })
}

// The document XML with the tailored text applied. Exported for tests.
function applyTailoring(xml, tailoredText) {
  const tailoredLines = stripMarkdown(tailoredText || '')
    .replace(/\s*\{\{https?:\/\/[^}]+\}\}/g, '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim())

  const root = parseTree(xml)
  const allParas = paragraphsOf(root)
  const slotsOf = assignSlots(xml, allParas, root)
  const paras = allParas
    .map(node => ({ node, slots: slotsOf.get(node), xml: xml.slice(node.start, node.end) }))
    .map(p => ({ ...p, key: lineKey(slotsText(p.slots)) }))
    .filter(p => slotsText(p.slots).trim())
  if (!paras.length) throw new Error('Invalid DOCX: no text paragraphs')

  const diff = diffLines(paras.map(p => p.key).join('\n'), tailoredLines.map(lineKey).join('\n'))

  const edits = []
  const deleted = new Set()
  // Paragraphs left in each container, so the last one is emptied, not deleted.
  const remaining = new Map()
  for (const p of allParas) {
    const c = containerOf(p)
    remaining.set(c, (remaining.get(c) || 0) + 1)
  }
  const removeParagraph = (p) => {
    const c = containerOf(p.node)
    const holdsOthers = hasChildParagraph(p.node)
    const keepsLayout = /<w:sectPr\b/.test(p.xml)
    if (holdsOthers || keepsLayout || (remaining.get(c) || 0) <= 1) {
      edits.push(...slotEdits(p.slots, ''))
      return
    }
    remaining.set(c, remaining.get(c) - 1)
    deleted.add(p)
    edits.push({ start: p.node.start, end: p.node.end, text: '' })
  }
  // An added line copies a plain paragraph — never one holding a text box.
  const templateNear = (idx) => {
    const leaf = i => paras[i] && !hasChildParagraph(paras[i].node) ? paras[i] : null
    for (let d = 0; d < paras.length; d++) {
      const found = leaf(idx - d) || leaf(idx + d)
      if (found) return found
    }
    return null
  }

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
    for (let n = 0; n < pairs; n++) edits.push(...slotEdits(paras[removed[n]].slots, tailoredLines[added[n]]))
    // Lines the model dropped.
    for (const idx of removed.slice(pairs)) removeParagraph(paras[idx])
    // Lines the model added, after the paragraph they follow (before the first
    // when they lead). When lines are added, every removed one was paired, so
    // the last removed paragraph is still there to follow.
    if (added.length > pairs) {
      const anchorIdx = removed.length ? removed[removed.length - 1] : i - 1
      const template = templateNear(Math.max(anchorIdx, 0))
      if (!template) throw new Error('Invalid DOCX: no paragraph to copy for an added line')
      const at = anchorIdx < 0 ? paras[0].node.start : paras[anchorIdx].node.end
      const text = added.slice(pairs).map(lineIdx => cloneParagraph(template.xml, tailoredLines[lineIdx])).join('')
      edits.push({ start: at, end: at, text })
    }
  }

  const out = syncFallbacks(applyEdits(xml, edits))
  assertWellFormed(out)
  return out
}

module.exports = { applyTailoring, rewriteParagraph, lineKey }
