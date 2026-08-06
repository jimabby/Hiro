// Which URL the main window is allowed to occupy.
//
// Extracted from main.js so it can be tested without an Electron runtime — the
// bug this module exists to prevent was a Windows-only path comparison that no
// test could reach while the check lived inside main.js.
//
// The rule: in dev the window may only be the Vite origin; in production it may
// only be the one packaged entry file. Everything else is refused, so a single
// injected link cannot navigate the privileged renderer at an arbitrary local
// file and read it through the preload bridge.

const path = require('path')
const url = require('url')

// A `file:` URL's pathname is NOT a filesystem path on Windows: the packaged
// entry point arrives as `/C:/Program%20Files/Hiro/.../index.html`, and feeding
// that leading slash to path.resolve() produced `C:\C:\Program Files\...` —
// never equal to the real entry file, so every legitimate reload and redirect
// in a packaged Windows build was rejected. fileURLToPath() is the conversion
// that understands drive letters, percent-encoding and UNC hosts.
//
// `platform` is threaded through rather than read from process.platform so the
// Windows behaviour is testable from a Linux CI runner. Node's `windows` option
// (v22.1+) is what makes that possible; `supportsPlatformOverride` lets the test
// assert it is really in effect instead of silently checking the host platform.
function fileUrlToPath(fileUrl, platform) {
  try {
    return url.fileURLToPath(fileUrl, { windows: platform === 'win32' })
  } catch {
    // Not a file: URL, or one fileURLToPath refuses — a non-localhost host, or
    // an encoded path separator that would smuggle traversal past the compare.
    // Both mean "not ours".
    return null
  }
}

function supportsPlatformOverride() {
  try {
    return url.fileURLToPath('file:///C:/a', { windows: true }) === 'C:\\a'
  } catch {
    return false
  }
}

// Windows paths are case-insensitive, so `C:\Hiro\dist\index.html` and
// `c:\hiro\DIST\index.html` are the same file and must compare equal. On POSIX
// they are two different files and must not.
function samePath(a, b, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const ra = p.resolve(a)
  const rb = p.resolve(b)
  return platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

function isEntryPointUrl(target, { isDev, entryFile, devOrigin = 'http://localhost:5173', platform = process.platform } = {}) {
  if (typeof target !== 'string' || target === '') return false

  let parsed
  try { parsed = new URL(target) } catch { return false }

  if (isDev) return parsed.origin === devOrigin

  if (parsed.protocol !== 'file:') return false
  if (!entryFile) return false

  const filePath = fileUrlToPath(parsed, platform)
  if (filePath === null) return false
  return samePath(filePath, entryFile, platform)
}

module.exports = { isEntryPointUrl, supportsPlatformOverride }
