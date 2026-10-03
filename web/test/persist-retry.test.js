// The database rename survives a Windows file lock.
//
// Every persist writes a temp file and renames it over the database. On
// Windows another process — antivirus scanning the file the instant it
// changed, a backup client, the indexer — can hold it open in a way that
// refuses the rename for a few milliseconds. Failing on the first refusal
// threw out of whatever user action caused the write, while the in-memory
// database had already moved on.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-persist-retry-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const db = service('database.js')
const { check, done } = createChecker()

const failing = (codes) => {
  let calls = 0
  const fn = () => {
    const code = codes[calls++]
    if (code) { const err = new Error(code); err.code = code; throw err }
    return 'renamed'
  }
  fn.calls = () => calls
  return fn
}

const transient = failing(['EPERM', 'EBUSY'])
check('a lock that clears is ridden out', db.renameWithRetry('a', 'b', transient), 'renamed')
check('after retrying', transient.calls(), 3)

const permanent = failing(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM'])
let thrown = null
try { db.renameWithRetry('a', 'b', permanent) } catch (err) { thrown = err.code }
check('a lock that never clears still fails', thrown, 'EPERM')
check('after a bounded number of attempts', permanent.calls(), 6)

const other = failing(['ENOSPC'])
thrown = null
try { db.renameWithRetry('a', 'b', other) } catch (err) { thrown = err.code }
check('a real failure is not retried', thrown, 'ENOSPC')
check('it fails on the first attempt', other.calls(), 1)

done()
