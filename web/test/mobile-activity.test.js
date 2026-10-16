// The per-device request log behind Settings → Mobile App → View activity.
//
// "Last seen" says a device token is being used, not what for. This keeps the
// last 200 requests per device — in memory, and in a small file of its own so
// the history survives a restart without rewriting config.json per request.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-activity-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
stub({ './config': { CONFIG_DIR: TMP, load: () => ({}) } })

const activity = service('mobileActivity.js')
const { check, done } = createChecker()

activity.record('phone', { method: 'GET', path: '/api/stats', ip: '192.168.1.5', status: 200, at: 1000 })
activity.record('phone', { method: 'POST', path: '/api/applications?search=secret', ip: '192.168.1.5', status: 403, at: 2000 })
activity.record('other', { method: 'GET', path: '/api/ping', ip: '192.168.1.9', status: 200, at: 3000 })

const list = activity.list('phone')
check('entries are per device', list.length, 2)
check('newest first', list.map(e => e.status), [403, 200])
check('the query string is dropped', list[0].path, '/api/applications')
check('the time, address and method are kept', [list[1].at, list[1].ip, list[1].method], [new Date(1000).toISOString(), '192.168.1.5', 'GET'])
check('an unknown device has no activity', activity.list('nobody'), [])

// A ring buffer: the oldest drop off once full.
for (let i = 0; i < activity.MAX_PER_DEVICE + 50; i++) {
  activity.record('busy', { method: 'GET', path: `/api/n${i}`, ip: '10.0.0.2', status: 200 })
}
const busy = activity.list('busy')
check('a device keeps at most the ring size', busy.length, activity.MAX_PER_DEVICE)
check('the newest entry is kept', busy[0].path, `/api/n${activity.MAX_PER_DEVICE + 49}`)
check('the oldest have been dropped', busy.some(e => e.path === '/api/n0'), false)

// Persisted, and read back after a restart.
activity.flush()
const file = path.join(TMP, 'mobile-activity.json')
check('the log is written to its own file', fs.existsSync(file), true)
activity._reset()
check('it survives a restart', activity.list('phone').map(e => e.path), ['/api/applications', '/api/stats'])

// A revoked device's history goes with it.
activity.forget('phone')
activity.flush()
activity._reset()
check('forgetting a device removes its history', activity.list('phone'), [])
check('without touching anyone else\'s', activity.list('other').length, 1)

// A corrupt file is an empty log, not a crash.
fs.writeFileSync(file, '{ not json')
activity._reset()
check('an unreadable file starts an empty log', activity.list('other'), [])
activity.record('other', { method: 'GET', path: '/api/ping', ip: '::1', status: 200 })
check('and recording still works', activity.list('other').length, 1)
activity._reset()

done()
