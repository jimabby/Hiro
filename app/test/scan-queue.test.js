const fs = require('fs'), path = require('path'), vm = require('vm')
const { createChecker } = require('./helpers')
const { check, done } = createChecker()
let raw = null
const sandbox = { AsyncStorage: { getItem: async () => raw, setItem: async (_, value) => { raw = value } }, console }
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/scanQueue.js'), 'utf8').replace(/^import .*$/m, '').replaceAll('export function', 'function'), sandbox)
const deliveredA = [], deliveredB = []
const a = { queueDestination: { key: 'a', label: 'Account A' }, requestScan: async req => deliveredA.push(req) }
const b = { queueDestination: { key: 'b', label: 'Account B' }, requestScan: async req => deliveredB.push(req) }
;(async () => {
  await sandbox.enqueue({ keywords: 'Private search A' }, a)
  await sandbox.flush(b)
  check('switching accounts never delivers another account request', deliveredB.length, 0)
  check('other account request stays queued', (await sandbox.getPending()).length, 1)
  await sandbox.enqueue({ keywords: 'B search' }, b)
  await sandbox.flush(b)
  check('matching destination delivered', deliveredB[0].keywords, 'B search')
  const row = (await sandbox.getPending())[0]
  await sandbox.editPending(row.id, { keywords: 'Edited A', location: 'Sydney' })
  await Promise.all([sandbox.flush(a), sandbox.flush(a)])
  check('concurrent flushes deliver once', deliveredA.length, 1)
  check('edited search delivered', deliveredA[0], { keywords: 'Edited A', location: 'Sydney' })
  await sandbox.enqueue({ keywords: 'Cancelled' }, a)
  await sandbox.cancelPending((await sandbox.getPending())[0].id)
  check('cancel removes request', (await sandbox.getPending()).length, 0)
  raw = JSON.stringify([{ id: 'legacy', keywords: 'Unknown owner' }])
  await sandbox.flush(a)
  check('legacy queue is quarantined', (await sandbox.getPending()).length, 1)
  await sandbox.cancelPending('legacy')
  await sandbox.enqueue({ keywords: 'Retry me' }, a)
  await sandbox.flush({ ...a, requestScan: async () => { throw new Error('Offline') } })
  check('failed request remains with explanation', (await sandbox.getPending())[0].lastError, 'Offline')
  await sandbox.flush(a)
  check('retry clears delivered request', (await sandbox.getPending()).length, 0)
  raw = 'corrupt json'
  let rejected = false
  try { await sandbox.enqueue({ keywords: 'Do not erase' }, a) } catch { rejected = true }
  check('corruption is reported instead of erasing the queue', rejected && raw === 'corrupt json', true)
  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
