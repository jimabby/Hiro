// Cleaning text extracted from a résumé file.
//
// Some DOCX and PDF files use non-standard font encodings, and their text comes
// out of the extractor with garbage glyphs in it: control characters, Symbol-
// font private-use code points, U+FFFD. The clean-up for that used to keep only
// printable ASCII plus a handful of typographic marks, which also deleted every
// accented or non-Latin letter. "José Núñez, Zürich" became "Jos Nez, Zrich",
// and the first line of the master résumé is the name printed on every
// generated résumé and cover letter sent to employers.
//
// So the filter now removes what is never text (Unicode category C, apart
// from tab and newline, plus U+FFFD) and keeps letters in every script.

// Symbol / Wingdings bullets that Word stores as private-use code points.
const PRIVATE_BULLETS_RE = /[\uF0B7\uF0A7\uF0D8\uF076\uF0FC\uF06E]/g
const UNPRINTABLE_RE = /[^\P{C}\t\n]|\uFFFD/gu

function stripUnprintable(text) {
  return String(text ?? '').replace(PRIVATE_BULLETS_RE, '•').replace(UNPRINTABLE_RE, '')
}

// The PDF standard fonts (Helvetica, Times) are WinAnsi-encoded, and a
// character outside it renders as a wrong glyph rather than failing. Keep
// Latin-1 and the WinAnsi extras so accented names render correctly. Anything
// else (CJK, Cyrillic) cannot be drawn without embedding a font, which is what
// the standard-fonts rule in scraper/utils.js exists to avoid, so it is
// dropped from the generated PDF only, never from the stored text.
const NOT_WIN_ANSI_RE = /[^\t\n\x20-\x7E\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/g

function toWinAnsi(text) {
  return String(text ?? '').replace(NOT_WIN_ANSI_RE, '')
}

module.exports = { stripUnprintable, toWinAnsi }
