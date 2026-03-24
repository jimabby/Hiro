const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min) + min)
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function humanType(_page, element, text) {
  await element.click()
  await randomDelay(100, 300)
  for (const char of text) {
    await element.type(char, { delay: Math.floor(Math.random() * 80 + 30) })
    // Occasional longer pause as if thinking
    if (Math.random() < 0.03) await randomDelay(300, 800)
  }
}

function stripMarkdown(text) {
  return (text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\*\s+/gm, '- ')
    .replace(/^-{3,}\s*$/gm, '').trim()
}

async function buildResumePDF(tailoredResume, candidateName, personalLinks) {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const PDFDocument = require('pdfkit')

  const safeName = (candidateName || 'Resume').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
  const tempPath = path.join(os.tmpdir(), `Resume - ${safeName}.pdf`)
  const text = stripMarkdown(tailoredResume || '')
  // Remove trailing blank / bullet-only lines so they don't trigger an extra empty page
  const lines = text.split('\n')
  while (lines.length) {
    const last = lines[lines.length - 1].trim()
    if (!last || /^[-•*]\s*$/.test(last)) lines.pop()
    else break
  }

  const ML = 54, MR = 54, CW = 595 - ML - MR  // A4 width 595pt
  const NAVY  = '#1E3A5F'
  const BLUE  = '#2563EB'
  const BODY  = '#111827'
  const GREY  = '#6B7280'
  const LGREY = '#9CA3AF'

  function isSectionHeader(t) {
    return t.length >= 3 && /^[A-Z][A-Z\s\/&\-]{2,}$/.test(t)
  }

  // Detect "Company/Role   Date Range" lines — require 2+ spaces before date
  function splitDateLine(t) {
    const m = t.match(/^(.+?)\s{2,}(.+)$/)
    if (m && /\b(19|20)\d{2}\b|present|current/i.test(m[2])) {
      return { left: m[1].trim(), right: m[2].trim() }
    }
    return null
  }

  // Detect standalone date lines like "March 2026 – Present", "September 2024 – December 2024"
  function isDateOnlyLine(t) {
    return t.length < 55 && /\b(19|20)\d{2}\b/.test(t) && /[-–—]|\bto\b/i.test(t) && !/^[-•*]\s/.test(t)
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: ML, autoFirstPage: true })
    const stream = fs.createWriteStream(tempPath)
    doc.pipe(stream)

    let idx = 0
    while (idx < lines.length && !lines[idx].trim()) idx++

    // ── Name ─────────────────────────────────────────────────────────
    if (idx < lines.length) {
      doc.fontSize(24).font('Helvetica-Bold').fillColor(NAVY)
        .text(lines[idx++].trim(), ML, doc.y, { align: 'center', width: CW })
      doc.moveDown(0.15)
    }

    // ── Contact info (email / phone / links / location / pipe-separated) ──
    // Collect ALL short lines between the name and the first section header.
    // Stop only when we hit: a section header, a long prose line (>65 chars),
    // or a line that looks like a job title (after at least one item collected).
    const JOB_TITLE_RE = /\b(engineer|developer|analyst|designer|manager|architect|consultant|programmer|director|specialist|coordinator|officer|scientist)\b/i
    const contactParts = []
    while (idx < lines.length) {
      const l = lines[idx].trim()
      if (!l) { idx++; continue }
      if (isSectionHeader(l)) break
      if (l.length > 65) break
      if (contactParts.length > 0 && JOB_TITLE_RE.test(l)) break
      contactParts.push(l.replace(/\s*\|\s*/g, '  |  '))
      idx++
      if (contactParts.length >= 7) break
    }
    if (contactParts.length) {
      const URL_EMBED_RE = /\{\{(https?:\/\/[^}]+)\}\}/g
      const URL_EMBED_RE_SINGLE = /\{\{(https?:\/\/[^}]+)\}\}/
      const pl = personalLinks || {}

      // Flatten contact parts into individual items
      const items = []
      for (const part of contactParts) {
        for (const sub of part.split(/\s*\|\s*/)) {
          if (sub.trim()) items.push(sub.trim())
        }
      }

      // Resolve URLs: settings links override DOCX-embedded links
      const segments = []
      for (let i = 0; i < items.length; i++) {
        let item = items[i]
        const lt = item.toLowerCase()
        let url = null

        // Check settings links first (they take priority)
        if (lt.includes('portfolio') && pl.portfolio) url = pl.portfolio
        else if ((lt.includes('github') || lt.includes('git')) && pl.github) url = pl.github
        else if (lt.includes('linkedin') && pl.linkedin) url = pl.linkedin

        // Fall back to DOCX-embedded {{url}} if no settings link
        if (!url) {
          const em = item.match(URL_EMBED_RE_SINGLE)
          if (em) url = em[1]
        }

        // Strip {{url}} markers from display text
        const displayText = item.replace(URL_EMBED_RE, '').trim()
        segments.push({ text: displayText, url })
        if (i < items.length - 1) segments.push({ text: '   |   ', url: null })
      }

      const hasLinks = segments.some(s => s.url)
      if (hasLinks) {
        doc.fontSize(9.5).font('Helvetica')
        const totalW = segments.reduce((w, s) => w + doc.widthOfString(s.text), 0)
        const sx = ML + Math.max(0, (CW - totalW) / 2)
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i], last = i === segments.length - 1
          doc.fillColor(s.url ? BLUE : GREY)
          const opts = last ? {} : { continued: true }
          if (s.url) opts.link = s.url
          if (i === 0) doc.text(s.text, sx, doc.y, opts)
          else doc.text(s.text, opts)
        }
      } else {
        doc.fontSize(9.5).font('Helvetica').fillColor(GREY)
          .text(items.join('   |   '), ML, doc.y, { align: 'center', width: CW })
      }
      doc.moveDown(0.3)
    }

    // ── Full-width divider ────────────────────────────────────────────
    doc.moveTo(ML, doc.y).lineTo(ML + CW, doc.y).strokeColor(BLUE).lineWidth(1.8).stroke()
    doc.moveDown(0.55)

    // ── Body ──────────────────────────────────────────────────────────
    // Every line in these sections gets a bullet
    const AUTO_BULLET_RE  = /^(SKILL|CERTIF|QUALIF|AWARD|ACHIEVEMENT|LANGUAGE|INTEREST|REFERENCE|HONOR|PUBLICAT|VOLUNTEER|ACTIVIT)/i
    // Only the FIRST line of each entry (school name) gets a bullet; rest are indented sub-lines
    const ENTRY_BULLET_RE = /^(EDUCAT|TRAINING|COURSE)/i
    let autoBullet  = false
    let entryBullet = false   // education-style: bullet first line, indent the rest
    let entryStart  = false   // true = next non-blank line is the start of a new entry
    let afterDateLine = false   // true = next plain line is company/location sub-line
    let firstEntryInSection = true

    // Safety margin: if cursor is within 40pt of page bottom, start a new page
    // so content (bullet + text, header + rule) isn't split across pages.
    const PAGE_BOTTOM_LIMIT = () => doc.page.height - (doc.page.margins ? doc.page.margins.bottom : ML) - 40

    while (idx < lines.length) {
      // Strip any remaining {{url}} markers from body lines (contact section already handled them)
      const t = lines[idx++].trim().replace(/\s*\{\{https?:\/\/[^}]+\}\}/g, '')

      if (!t) {
        if (entryBullet) entryStart = true  // blank line = new entry coming next
        doc.moveDown(0.25)
        continue
      }

      // Prevent orphaned content — ensure room before rendering anything
      if (doc.y > PAGE_BOTTOM_LIMIT()) doc.addPage()

      // Section header (ALL CAPS)
      if (isSectionHeader(t)) {
        autoBullet  = AUTO_BULLET_RE.test(t)
        entryBullet = ENTRY_BULLET_RE.test(t)
        entryStart  = entryBullet
        if (entryBullet) autoBullet = false
        afterDateLine = false
        firstEntryInSection = true
        doc.moveDown(0.5)
        doc.fontSize(10.5).font('Helvetica-Bold').fillColor(NAVY)
          .text(t, ML, doc.y, { align: 'center', width: CW })
        const ry = doc.y + 2
        doc.moveTo(ML, ry).lineTo(ML + CW, ry).strokeColor(BLUE).lineWidth(0.5).stroke()
        doc.moveDown(0.4)
        continue
      }

      // Skip lone bullet markers (just "•", "-", "*" with no text)
      if (/^[-•*]\s*$/.test(t)) continue

      const INDENT = 14
      const isExplicitBullet = /^[-•*]\s/.test(t)

      // Education sub-lines (degree, date) — indented, smaller, grey, no bullet
      if (entryBullet && !entryStart && !isExplicitBullet) {
        doc.fontSize(9.5).font('Helvetica').fillColor(GREY)
          .text(t, ML + INDENT, doc.y, { width: CW - INDENT, lineGap: 1 })
        doc.moveDown(0.05)
        continue
      }

      // Company/location sub-line right after a role+date line
      if (afterDateLine && !isExplicitBullet && !isSectionHeader(t)) {
        afterDateLine = false
        doc.fontSize(9.5).font('Helvetica-Oblique').fillColor(GREY)
          .text(t, ML, doc.y, { width: CW, lineGap: 1 })
        doc.moveDown(0.12)
        continue
      }
      if (isExplicitBullet) afterDateLine = false

      // Explicit bullet OR auto-bullet (Skills, Certifications…) OR first line of education entry
      if (isExplicitBullet || autoBullet || (entryBullet && entryStart)) {
        if (entryBullet && entryStart) entryStart = false
        const bt = isExplicitBullet ? t.replace(/^[-•*]\s+/, '') : t
        if (!bt.trim()) continue // skip empty bullets
        // Single text call keeps bullet + text together across page breaks
        doc.fontSize(10).font('Helvetica').fillColor(BODY)
          .text(`•   ${bt}`, ML + 8, doc.y, { width: CW - 8, lineGap: 1.5 })
        doc.moveDown(0.1)
        continue
      }

      // Company / role + date (right-aligned date, bold left label)
      const dateSplit = splitDateLine(t)
      if (dateSplit) {
        if (!firstEntryInSection) doc.moveDown(0.35)
        firstEntryInSection = false
        afterDateLine = true
        const { left, right } = dateSplit
        doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY)
          .text(left, ML, doc.y, { width: CW, continued: true })
        doc.fontSize(9.5).font('Helvetica').fillColor(LGREY)
          .text(`   ${right}`, { width: CW, align: 'right' })
        doc.moveDown(0.08)
        continue
      }

      // Role heading: plain text line followed by a standalone date line
      const peekNext = idx < lines.length ? lines[idx].trim() : ''
      if (peekNext && isDateOnlyLine(peekNext) && !isDateOnlyLine(t)) {
        if (!firstEntryInSection) doc.moveDown(0.35)
        firstEntryInSection = false
        doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY)
          .text(t, ML, doc.y, { width: CW })
        idx++
        doc.fontSize(9.5).font('Helvetica-Oblique').fillColor(LGREY)
          .text(peekNext, ML, doc.y, { width: CW })
        doc.moveDown(0.15)
        continue
      }

      // Standalone date line (not preceded by a role heading — fallback)
      if (isDateOnlyLine(t)) {
        doc.fontSize(9.5).font('Helvetica-Oblique').fillColor(LGREY)
          .text(t, ML, doc.y, { width: CW })
        doc.moveDown(0.1)
        continue
      }

      // Plain body line (summary prose, etc.)
      doc.fontSize(10).font('Helvetica').fillColor(BODY)
        .text(t, ML, doc.y, { width: CW, lineGap: 1.5 })
    }

    doc.end()
    stream.on('finish', () => resolve(tempPath))
    stream.on('error', reject)
  })
}

