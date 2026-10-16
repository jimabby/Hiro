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
  return (question, options) => new Promise((resolve) => {
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
    // 5 min timeout — must also drop the listener, or it lingers forever. The
    // renderer is told too, so it closes the modal instead of leaving a dead
    // question on screen whose answer would go nowhere.
    const timeout = setTimeout(() => {
      cleanup()
      if (!win.isDestroyed()) win.webContents.send('question:cancel', { id })
      resolve('')
    }, 5 * 60 * 1000)

    ipcMain.on('question:answer', handler)
    // `options`, when given, are the labels a select or radio group accepts —
    // the renderer can offer them as choices; the question text names them too.
    win.webContents.send('question:ask', { id, question, ...(Array.isArray(options) && options.length ? { options } : {}) })
  })
}

module.exports = { makeAskQuestion }
