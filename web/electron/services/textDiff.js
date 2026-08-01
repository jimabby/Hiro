// Line diff between a base resume and the tailored version the AI produced.
//
// The point is accountability, not pretty output: when an application goes
// wrong, "what did the model actually change about me?" is the first question,
// and eyeballing two 600-line documents side by side does not answer it. A
// tailoring pass that quietly invented a job title or dropped a decade of work
// should be one glance away.
//
// Standard LCS. Documents here are hundreds of lines, not millions, so the
// O(n·m) table is fine — but not unbounded: a pathological pair would allocate
// a table big enough to matter in a desktop app, so oversized inputs fall back
// to a whole-document replacement rather than freezing the UI.

const MAX_CELLS = 4_000_000 // ~2000×2000 lines

function splitLines(text) {
  if (typeof text !== 'string' || text === '') return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

// Longest common subsequence table over two line arrays.
function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

// Diff two documents into a flat list of { type, line } where type is
// 'same' | 'added' | 'removed'. Order is preserved so the result reads as a
// patch top to bottom.
function diffLines(base, tailored) {
  const a = splitLines(base)
  const b = splitLines(tailored)

  if (a.length === 0 && b.length === 0) return []
  if (a.length === 0) return b.map(line => ({ type: 'added', line }))
  if (b.length === 0) return a.map(line => ({ type: 'removed', line }))

  // Too large to diff line-by-line without a noticeable stall. Report it as a
  // wholesale rewrite, which is honest, rather than pretending to be precise.
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map(line => ({ type: 'removed', line })),
      ...b.map(line => ({ type: 'added', line })),
    ]
  }

  const table = lcsTable(a, b)
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', line: a[i] })
      i++; j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'removed', line: a[i] })
      i++
    } else {
      out.push({ type: 'added', line: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ type: 'removed', line: a[i++] })
  while (j < b.length) out.push({ type: 'added', line: b[j++] })
  return out
}

// Counts for a one-line summary, so the UI can say "12 added, 3 removed"
// without walking the diff itself.
function diffSummary(diff) {
  let added = 0
  let removed = 0
  for (const part of diff) {
    if (part.type === 'added') added++
    else if (part.type === 'removed') removed++
  }
  return { added, removed, unchanged: diff.length - added - removed }
}

module.exports = { diffLines, diffSummary, splitLines }
