// Practice away from home Wi-Fi (cloudSync.syncPractice): the desktop applies
// the phone's encrypted practice events once each, and publishes today's cards
// as one encrypted snapshot.

const crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')

const KEY = crypto.randomBytes(32).toString('base64')
let cfg = { cloudDataKey: KEY }
const logs = []
stub({
  './config': { load: () => cfg, update: () => cfg },
  './database': { getTombstones: () => [], countSyncConflicts: () => 0 },
  './logger': { append: (m) => logs.push(m) },
})
const cloudSync = service('cloudSync')
const cloudCrypto = service('cloudCrypto')
const { check, done } = createChecker()
const USER = { id: '11111111-2222-4333-8444-555555555555' }

// An in-memory stand-in for the two Supabase tables.
function fakeCloud({ missing = false } = {}) {
  const db = { events: [], snapshot: null, upserts: 0 }
  const missingError = { code: 'PGRST205', message: 'Could not find the table public.practice_events in the schema cache' }
  const c = {
    from(table) {
      if (table === 'practice_events') {
        return {
          select: () => {
            const q = { eq: () => q, order: () => q, then: (ok, fail) => Promise.resolve(missing ? { data: null, error: missingError } : { data: db.events.map(e => ({ ...e })), error: null }).then(ok, fail) }
            return q
          },
          delete: () => {
            let ids = []
            const q = {
              in: (_, list) => { ids = list; return q },
              eq: () => q,
              select: async () => {
                const claimed = db.events.filter(e => ids.includes(e.id))
                db.events = db.events.filter(e => !ids.includes(e.id))
                return { data: claimed.map(e => ({ id: e.id })), error: null }
              },
            }
            return q
          },
        }
      }
      if (table === 'practice_snapshot') {
        return { upsert: async (row) => { db.snapshot = row; db.upserts++; return { error: null } } }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { c, db }
}

const event = (id, body, contextId = id) => ({
  id, created_at: '2026-11-21T09:00:00Z',
  payload: cloudCrypto.encrypt(KEY, body, cloudCrypto.rowContext('practice_events', contextId, 'payload')),
})

;(async () => {
  const calls = []
  const practice = {
    rate: (cardId, rating, { now }) => { calls.push(['rate', cardId, rating, now.toISOString()]); return { success: true } },
    saveNote: (cardId, note) => { calls.push(['note', cardId, note]); return { success: true } },
    flag: (cardId, reason) => { calls.push(['flag', cardId, reason]); return { success: true } },
    forPhone: () => ({ day: '2026-11-21', cards: [{ id: 'node-001', question: 'What is Node.js?' }], queue: ['node-001'] }),
  }
  const { c, db } = fakeCloud()
  db.events.push(
    event('a0000000-0000-4000-8000-000000000001', { type: 'rate', cardId: 'node-001', rating: 'good', at: '2026-11-20T21:15:00.000Z' }),
    event('a0000000-0000-4000-8000-000000000002', { type: 'note', cardId: 'node-001', note: 'my example' }),
    event('a0000000-0000-4000-8000-000000000003', { type: 'flag', cardId: 'node-002', reason: 'wrong' }),
    // An envelope moved onto another row is refused, not applied.
    event('a0000000-0000-4000-8000-000000000004', { type: 'rate', cardId: 'node-009', rating: 'easy' }, 'a0000000-0000-4000-8000-000000000099'),
  )

  const first = await cloudSync._syncPractice(c, USER, { practice })
  check('the phone\'s rating is applied with the time it was made', calls[0], ['rate', 'node-001', 'good', '2026-11-20T21:15:00.000Z'])
  check('notes and reports are applied too', calls.slice(1), [['note', 'node-001', 'my example'], ['flag', 'node-002', 'wrong']])
  check('a moved envelope is dropped and logged', logs.some(l => /could not be read and was dropped/.test(l)), true)
  check('every event is claimed from the cloud', db.events.length, 0)
  check('three changes applied', first.applied, ['rate', 'note', 'flag'])

  const opened = cloudCrypto.decrypt(KEY, db.snapshot.payload, cloudCrypto.rowContext('practice_snapshot', USER.id, 'payload'))
  check('today\'s cards are published, encrypted', [opened.day, opened.cards[0].id, typeof opened.generatedAt], ['2026-11-21', 'node-001', 'string'])
  check('the snapshot is not stored in the clear', db.snapshot.payload.includes('What is Node.js?'), false)

  await cloudSync._syncPractice(c, USER, { practice })
  check('an unchanged snapshot is not uploaded again', db.upserts, 1)
  check('and events already applied are not applied twice', calls.length, 3)

  cfg = {}
  check('nothing is published without a cloud key', (await cloudSync._syncPractice(fakeCloud().c, USER, { practice })).skipped, 'no-key')
  cfg = { cloudDataKey: KEY }
  cloudSync._resetPracticeSnapshot()
  check('a project without the tables is skipped quietly', (await cloudSync._syncPractice(fakeCloud({ missing: true }).c, USER, { practice })).skipped, 'no-table')

  done()
})().catch(err => { console.error(err); process.exit(1) })
