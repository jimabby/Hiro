// Ask the user to approve a submission that is one click from reaching an
// employer, showing the screening answers about to be sent.
//
// Modelled on askQuestion, including its hard-won detail: each request carries
// a unique id the renderer echoes back, because a shared channel resolved every
// waiting promise at once and sent the wrong answer to a job.
//
// The differences from askQuestion are all about failing safe:
//
//   * no window        → false. A dialog nobody can see must never be treated
//                        as consent.
//   * timeout          → false, and a long one (15 min). This appears mid-flow
//                        with a browser open, and someone who stepped away has
//                        not agreed to anything.
//   * malformed reply  → false. Only an explicit `approved: true` proceeds.
const { ipcMain } = require('electron')

const TIMEOUT_MS = 15 * 60 * 1000

let nextId = 1

function makeConfirmSubmit(win) {
  return (details) => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false)
    const id = nextId++

    const handler = (_, payload) => {
      if (!payload || typeof payload !== 'object' || payload.id !== id) return
      cleanup()
      resolve(payload.approved === true)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ipcMain.removeListener('submit:confirm', handler)
    }
    const timeout = setTimeout(() => { cleanup(); resolve(false) }, TIMEOUT_MS)

    ipcMain.on('submit:confirm', handler)
    win.webContents.send('submit:review', { id, ...details })
  })
}

module.exports = { makeConfirmSubmit, TIMEOUT_MS }
