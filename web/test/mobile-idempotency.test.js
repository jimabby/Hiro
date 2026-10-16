// A phone that loses the reply to "start a scan" retries it from its offline
// queue with the same Idempotency-Key. The desktop must answer the retry with
// the first result instead of starting a second scan.

const { stub, service, createChecker } = require('./helpers')

const TOKEN = 'e'.repeat(32)
const PORT = 48241
const cfg = { mobileApiEnabled: true, mobileApiPort: PORT, mobileApiToken: TOKEN }

let scans = 0
let imports = 0

stub({
  './config': {
    load: () => cfg,
    update: (patch) => Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch),
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': { getStats: () => ({}) },
  './featureHub': {
    importJob: (body) => {
      imports++
      return body.url ? { success: true, id: imports } : { success: false, reason: 'No URL' }
    },
  },
  './scheduler': {
    getScanInfo: () => ({ running: false }),
    requestScan: () => ({ id: `scan-${++scans}` }),
    cancelScan: () => {},
  },
  './logger': { append: () => {}, tail: () => [] },
})

const mobileApi = service('mobileApi.js')
const { check, done } = createChecker()

const post = async (path, body, key) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

;(async () => {
  await mobileApi.start()

  const first = await post('/api/scan', { keywords: 'react' }, 'retry-1')
  const again = await post('/api/scan', { keywords: 'react' }, 'retry-1')
  check('the first request starts a scan', first.body?.id, 'scan-1')
  check('a retry with the same key is answered from the first', again.body?.id, 'scan-1')
  check('and only one scan ran', scans, 1)

  // Two copies racing each other still run once.
  const [a, b] = await Promise.all([
    post('/api/scan', {}, 'race-1'),
    post('/api/scan', {}, 'race-1'),
  ])
  check('racing copies get the same answer', a.body?.id === b.body?.id, true)
  check('and run once', scans, 2)

  await post('/api/scan', {}, 'other-key')
  check('a different key is a different request', scans, 3)

  await post('/api/scan', {})
  await post('/api/scan', {})
  check('requests without a key are not deduplicated', scans, 5)

  await post('/api/scan', {}, 'not a valid key!')
  check('a malformed key is ignored rather than trusted', scans, 6)

  const imp1 = await post('/api/import-job', { url: 'https://example.com/job/1' }, 'imp-1')
  const imp2 = await post('/api/import-job', { url: 'https://example.com/job/1' }, 'imp-1')
  check('an import retry replays the first result', imp2.body?.id, imp1.body?.id)
  check('and imports once', imports, 1)

  const bad = await post('/api/import-job', {}, 'imp-bad')
  check('a refused import is still replayed with its status', bad.status, 400)

  await mobileApi.stop()
  done()
})()
