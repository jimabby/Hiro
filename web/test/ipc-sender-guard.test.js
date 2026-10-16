// Every IPC call must come from the app's own page.
//
// The preload bridge reads and writes config, opens files and submits
// applications. ipc/senderGuard.js wraps every handler so a frame that is not
// the entry page — an iframe, anything navigated past the guard — is refused
// before the handler runs. Driven here against a stand-in ipcMain, with the
// real entry-point check deciding what is trusted.

const path = require('path')
const { EventEmitter } = require('events')
const { createChecker } = require('./helpers')
const { installSenderGuard } = require('../electron/ipc/senderGuard')
const entryUrl = require('../electron/services/entryUrl')

const { check, done } = createChecker()

// Enough of Electron's ipcMain: an EventEmitter plus handle().
class FakeIpcMain extends EventEmitter {
  constructor() { super(); this.handlers = new Map() }
  handle(channel, fn) { this.handlers.set(channel, fn) }
  handleOnce(channel, fn) { this.handlers.set(channel, fn) }
  invoke(channel, event, ...args) { return this.handlers.get(channel)(event, ...args) }
}

const ENTRY = path.join(__dirname, '..', 'dist', 'index.html')
const entryFileUrl = require('url').pathToFileURL(ENTRY).href
const isTrusted = (url) => entryUrl.isEntryPointUrl(url, { isDev: false, entryFile: ENTRY })
const rejected = []
const ipc = installSenderGuard(new FakeIpcMain(), isTrusted, { onReject: (kind, url) => rejected.push(url) })

const from = (url) => ({ senderFrame: url == null ? null : { url } })

;(async () => {
  let ran = 0
  ipc.handle('config:get', () => { ran++; return { ok: true } })

  check('the app page is answered', await ipc.invoke('config:get', from(entryFileUrl)), { ok: true })
  check('including with a hash route', await ipc.invoke('config:get', from(`${entryFileUrl}#/settings`)), { ok: true })

  for (const [label, url] of [
    ['another local file', require('url').pathToFileURL(path.join(__dirname, 'evil.html')).href],
    ['a web page', 'https://example.com/'],
    ['the PDF preview scheme', 'hiro-pdf://preview/abc'],
    ['a frame with no URL', ''],
    ['a destroyed frame', null],
  ]) {
    let error = null
    try { await ipc.invoke('config:get', from(url)) } catch (err) { error = err }
    check(`${label} is refused`, /IPC refused/.test(error?.message || ''), true)
  }
  check('a refused call never reaches the handler', ran, 2)
  check('refusals are reported', rejected.length, 5)

  // Fire-and-forget channels (askQuestion, confirmSubmit) are guarded too, and
  // removing a listener by its original function still works.
  const seen = []
  const listener = (_event, value) => seen.push(value)
  ipc.on('question:answer', listener)
  ipc.emit('question:answer', from(entryFileUrl), 'yes')
  ipc.emit('question:answer', from('https://example.com/'), 'forged')
  check('an on() listener hears the app page only', seen, ['yes'])
  ipc.removeListener('question:answer', listener)
  check('removeListener with the original function removes the wrapper', ipc.listenerCount('question:answer'), 0)

  const once = []
  ipc.once('submit:confirm', (_e, v) => once.push(v))
  ipc.emit('submit:confirm', from(entryFileUrl), 1)
  ipc.emit('submit:confirm', from(entryFileUrl), 2)
  check('once() still fires once', once, [1])

  // Dev mode trusts the Vite origin and nothing else.
  const dev = installSenderGuard(new FakeIpcMain(), (url) => entryUrl.isEntryPointUrl(url, { isDev: true }))
  dev.handle('x', () => 'ok')
  check('dev: the Vite page is answered', await dev.invoke('x', from('http://localhost:5173/#/')), 'ok')
  let devError = null
  try { await dev.invoke('x', from('http://localhost:5174/')) } catch (err) { devError = err }
  check('dev: another port is refused', !!devError, true)

  check('installing twice does not double-wrap', installSenderGuard(ipc, isTrusted), ipc)
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
