// logger.tail() must read only the end of the log, not all of it.
//
// The phone polls /api/logs every couple of seconds while a scan runs, and the
// log is capped at 2 MB — so the old readFileSync re-read and re-split two
// megabytes several times a second to display forty lines.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-logger-' + Date.now())
stub({ './config': { load: () => ({}), update: () => {}, CONFIG_DIR } })

const logger = service('logger.js')
const { check, done } = createChecker()

check('an absent log tails to nothing', logger.tail(10), [])

for (let i = 1; i <= 2000; i++) logger.append(`line ${i}`)

const last40 = logger.tail(40)
check('tail returns the requested count', last40.length, 40)
check('tail is oldest to newest', /line 1961$/.test(last40[0]), true)
check('the newest line is last', /line 2000$/.test(last40[39]), true)
check('every line is whole', last40.every(l => /^\[[\d\-: ]+\] line \d+$/.test(l)), true)

// Asking for more than exists returns everything, not a padded or truncated set.
check('asking for more than exists returns all', logger.tail(99999).length, 2000)
check('the first line is intact when the whole file is read', /line 1$/.test(logger.tail(99999)[0]), true)

// A single very long line must not produce a fragment — the over-read window
// is sized generously and a partial leading line is dropped rather than shown.
logger.append('X'.repeat(60000))
const afterLong = logger.tail(3)
check('a very long line is returned whole', afterLong[afterLong.length - 1].endsWith('X'.repeat(100)), true)
check('no fragment is emitted before it', afterLong.every(l => l.startsWith('[')), true)

logger.clear()
check('clearing empties the tail', logger.tail(10), [])
check('the log file still exists after clearing', fs.existsSync(logger.getPath()), true)

done()
