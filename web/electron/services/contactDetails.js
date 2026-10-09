// Name, email, phone and links — the first five fields of every application
// form.
//
// Hiro never stored these as settings: the scrapers that auto-apply sign in to
// a board that already knows them. A company career site does not, so filling
// one needs them as data. They are taken from the Contact details in Settings
// when filled in, and otherwise read off the résumé — the document the employer
// receives anyway, so nothing is said there that the résumé does not already
// say. A field that cannot be found is left blank rather than guessed: an
// invented phone number is worse than an empty box.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
// Seven or more digits, allowing the separators people write numbers with.
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;)]*)?/gi

function firstNonEmptyLine(text) {
  return String(text || '').split('\n').map(l => l.trim()).find(Boolean) || ''
}

// The résumé's first line is the name in every conventional layout. Only taken
// when it reads like one — two to four capitalised words, no digits or '@' —
// because a résumé that opens with "Curriculum Vitae" must not produce a
// candidate called "Curriculum Vitae".
function nameFromResume(text) {
  const line = firstNonEmptyLine(text).replace(/[*_#]/g, '').trim()
  if (!line || /[\d@|/]/.test(line) || /curriculum|vitae|résumé|resume/i.test(line)) return ''
  const words = line.split(/\s+/)
  if (words.length < 2 || words.length > 4) return ''
  if (!words.every(w => /^[A-ZÀ-ÖØ-Þ][\p{L}'-]*$/u.test(w))) return ''
  return line
}

function linksFromResume(text) {
  const out = { linkedin: '', github: '', portfolio: '' }
  for (const raw of String(text || '').match(URL_RE) || []) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    if (/linkedin\.com\//i.test(url) && !out.linkedin) out.linkedin = url
    else if (/github\.com\//i.test(url) && !out.github) out.github = url
  }
  return out
}

function contactFor(cfg = {}) {
  const saved = cfg.contactDetails || {}
  const resume = cfg.masterResume || ''
  const links = cfg.personalLinks || {}
  const fromResume = linksFromResume(resume)

  const fullName = String(saved.fullName || '').trim() || nameFromResume(resume)
  const parts = fullName.split(/\s+/).filter(Boolean)
  const email = String(saved.email || '').trim() || (resume.match(EMAIL_RE)?.[0] ?? '')
  const phone = String(saved.phone || '').trim() || (resume.match(PHONE_RE)?.[0]?.trim() ?? '')

  return {
    fullName,
    firstName: String(saved.firstName || '').trim() || parts[0] || '',
    lastName: String(saved.lastName || '').trim() || (parts.length > 1 ? parts.slice(1).join(' ') : ''),
    email,
    phone,
    location: String(saved.location || cfg.jobLocation || '').trim(),
    linkedin: String(links.linkedin || '').trim() || fromResume.linkedin,
    github: String(links.github || '').trim() || fromResume.github,
    portfolio: String(links.portfolio || '').trim(),
  }
}

module.exports = { contactFor, nameFromResume, linksFromResume }
