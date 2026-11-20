// Text out of a résumé file: PDF, DOCX, plain text or Markdown.
//
// Two callers. The Settings import (main.js resume:importFile) opens a file the
// user picked in a native dialog; the Ask Hiro chat receives the bytes of a file
// the user attached or dropped onto the page. Both used to need the same clean-up
// — PDF fonts and some Word templates come out with stray private-use glyphs and
// bullets glued to words — so it lives here once rather than drifting in two places.
//
// The chat path deliberately takes BYTES, not a path. A path from the renderer
// would make this a way to read any file on disk; the bytes of a file the user
// handed to the page are exactly what they meant to share, and nothing else.

const { stripUnprintable } = require('./textClean')

const SUPPORTED = ['pdf', 'docx', 'txt', 'md']
const BOM = new RegExp('^' + String.fromCharCode(0xFEFF))
// Generous for a résumé (a typical one is under 500 KB), small enough that a
// mis-dropped video does not get read into memory and parsed.
const MAX_BYTES = 10 * 1024 * 1024

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

function tidy(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Returns { text, links } where `links` maps a hyperlink's visible text to its
// URL (DOCX only — the importer embeds them so the PDF builder can keep them).
async function extractResumeText(buffer, ext) {
  const kind = String(ext || '').toLowerCase()
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (!bytes.length) throw new Error('That file is empty.')
  if (bytes.length > MAX_BYTES) throw new Error('That file is larger than 10 MB, which is far bigger than a résumé should be.')

  if (kind === 'txt' || kind === 'md') {
    return { text: tidy(stripUnprintable(bytes.toString('utf8').replace(BOM, '').replace(/\r\n/g, '\n'))), links: new Map() }
  }

  if (kind === 'pdf') {
    const { PDFParse } = require('pdf-parse')
    // A copy: the PDF worker may transfer (detach) the array it is given.
    const parser = new PDFParse({ data: new Uint8Array(bytes) })
    let result
    try { result = await parser.getText() } finally { try { await parser.destroy?.() } catch { /* already gone */ } }
    // PDF fonts often use non-standard encoding — strip the same artifacts as DOCX.
    let text = tidy(stripUnprintable(String(result?.text || '').replace(/\r\n/g, '\n')).replace(/•(?!\s)/g, ''))
    // Page footers out, lines the PDF wrapped at the margin joined back up.
    text = require('./scraper/utils').unwrapExtractedLines(text.split('\n')).join('\n')
    return { text, links: new Map() }
  }

  if (kind === 'doc') {
    throw new Error('Older .doc files cannot be read. Open it in Word or Pages and save it as .docx, then try again.')
  }

  if (kind === 'docx') {
    const mammoth = require('mammoth')
    // Hyperlinks (portfolio, GitHub, LinkedIn) only survive in the HTML rendering.
    const links = new Map()
    try {
      const html = await mammoth.convertToHtml({ buffer: bytes })
      const linkRe = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      let m
      while ((m = linkRe.exec(html.value)) !== null) {
        const url = m[1]
        const label = m[2].replace(/<[^>]+>/g, '').trim()
        if (label && /^https?:\/\//.test(url)) links.set(label, url)
      }
    } catch { /* link extraction is non-critical */ }

    const result = await mammoth.extractRawText({ buffer: bytes })
    // Some DOCX files use non-standard font encoding and come out as garbled
    // characters; bullets glued to words ("•7B") are the commonest artifact.
    const text = tidy(stripUnprintable(result.value.replace(/\r\n/g, '\n'))
      .replace(/•(?=[A-Za-z0-9])/g, '')
      .replace(/•(?!\s)/g, ''))
    return { text, links }
  }

  throw new Error('Attach a PDF, Word (.docx) or plain-text file.')
}

function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length
}

module.exports = { extractResumeText, extensionOf, wordCount, SUPPORTED, MAX_BYTES }
