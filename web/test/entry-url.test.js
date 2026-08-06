// Navigation allow-list for the main window.
//
// The Windows cases are the point of this suite: the original check compared
// `new URL(u).pathname` — `/C:/Program Files/Hiro/...` — with path.resolve(),
// which prefixes the current drive and yields `C:\C:\Program Files\...`. Every
// legitimate reload of a packaged Windows build was therefore refused. These
// assertions run on any host OS, so a Linux CI runner catches a Windows-only
// regression.

const { createChecker, service } = require('./helpers')
const { check, done } = createChecker()

const { isEntryPointUrl, supportsPlatformOverride } = service('entryUrl')

// Without Node's fileURLToPath({ windows }) option the win32 cases below would
// silently test the HOST platform instead — exactly the blind spot that let the
// original bug ship. Fail loudly rather than pass vacuously.
check('node supports per-platform file URL conversion', supportsPlatformOverride(), true)

// ── Packaged Windows build ───────────────────────────────────────
const WIN_ENTRY = 'C:\\Program Files\\Hiro\\resources\\app\\dist\\index.html'
const win = (u) => isEntryPointUrl(u, { isDev: false, entryFile: WIN_ENTRY, platform: 'win32' })

check('win: entry file URL is allowed',
  win('file:///C:/Program%20Files/Hiro/resources/app/dist/index.html'), true)

// Electron hands back an unencoded space in some navigation events; both forms
// name the same file and both must be accepted.
check('win: unencoded space is allowed',
  win('file:///C:/Program Files/Hiro/resources/app/dist/index.html'), true)

// A reload carries the hash the SPA router put there.
check('win: entry file with router hash is allowed',
  win('file:///C:/Program%20Files/Hiro/resources/app/dist/index.html#/settings'), true)

check('win: entry file with query string is allowed',
  win('file:///C:/Program%20Files/Hiro/resources/app/dist/index.html?reload=1'), true)

// Windows filesystems are case-insensitive, so this IS the entry file.
check('win: differing case is allowed',
  win('file:///c:/program%20files/hiro/resources/app/dist/INDEX.HTML'), true)

check('win: backslash-separated URL is allowed',
  win('file:///C:\\Program Files\\Hiro\\resources\\app\\dist\\index.html'), true)

// ── Packaged Windows build: everything else is refused ───────────
check('win: another local file is refused',
  win('file:///C:/Users/victim/AppData/Local/Temp/evil.html'), false)

check('win: traversal to a sibling file is refused',
  win('file:///C:/Program%20Files/Hiro/resources/app/dist/../../../../evil.html'), false)

// %2e%2e must not decode into a traversal that then compares equal.
check('win: encoded traversal is refused',
  win('file:///C:/Program%20Files/Hiro/resources/app/dist/%2e%2e/evil.html'), false)

check('win: same path on another drive is refused',
  win('file:///D:/Program%20Files/Hiro/resources/app/dist/index.html'), false)

check('win: UNC path to a remote share is refused',
  win('file://attacker.example/share/dist/index.html'), false)

check('win: http URL is refused in production',
  win('http://localhost:5173/'), false)

check('win: dev server URL is refused in production',
  win('http://localhost:5173/index.html'), false)

check('win: custom scheme is refused', win('javascript:alert(1)'), false)
check('win: unparseable URL is refused', win('not a url'), false)
check('win: empty string is refused', win(''), false)
check('win: non-string is refused', win(null), false)

// ── Packaged POSIX build ────────────────────────────────────────
const POSIX_ENTRY = '/opt/Hiro/resources/app/dist/index.html'
const nix = (u) => isEntryPointUrl(u, { isDev: false, entryFile: POSIX_ENTRY, platform: 'linux' })

check('posix: entry file URL is allowed', nix('file:///opt/Hiro/resources/app/dist/index.html'), true)
check('posix: another local file is refused', nix('file:///etc/passwd'), false)
check('posix: traversal is refused', nix('file:///opt/Hiro/resources/app/dist/../../../../etc/passwd'), false)
// Unlike Windows, case matters on POSIX — these are two different files.
check('posix: differing case is refused', nix('file:///opt/hiro/resources/app/dist/index.html'), false)

// ── Dev ─────────────────────────────────────────────────────────
const dev = (u) => isEntryPointUrl(u, { isDev: true, entryFile: WIN_ENTRY, platform: 'win32' })

check('dev: vite origin is allowed', dev('http://localhost:5173/'), true)
check('dev: vite deep link is allowed', dev('http://localhost:5173/index.html#/setup'), true)
check('dev: another port is refused', dev('http://localhost:9999/'), false)
check('dev: another host is refused', dev('http://evil.example/'), false)
check('dev: https on the same port is refused', dev('https://localhost:5173/'), false)
// In dev the app is served over http, so file: is not a legitimate location.
check('dev: file URL is refused', dev('file:///C:/Program%20Files/Hiro/resources/app/dist/index.html'), false)

// A missing entryFile must fail closed rather than match anything.
check('production with no entry file configured refuses everything',
  isEntryPointUrl('file:///C:/x/index.html', { isDev: false, entryFile: '', platform: 'win32' }), false)

done()
