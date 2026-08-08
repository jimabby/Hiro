// Conservative last-mile guard for facts an AI must never invent in a resume.
// It examines only added diff lines and reports newly introduced dates, formal
// credentials, employment-style job titles, and employer-attribution phrases.

const { diffLines } = require('./textDiff')

const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:19|20)?\d{2}\b/gi
const CREDENTIAL_RE = /\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d\.?|mba|bsc|msc|degree|diploma|certificate|certified|certification|licen[cs](?:e|ed)|cpa|cfa|pmp|aws certified|security\+|cissp)\b/gi
const TITLE_RE = /\b(?:engineer|developer|architect|analyst|consultant|manager|director|officer|specialist|designer|administrator|coordinator|lead|head|president|founder|scientist|accountant|recruiter)\b/i
const EMPLOYMENT_RE = /^\s*(.{2,80}?)\s+(?:at|@|—|–|\|)\s+(.{2,80}?)\s*$/

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()
}

function uniqueMatches(text, re) {
  return [...new Set(String(text || '').match(re) || [])]
}

function inspectTailoring(baseResume, tailoredResume) {
  if (!baseResume || !tailoredResume || baseResume === tailoredResume) return { safe: true, flags: [] }
  const base = normalize(baseResume)
  const flags = []
  const additions = diffLines(baseResume, tailoredResume).filter(p => p.type === 'added').map(p => p.line.trim()).filter(Boolean)

  for (const line of additions) {
    for (const value of uniqueMatches(line, DATE_RE)) {
      if (!base.includes(normalize(value))) flags.push({ kind: 'date', value, line })
    }
    for (const value of uniqueMatches(line, CREDENTIAL_RE)) {
      if (!base.includes(normalize(value))) flags.push({ kind: 'credential', value, line })
    }
    const employment = EMPLOYMENT_RE.exec(line)
    if (employment) {
      const left = employment[1].trim()
      const right = employment[2].trim()
      if (TITLE_RE.test(left) && !base.includes(normalize(left))) flags.push({ kind: 'job-title', value: left, line })
      if (!base.includes(normalize(right))) flags.push({ kind: 'employer', value: right, line })
    }
  }

  const deduped = flags.filter((flag, i) => flags.findIndex(f => f.kind === flag.kind && normalize(f.value) === normalize(flag.value)) === i)
  return { safe: deduped.length === 0, flags: deduped }
}

function describeFlags(flags) {
  return flags.map(f => `${f.kind}: ${f.value}`).join('; ')
}

module.exports = { inspectTailoring, describeFlags }