async function buildCoverLetterPDF(text) {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const PDFDocument = require('pdfkit')
  const tempPath = path.join(os.tmpdir(), 'cover-letter.pdf')

  // Split on blank lines so paragraph spacing is controlled, not inflated by paragraphGap
  const paragraphs = (text || '').trim().split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 65, bottom: 65, left: 72, right: 72 } })
    const stream = fs.createWriteStream(tempPath)
    doc.pipe(stream)
    doc.fontSize(11).font('Helvetica').fillColor('#1a1a1a')
    for (let i = 0; i < paragraphs.length; i++) {
      doc.text(paragraphs[i], { lineGap: 4 })
      if (i < paragraphs.length - 1) doc.moveDown(1.5)
    }
    doc.end()
    stream.on('finish', () => resolve(tempPath))
    stream.on('error', reject)
  })
}

async function buildResumeDocx(text) {
  const os = require('os')
  const path = require('path')
  const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle,
    TabStopType, TabStopLeader } = require('docx')

  const lines = stripMarkdown(text || '').split('\n')

  function isSectionHeader(t) {
    return t.length >= 3 && /^[A-Z][A-Z\s\/&\-]{2,}$/.test(t)
  }

  function splitDateLine(t) {
    const m = t.match(/^(.+?)\s{3,}(.+)$/)
    if (m && /\b(19|20)\d{2}\b|present|current/i.test(m[2])) {
      return { left: m[1].trim(), right: m[2].trim() }
    }
    return null
  }

  const paragraphs = []
  let idx = 0
  while (idx < lines.length && !lines[idx].trim()) idx++

  // Name
  if (idx < lines.length) {
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: lines[idx++].trim(), bold: true, size: 40, color: '1E3A5F' })],
    }))
  }

  // Contact lines (until first section header)
  while (idx < lines.length) {
    const l = lines[idx].trim()
    if (!l) { idx++; continue }
    if (isSectionHeader(l)) break
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: l.replace(/\s*\|\s*/g, '  |  '), size: 18, color: '6B7280' })],
    }))
    idx++
  }

  // Divider
  paragraphs.push(new Paragraph({
    spacing: { after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '2563EB' } },
    children: [],
  }))

  // Body
  while (idx < lines.length) {
    const t = lines[idx++].trim()

    if (!t) {
      paragraphs.push(new Paragraph({ spacing: { after: 40 }, children: [] }))
      continue
    }

    if (isSectionHeader(t)) {
      paragraphs.push(new Paragraph({
        spacing: { before: 160, after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2563EB' } },
        children: [new TextRun({ text: t, bold: true, size: 22, color: '1E3A5F' })],
      }))
      continue
    }

    if (/^[-•*]\s/.test(t)) {
      const bt = t.replace(/^[-•*]\s+/, '')
      paragraphs.push(new Paragraph({
        spacing: { after: 20 },
        indent: { left: 240, hanging: 240 },
        children: [new TextRun({ text: `• ${bt}`, size: 19, color: '1a1a1a' })],
      }))
      continue
    }

    const dateSplit = splitDateLine(t)
    if (dateSplit) {
      paragraphs.push(new Paragraph({
        spacing: { after: 20 },
        tabStops: [{ type: TabStopType.RIGHT, position: 9360, leader: TabStopLeader.NONE }],
        children: [
          new TextRun({ text: dateSplit.left, bold: true, size: 20, color: '1a1a1a' }),
          new TextRun({ text: '\t' }),
          new TextRun({ text: dateSplit.right, size: 18, color: '6B7280' }),
        ],
      }))
      continue
    }

    paragraphs.push(new Paragraph({
      spacing: { after: 20 },
      children: [new TextRun({ text: t, size: 19, color: '1a1a1a' })],
    }))
  }

  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buffer = await Packer.toBuffer(doc)
  const tempPath = path.join(os.tmpdir(), `Resume-converted-${Date.now()}.docx`)
  require('fs').writeFileSync(tempPath, buffer)
  return tempPath
}

