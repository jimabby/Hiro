// Finding a job link in what the user hands Hiro: a share sheet's text, the
// clipboard, or a hiro://import?url=… deep link. Pure, so the parsing is
// testable from plain Node — see test/run.js.

// A share from a job board is rarely a bare URL: "Senior Engineer at Acme —
// https://…". Take the first http(s) URL in the text.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/i

function extractJobUrl(text) {
  if (!text) return null
  const match = String(text).match(URL_IN_TEXT)
  if (!match) return null
  // Trailing punctuation from a sentence is not part of the link.
  const candidate = match[0].replace(/[).,;:!?\]]+$/, '')
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

// hiro://import?url=<encoded>[&title=<encoded>] → { url, title } or null. Any
// other hiro:// link is not an import and returns null.
function parseImportLink(link) {
  if (!link) return null
  let parsed
  try { parsed = new URL(String(link)) } catch { return null }
  if (parsed.protocol !== 'hiro:') return null
  // hiro://import parses with "import" as the host; hiro:/import as the path.
  const target = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase()
  if (target !== 'import') return null
  const url = extractJobUrl(parsed.searchParams.get('url'))
  if (!url) return null
  const title = String(parsed.searchParams.get('title') || '').trim().slice(0, 200)
  return title ? { url, title } : { url }
}

module.exports = { extractJobUrl, parseImportLink }
