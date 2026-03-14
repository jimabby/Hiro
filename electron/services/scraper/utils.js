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

async function humanType(page, element, text) {
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

async function buildResumePDF(tailoredResume, candidateName) {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const PDFDocument = require('pdfkit')

  const safeName = (candidateName || 'Resume').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
  const tempPath = path.join(os.tmpdir(), `Resume - ${safeName}.pdf`)
  const text = stripMarkdown(tailoredResume || '')
  const lines = text.split('\n')

  const ML = 52, CW = 491 // left margin, content width (A4 595pt - 52*2 margins)
  const NAVY = '#1E3A5F'
  const BLUE = '#2563EB'
  const BODY = '#1a1a1a'
  const GREY = '#6B7280'

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

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: ML, autoFirstPage: true })
    const stream = fs.createWriteStream(tempPath)
    doc.pipe(stream)

    let idx = 0
    while (idx < lines.length && !lines[idx].trim()) idx++

    // Name — explicitly positioned to guarantee centering
    if (idx < lines.length) {
      doc.fontSize(22).font('Helvetica-Bold').fillColor(NAVY)
        .text(lines[idx++].trim(), ML, doc.y, { align: 'center', width: CW })
      doc.moveDown(0.2)
    }

    // Contact info: lines with email/phone/links or pipe separators
    const contactParts = []
    while (idx < lines.length) {
      const l = lines[idx].trim()
      if (!l) { idx++; continue }
      if (isSectionHeader(l)) break
      if (/[@|]|linkedin|github|http|\+\d|04\d{2}|\d{3}[-.\s]\d{3}/i.test(l) || contactParts.length === 0) {
        contactParts.push(l.replace(/\s*\|\s*/g, ' | '))
        idx++
      } else break
    }
    if (contactParts.length) {
      doc.fontSize(9).font('Helvetica').fillColor(GREY)
        .text(contactParts.join('  |  '), ML, doc.y, { align: 'center', width: CW })
      doc.moveDown(0.25)
    }

    // Header rule
    const ruleY = doc.y
    doc.moveTo(ML, ruleY).lineTo(ML + CW, ruleY).strokeColor(BLUE).lineWidth(1.5).stroke()
    doc.moveDown(0.5)

    // Body
    while (idx < lines.length) {
      const t = lines[idx++].trim()

      if (!t) {
        doc.moveDown(0.25)
        continue
      }

      if (isSectionHeader(t)) {
        doc.moveDown(0.45)
        doc.fontSize(10.5).font('Helvetica-Bold').fillColor(NAVY)
          .text(t, ML, doc.y, { align: 'center', width: CW })
        const ry = doc.y + 1
        doc.moveTo(ML, ry).lineTo(ML + CW, ry).strokeColor(BLUE).lineWidth(0.6).stroke()
        doc.moveDown(0.3)
        continue
      }

      if (/^[-•*]\s/.test(t)) {
        const bt = t.replace(/^[-•*]\s+/, '')
        const INDENT = 13
        const by = doc.y
        doc.fontSize(9.5).font('Helvetica').fillColor(BODY)
        doc.text('•', ML, by, { width: INDENT - 2, lineBreak: false })
        doc.text(bt, ML + INDENT, by, { width: CW - INDENT })
        doc.moveDown(0.05)
        continue
      }

      const dateSplit = splitDateLine(t)
      if (dateSplit) {
        const { left, right } = dateSplit
        const rowY = doc.y
        doc.fontSize(9).font('Helvetica').fillColor(GREY)
        const dateWidth = doc.widthOfString(right) + 4
        doc.text(right, ML, rowY, { width: CW, align: 'right', lineBreak: false })
        doc.fontSize(10).font('Helvetica-Bold').fillColor(BODY)
          .text(left, ML, rowY, { width: CW - dateWidth - 8 })
        doc.moveDown(0.05)
        continue
      }

      doc.fontSize(9.5).font('Helvetica').fillColor(BODY)
        .text(t, ML, doc.y, { width: CW })
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
      doc.text(paragraphs[i], { lineGap: 3 })
      if (i < paragraphs.length - 1) doc.moveDown(0.55)
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

async function tailorDocx(originalPath, tailoredText) {
  const AdmZip = require('adm-zip')
  const os = require('os')
  const path = require('path')

  const zip = new AdmZip(originalPath)
  const xmlEntry = zip.getEntry('word/document.xml')
  if (!xmlEntry) throw new Error('Invalid DOCX: no document.xml')

  let xml = xmlEntry.getData().toString('utf8')

  // Prepare tailored lines (plain text, XML-escaped)
  const escXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tailoredLines = stripMarkdown(tailoredText).split('\n').map(escXml)

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

  const tempPath = path.join(os.tmpdir(), `Resume-tailored-${Date.now()}.docx`)
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'))
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
        return await tailorDocx(originalPath, tailoredResume)
      } catch { /* fall through to generated PDF */ }
    }
  }

  return buildResumePDF(tailoredResume, candidateName)
}

module.exports = { randomUserAgent, randomDelay, humanType, stripMarkdown, buildResumePDF, buildResumeDocx, buildCoverLetterPDF, tailorDocx, buildResumeFile }
