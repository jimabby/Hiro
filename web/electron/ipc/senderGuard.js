// Every IPC call must come from the app's own page.
//
// The preload bridge is the renderer's entire reach into the main process: it
// reads and writes config, opens files, submits applications. Navigation is
// already pinned to the entry page (see services/entryUrl.js), but that is one
// layer — a frame that is not ours (an iframe, a page reached by some path the
// navigation guard did not anticipate) must not be able to speak on the bridge
// even if it somehow has one.
//
// So every handler is wrapped: the sending frame's URL has to be the entry
// point, or the call is refused before the handler runs. Installed once, at the
// top of main.js, before any handler is registered — including the ones the
// ipc/ modules and services register on the ipcMain they are handed.

function senderUrl(event) {
  try { return event?.senderFrame?.url || '' } catch { return '' }
}

function installSenderGuard(ipcMain, isTrustedUrl, { onReject = () => {} } = {}) {
  if (ipcMain.__hiroSenderGuard) return ipcMain
  const trusted = (event) => {
    const url = senderUrl(event)
    if (url && isTrustedUrl(url)) return true
    onReject(event?.type || 'ipc', url)
    return false
  }

  const origHandle = ipcMain.handle.bind(ipcMain)
  const origHandleOnce = ipcMain.handleOnce?.bind(ipcMain)
  ipcMain.handle = (channel, listener) => origHandle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('IPC refused: the request did not come from the Hiro window.')
    return listener(event, ...args)
  })
  if (origHandleOnce) {
    ipcMain.handleOnce = (channel, listener) => origHandleOnce(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('IPC refused: the request did not come from the Hiro window.')
      return listener(event, ...args)
    })
  }

  // Fire-and-forget channels. The wrapper is remembered per listener so
  // removeListener(channel, original) still finds and removes it.
  const wrapped = new WeakMap()
  const wrap = (listener) => {
    if (typeof listener !== 'function') return listener
    let w = wrapped.get(listener)
    if (!w) {
      w = function (event, ...args) {
        if (!trusted(event)) return
        return listener.call(this, event, ...args)
      }
      wrapped.set(listener, w)
    }
    return w
  }
  for (const name of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    const orig = ipcMain[name]?.bind(ipcMain)
    if (orig) ipcMain[name] = (channel, listener) => orig(channel, wrap(listener))
  }
  for (const name of ['removeListener', 'off']) {
    const orig = ipcMain[name]?.bind(ipcMain)
    if (orig) ipcMain[name] = (channel, listener) => orig(channel, wrapped.get(listener) || listener)
  }

  Object.defineProperty(ipcMain, '__hiroSenderGuard', { value: true })
  return ipcMain
}

module.exports = { installSenderGuard, senderUrl }
