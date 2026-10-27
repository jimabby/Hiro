// Phone → desktop commands over the cloud: changing, cancelling and re-deciding.
// The fake below behaves like PostgREST for the calls cloudCommands.js makes,
// including the partial unique index from schema.sql (one queued/accepted/
// running review per application), so a finished command is history and an
// active one is exclusive.
const fs = require('fs'), path = require('path'), vm = require('vm')
const { createChecker } = require('./helpers')
const { check, done } = createChecker()

const sandbox = { console }
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/cloudCommands.js'), 'utf8')
  .replaceAll('export async function', 'async function')
  .replaceAll('export function', 'function')
  .replaceAll('export const', 'var'), sandbox)
const cmd = sandbox

const ACTIVE = ['queued', 'accepted', 'running']
let seq = 0
const newId = () => `id-${++seq}`

function fakeDb(tables) {
  const violates = (table, row, except) => table === 'review_requests' && ACTIVE.includes(row.status) &&
    tables[table].some(r => r !== except && r.user_id === row.user_id && r.application_cloud_id === row.application_cloud_id && ACTIVE.includes(r.status))
  return {
    from(table) {
      const filters = []
      const match = r => filters.every(f => f(r))
      const q = {
        eq(k, v) { filters.push(r => r[k] === v); return q },
        in(k, vs) { filters.push(r => vs.includes(r[k])); return q },
        order() { return q },
        limit(n) { q._limit = n; return q },
        select() { q._select = true; return q },
        insert(row) {
          const full = { id: newId(), status: 'queued', created_at: new Date(Date.now() + seq).toISOString(), claimed_by: null, error: '', ...row }
          if (violates(table, full)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } })
          tables[table].push(full)
          return Promise.resolve({ error: null })
        },
        update(patch) { q._patch = patch; return q },
        then(resolve, reject) {
          try {
            if (q._patch) {
              const hits = tables[table].filter(match)
              for (const r of hits) {
                if (violates(table, { ...r, ...q._patch }, r)) return resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
              }
              hits.forEach(r => Object.assign(r, q._patch))
              return resolve({ data: hits.map(r => ({ ...r })), error: null })
            }
            const rows = tables[table].filter(match).sort((a, b) => b.created_at.localeCompare(a.created_at))
            resolve({ data: rows.slice(0, q._limit ?? rows.length).map(r => ({ ...r })), error: null })
          } catch (e) { reject(e) }
        },
      }
      return q
    },
  }
}

// The desktop's side of the contract, reduced to the conditional writes it
// makes (web/electron/services/cloudCommands.js): claim queued → accepted, then
// start accepted → running, each conditional on the id it read.
function desktopClaim(db, row) {
  return db.from('review_requests').update({ status: 'accepted', claimed_by: 'desk' }).eq('id', row.id).eq('status', 'queued').select('*')
}
function desktopStart(db, row) {
  return db.from('review_requests').update({ status: 'running' }).eq('id', row.id).eq('status', 'accepted').eq('claimed_by', 'desk').select('*')
}

