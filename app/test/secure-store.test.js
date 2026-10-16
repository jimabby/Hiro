// Keychain chunking: a value is committed by one pointer write, so a write that
// fails or races partway never leaves no value, or a mix of two.
const fs = require('fs'), path = require('path'), vm = require('vm')
const { createChecker } = require('./helpers')
const { check, done } = createChecker()

const keychain = new Map(), plain = new Map()
let failSetAfter = Infinity // fail the Nth setItemAsync from now
const tick = () => new Promise(r => setTimeout(r, Math.random() * 3))
const SecureStore = {
  isAvailableAsync: async () => true,
  getItemAsync: async k => { await tick(); return keychain.has(k) ? keychain.get(k) : null },
  setItemAsync: async (k, v) => {
    await tick()
    if (failSetAfter-- <= 0) throw new Error('keychain write failed')
    keychain.set(k, v)
  },
  deleteItemAsync: async k => { await tick(); keychain.delete(k) },
}
const AsyncStorage = {
  getItem: async k => (plain.has(k) ? plain.get(k) : null),
  setItem: async (k, v) => { plain.set(k, v) },
  removeItem: async k => { plain.delete(k) },
}
const sandbox = { SecureStore, AsyncStorage, console, setTimeout, Promise, Date, Math }
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/secureStore.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default {', 'var store = {'), sandbox)
const store = sandbox.store

const big = n => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
const chunkKeys = () => [...keychain.keys()].filter(k => /\.g[a-z0-9]+\.\d+$/.test(k))

;(async () => {
  const a = big(4000), b = big(2500).toUpperCase()
  await store.setItem('hiro.session', a)
  check('round-trips a multi-chunk value', await store.getItem('hiro.session'), a)
  check('three chunks under one generation', chunkKeys().length, 3)

  await store.setItem('hiro.session', b)
  check('overwrite reads the new value', await store.getItem('hiro.session'), b)
  check('the old generation is cleaned up', chunkKeys().length, 2)

  // A write that fails partway leaves the previous value in place.
  failSetAfter = 1
  let threw = false
  try { await store.setItem('hiro.session', a) } catch { threw = true }
  failSetAfter = Infinity
  check('a failed write reports the failure', threw, true)
  check('and the previous value survives it', await store.getItem('hiro.session'), b)
  check('and leaves no orphaned chunks', chunkKeys().length, 2)

  // Concurrent writes are serialised: the result is one whole value.
  const values = [big(3100), big(1700).toUpperCase(), big(5000)]
  await Promise.all(values.map(v => store.setItem('hiro.session', v)))
  const result = await store.getItem('hiro.session')
  check('concurrent writes leave one complete value', values.includes(result), true)
  check('the last write wins', result, values[2])
  check('only the winning generation remains', chunkKeys().length, 4)

  // Reads interleaved with writes never see a half-written value.
  const seen = await Promise.all([
    store.setItem('hiro.session', a), store.getItem('hiro.session'),
    store.setItem('hiro.session', b), store.getItem('hiro.session'),
  ])
  check('interleaved reads see whole values', [seen[1], seen[3]], [a, b])

  // The pre-generation layout is still read, then replaced on the next write.
  keychain.set('hiro.connection__chunks', '2')
  keychain.set('hiro.connection.0', 'legacy-')
  keychain.set('hiro.connection.1', 'value')
  check('legacy chunk layout is read', await store.getItem('hiro.connection'), 'legacy-value')
  await store.setItem('hiro.connection', 'new')
  check('legacy layout is removed on write', [keychain.has('hiro.connection__chunks'), keychain.has('hiro.connection.0')], [false, false])
  check('and the new value reads back', await store.getItem('hiro.connection'), 'new')

  // AsyncStorage migration still works.
  plain.set('hiro.deviceId', 'abc123')
  check('plaintext value migrates', await store.getItem('hiro.deviceId'), 'abc123')
  check('and the plaintext copy is erased', plain.has('hiro.deviceId'), false)

  await store.removeItem('hiro.session')
  check('remove clears the value', await store.getItem('hiro.session'), null)

  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
