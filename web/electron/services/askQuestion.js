// Ask the user a screening question via the renderer, awaiting their answer.
//
// Each question carries a unique id that the renderer echoes back with the
// answer. Previously both main.js and scheduler.js registered
// `ipcMain.once('question:answer', …)` on the same shared channel, so when two
// apply flows were waiting at once, a single answer resolved BOTH promises and
// one job silently submitted the wrong answer.
const { ipcMain } = require('electron')

let nextId = 1

function makeAskQuestion(win) {
  return (question) => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve('')
    const id = nextId++

    const handler = (_, payload) => {
      const isObj = payload && typeof payload === 'object'
      if ((isObj ? payload.id : id) !== id) return // someone else's answer
      cleanup()
      resolve((isObj ? payload.answer : payload) || '')
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ipcMain.removeListener('question:answer', handler)
    }
    // 5 min timeout — must also drop the listener, or it lingers forever.
    const timeout = setTimeout(() => { cleanup(); resolve('') }, 5 * 60 * 1000)

    ipcMain.on('question:answer', handler)
    win.webContents.send('question:ask', { id, question })
  })
}

module.exports = { makeAskQuestion }