async function tailorDocx(originalPath, tailoredText, candidateName) {
  const AdmZip = require('adm-zip')
  const os = require('os')
  const path = require('path')

  const zip = new AdmZip(originalPath)
  const xmlEntry = zip.getEntry('word/document.xml')
  if (!xmlEntry) throw new Error('Invalid DOCX: no document.xml')

  let xml = xmlEntry.getData().toString('utf8')

  // Prepare tailored lines (plain text, XML-escaped)
  const escXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tailoredLines = stripMarkdown(tailoredText).replace(/\s*\{\{https?:\/\/[^}]+\}\}/g, '').split('\n').map(escXml)

  let lineIdx = 0
  // Replace each paragraph's text while keeping XML structure (fonts, spacing, styles)
  xml = xml.replace(/(<w:p[ >])([\s\S]*?)(<\/w:p>)/g, (match, open, content, close) => {
    const paraText = (content.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map(t => t.replace(/<[^>]+>/g, '')).join('').trim()

    if (!paraText) return match // empty paragraph — preserve as-is

    // Skip past blank tailored lines (empty lines in tailored text are spacing, not real content)
    while (lineIdx < tailoredLines.length && !tailoredLines[lineIdx].trim()) lineIdx++
    if (lineIdx >= tailoredLines.length) return match

    const newText = tailoredLines[lineIdx++]

    // Put all new text in the first <w:t> run, clear the rest
    let firstDone = false
    const newContent = content.replace(/(<w:t)([^>]*)(>)([\s\S]*?)(<\/w:t>)/g, (m, tag, attrs, gt, _text, close2) => {
      if (!firstDone) {
        firstDone = true
        const hasSpace = /xml:space/.test(attrs)
        return `${tag}${attrs}${hasSpace ? '' : ' xml:space="preserve"'}${gt}${newText}${close2}`
      }
      return '' // remove extra runs
    })

    return open + newContent + close
  })

  const safeName = (candidateName || 'Resume').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Resume'
  const tempPath = path.join(os.tmpdir(), `Resume - ${safeName}.docx`)
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'))

  // Update DOCX title metadata so portals (Seek/Indeed) show the candidate name
  const coreEntry = zip.getEntry('docProps/core.xml')
  if (coreEntry) {
    let coreXml = coreEntry.getData().toString('utf8')
    const escapedName = escXml(safeName)
    if (/<dc:title>/.test(coreXml)) {
      coreXml = coreXml.replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${escapedName}<\/dc:title>`)
    } else {
      coreXml = coreXml.replace(/<\/cp:coreProperties>/, `<dc:title>${escapedName}</dc:title></cp:coreProperties>`)
    }
    zip.updateFile('docProps/core.xml', Buffer.from(coreXml, 'utf8'))
  }

  zip.writeZip(tempPath)
  return tempPath
}

// Build the resume file to upload: injects AI-tailored text into the stored DOCX (preserving
// formatting), or falls back to a freshly generated PDF if no DOCX is available.
async function buildResumeFile(tailoredResume, cfg) {
  const originalPath = cfg && cfg.activeResumeOriginalPath
  const originalExt = cfg && cfg.activeResumeOriginalExt
  const candidateName = (cfg?.masterResume || tailoredResume || '')
    .split('\n').find(l => l.trim())?.trim()?.replace(/\*\*/g, '') || 'Resume'

  if (originalPath) {
    const fs = require('fs')
    if (fs.existsSync(originalPath) && (originalExt === 'docx' || originalExt === 'doc')) {
      try {
        return await tailorDocx(originalPath, tailoredResume, candidateName)
      } catch { /* fall through to generated PDF */ }
    }
  }

  return buildResumePDF(tailoredResume, candidateName, cfg?.personalLinks)
}

module.exports = { randomUserAgent, randomDelay, humanType, stripMarkdown, buildResumePDF, buildResumeDocx, buildCoverLetterPDF, tailorDocx, buildResumeFile }