;(async () => {
  const tables = { review_requests: [], scan_requests: [] }
  const db = fakeDb(tables)
  const req = (app, action) => cmd.requestReviewAction(db, 'u', app, action, newId)
  const rows = app => tables.review_requests.filter(r => r.application_cloud_id === app)

  // ── Finding 1: a changed, still-queued decision replaces the old one ──
  let res = await req('job1', 'approve')
  check('first decision queued', res.queued, true)
  const firstId = rows('job1')[0].id
  res = await req('job1', 'reject')
  check('approve swapped for reject', res.replaced, 'approve')
  check('still one command for the draft', rows('job1').length, 1)
  check('the queued command is now a rejection', rows('job1')[0].action, 'reject')
  check('the replaced command has a new id', rows('job1')[0].id !== firstId, true)
  // A desktop that read the approval before the swap claims by the old id.
  const stale = await desktopClaim(db, { id: firstId })
  check('a desktop holding the replaced row cannot claim it', stale.data.length, 0)
  res = await req('job1', 'reject')
  check('repeating the same decision is a no-op', [res.queued, res.replaced], [true, undefined])

  // Accepted but not started: still changeable, and the desktop's start misses.
  const claimed = (await desktopClaim(db, rows('job1')[0])).data[0]
  res = await req('job1', 'approve')
  check('an accepted, unstarted decision can still be swapped', res.replaced, 'reject')
  check('the swapped row returns to the queue', [rows('job1')[0].status, rows('job1')[0].claimed_by], ['queued', null])
  check('the desktop cannot start the decision it claimed before the swap', (await desktopStart(db, claimed)).data.length, 0)

  // Running: too late, and the phone says so instead of "queued".
  const claimed2 = (await desktopClaim(db, rows('job1')[0])).data[0]
  await desktopStart(db, claimed2)
  let err = await req('job1', 'reject').catch(e => e)
  check('a running approval cannot be changed', err.tooLate, true)
  check('the message says the approval is already under way', /already processing the approval/.test(err.message), true)
  check('the running approval is untouched', [rows('job1')[0].action, rows('job1')[0].status], ['approve', 'running'])
  err = await cmd.cancelCommand(db, 'u', 'review', rows('job1')[0].id).catch(e => e)
  check('a running command cannot be cancelled', err.tooLate, true)

  // ── Finding 2: a finished command never blocks a new decision ──
  rows('job1')[0].status = 'completed'
  res = await req('job1', 'reject')
  check('after a finished command a new decision is queued', res.queued, true)
  check('the finished command stays as history', rows('job1').map(r => r.status).sort(), ['completed', 'queued'])
  check('the pending decision is the new one', (await cmd.activeReview(db, 'u', 'job1')).action, 'reject')

  // ── Cancel ──
  const pending = await cmd.activeReview(db, 'u', 'job1')
  res = await cmd.cancelCommand(db, 'u', 'review', pending.id)
  check('a queued decision can be cancelled', res.success, true)
  check('cancelled rows are not pending', await cmd.activeReview(db, 'u', 'job1'), null)
  check('a cancelled row cannot be claimed', (await desktopClaim(db, pending)).data.length, 0)
  res = await req('job1', 'approve')
  check('a decision after a cancel is queued', res.queued, true)

  tables.scan_requests.push({ id: 's1', user_id: 'u', status: 'queued' }, { id: 's2', user_id: 'u', status: 'accepted' })
  res = await cmd.cancelCommand(db, 'u', 'scan', 's1')
  check('an unclaimed scan can be cancelled', [res.success, tables.scan_requests[0].status], [true, 'cancelled'])
  err = await cmd.cancelCommand(db, 'u', 'scan', 's2').catch(e => e)
  check('a scan the desktop queued cannot be cancelled from the cloud', [err.tooLate, tables.scan_requests[1].status], [true, 'accepted'])
  err = await cmd.cancelCommand(db, 'u', 'scan', 'missing').catch(e => e)
  check('a missing command is reported', /no longer exists/.test(err.message), true)

  // ── Old schema: the full unique index still blocks after a finished row ──
  const legacy = { review_requests: [{ id: 'old', user_id: 'u', application_cloud_id: 'job9', action: 'reject', status: 'completed', created_at: '2026-01-01' }], scan_requests: [] }
  const legacyDb = fakeDb(legacy), from = legacyDb.from
  // Every insert conflicts with the finished row, as the old index did.
  legacyDb.from = t => Object.assign(from(t), { insert: () => Promise.resolve({ error: { code: '23505', message: 'duplicate key' } }) })
  err = await cmd.requestReviewAction(legacyDb, 'u', 'job9', 'approve', newId).catch(e => e)
  check('an outdated schema is named as the cause', /re-run supabase\/schema\.sql/.test(err.message), true)

  // ── Finding 3: batch approval reports every id ──
  const outcome = await cmd.approveDrafts(async id => { if (id === 'b') throw new Error('offline') }, ['a', 'b', 'c'], id => (id === 'b' ? 'Engineer at Acme' : ''))
  check('the ids after a failure are still attempted', outcome.accepted, ['a', 'c'])
  check('the failing id is reported by name', outcome.refused, [{ id: 'b', reason: 'Engineer at Acme: offline' }])
  check('partial success still counts as started', outcome.started, true)
  check('total failure is not started', (await cmd.approveDrafts(async () => { throw new Error('x') }, ['a'])).started, false)

  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
