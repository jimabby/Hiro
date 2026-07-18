// Cloud-sync reconciliation: the subtlest logic in the app, and the one whose
// regressions are silent (a dropped edit looks like nothing happened).
//
// The contract: a phone edit is detected by VERSION EQUALITY — does the remote
// updated_at differ from the one we last pushed or saw (cloud_updated_at)? —
// never by comparing the phone's clock against the desktop's.

const { stub, service, createChecker } = require('./helpers')

// ── Fake local database ───────────────────────────────────────────
let rows = []
const byId = (id) => rows.find(r => r.id === id)

const db = {
  getApplication: (id) => byId(id) || null,
  getAllApplicationIds: () => rows.map(r => r.id),
  getDirtyApplications: () => rows.filter(r => r.cloud_dirty === 1 || r.cloud_updated_at == null),
  markCloudSynced: (id, cloudUpdatedAt, localUpdatedAt) => {
    const r = byId(id)
    if (r && r.updated_at === localUpdatedAt) { r.cloud_dirty = 0; r.cloud_updated_at = cloudUpdatedAt }
  },
  markCloudSeen: (id, cloudUpdatedAt) => { const r = byId(id); if (r) r.cloud_updated_at = cloudUpdatedAt },
  applyCloudEdit: (id, changes, cloudUpdatedAt) => {
    const r = byId(id)
    if (!r) return
    if (changes.status != null) r.status = changes.status
    if (changes.comment != null) r.comment = changes.comment
    r.cloud_updated_at = cloudUpdatedAt
    r.updated_at = '2026-01-01 00:00:05'
  },
}

// ── Fake Supabase ─────────────────────────────────────────────────
let remoteRows = []
let upserted = []
let deletedLocalIds = []

function makeQuery(table) {
  const q = {
    _rows: table === 'applications' ? remoteRows : [],
    select() { return q },
    eq() { return q },
    in(_col, vals) { deletedLocalIds.push(...vals); return q },
    order() { return q },
    delete() { q._deleting = true; return q },
    upsert(payload) { upserted.push(...payload); return Promise.resolve({ error: null }) },
    then(res) { return Promise.resolve({ data: q._rows, error: null }).then(res) },
  }
  return q
}

stub({
  './config': {
    load: () => ({ cloudSyncEnabled: true, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k', supabaseRefreshToken: 't' }),
    update: () => ({}),
    CONFIG_DIR: '/tmp/hiro-test',
  },
  './database': db,
  '@supabase/supabase-js': {
    createClient: () => ({
      auth: {
        refreshSession: async () => ({ data: { session: { refresh_token: 't' }, user: { id: 'u1' } }, error: null }),
      },
      from: (table) => makeQuery(table),
    }),
  },
})

const cloudSync = service('cloudSync.js')
const { check, done } = createChecker()

const reset = () => { upserted = []; deletedLocalIds = [] }

;(async () => {
  // ── A phone edit the desktop hasn't seen is applied locally. ────
  rows = [{
    id: 1, status: 'applied', comment: '', cloud_dirty: 0,
    updated_at: '2026-01-01 00:00:00', cloud_updated_at: '2026-01-01T00:00:00Z',
  }]
  remoteRows = [{ local_id: 1, status: 'interview', comment: 'called me', updated_at: '2026-01-02T00:00:00Z' }]
  reset()
  await cloudSync.sync()

  check('phone status edit applied locally', byId(1).status, 'interview')
  check('phone comment edit applied locally', byId(1).comment, 'called me')
  check('edit not echoed back as a push', upserted.length, 0)

  // ── An unchanged remote row is left alone. ──────────────────────
  rows = [{
    id: 1, status: 'applied', comment: 'mine', cloud_dirty: 0,
    updated_at: '2026-01-01 00:00:00', cloud_updated_at: '2026-01-02T00:00:00Z',
  }]
  remoteRows = [{ local_id: 1, status: 'rejected', comment: 'stale', updated_at: '2026-01-02T00:00:00Z' }]
  reset()
  await cloudSync.sync()

  check('unchanged remote version ignored', byId(1).status, 'applied')

  // ── Both sides changed: the desktop wins and overwrites the cloud.
  rows = [{
    id: 1, status: 'offer', comment: 'desktop', cloud_dirty: 1,
    updated_at: '2026-01-03 00:00:00', cloud_updated_at: '2026-01-01T00:00:00Z',
    job_title: 'Dev', company: 'Acme', platform: 'Seek',
  }]
  remoteRows = [{ local_id: 1, status: 'rejected', comment: 'phone', updated_at: '2026-01-02T00:00:00Z' }]
  reset()
  await cloudSync.sync()

  check('desktop wins a genuine conflict', byId(1).status, 'offer')
  check('conflicting row is pushed to cloud', upserted[0]?.status, 'offer')
  check('row marked clean after push', byId(1).cloud_dirty, 0)

  // ── Clock skew must not drop an edit: remote updated_at is OLDER
  //    than the local clock, but differs from what we last saw.
  rows = [{
    id: 1, status: 'applied', comment: '', cloud_dirty: 0,
    updated_at: '2026-06-01 00:00:00', cloud_updated_at: '2026-01-01T00:00:00Z',
  }]
  remoteRows = [{ local_id: 1, status: 'interview', comment: '', updated_at: '2026-01-02T00:00:00Z' }]
  reset()
  await cloudSync.sync()

  check('edit survives a backwards phone clock', byId(1).status, 'interview')

  // ── A cloud row with no local counterpart is deleted remotely. ──
  rows = []
  remoteRows = [{ local_id: 99, status: 'applied', comment: '', updated_at: '2026-01-02T00:00:00Z' }]
  reset()
  await cloudSync.sync()

  check('orphaned cloud row deleted', deletedLocalIds.includes(99), true)

  done()
})()
