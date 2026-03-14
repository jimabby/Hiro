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
  const fileName = `Resume - ${safeName}.pdf`
  const tempPath = path.join(os.tmpdir(), fileName)
  const cleanText = stripMarkdown(tailoredResume)
  const lines = cleanText.split('\n')

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    const stream = fs.createWriteStream(tempPath)
    doc.pipe(stream)

    let firstLineDone = false
    for (const line of lines) {
      if (!firstLineDone && !line.trim()) continue
      if (!firstLineDone) {
        doc.fontSize(16).font('Helvetica-Bold').text(line.trim(), { align: 'center' })
        firstLineDone = true
      } else if (line.trim() && /^[A-Z][A-Z\s\/&-]{2,}$/.test(line.trim())) {
        doc.moveDown(0.5).fontSize(11).font('Helvetica-Bold').text(line.trim())
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke()
        doc.moveDown(0.2)
      } else {
        doc.fontSize(10).font('Helvetica').text(line, { lineGap: 1 })
      }
    }

    doc.end()
    stream.on('finish', () => resolve(tempPath))
    stream.on('error', reject)
  })
}

module.exports = { randomUserAgent, randomDelay, humanType, stripMarkdown, buildResumePDF }
