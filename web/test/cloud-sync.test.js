// Cloud-sync reconciliation: the subtlest logic in the app, and the one whose
// regressions are silent (a dropped edit looks like nothing happened).
//
// The contract: a phone edit is detected by VERSION EQUALITY — does the remote
// updated_at differ from the one we last pushed or saw (cloud_updated_at)? —
// never by comparing the phone's clock against the desktop's.

const { stub, service, createChecker } = require('./helpers')

// ── Fake local database ───────────────────────────────────────────
let rows = []
// Desktop-owned mirrors: the phone only reads these, so sync pushes the whole
// current set and deletes whatever the cloud still has that no longer exists.
let interviewRows = []
let attentionRows = []
const byId = (id) => rows.find(r => r.id === id)

const db = {
  // Real batch() suppresses intermediate full-database writes and flushes once
  // at the end. Behaviour is identical from the caller's side, so the fake just
  // runs the body.
  batch: (fn) => fn(),
  getApplication: (id) => byId(id) || null,
  getAllApplicationIds: () => rows.map(r => r.id),
  getDirtyApplications: () => rows.filter(r => r.cloud_dirty === 1 || r.cloud_updated_at == null),
  markCloudSynced: (id, cloudUpdatedAt, localUpdatedAt) => {
    const r = byId(id)
    if (r && r.updated_at === localUpdatedAt) { r.cloud_dirty = 0; r.cloud_updated_at = cloudUpdatedAt }
  },
  markCloudSeen: (id, cloudUpdatedAt) => { const r = byId(id); if (r) r.cloud_updated_at = cloudUpdatedAt },
  getAllInterviewEventsForSync: () => interviewRows,
  getAttentionJobs: () => attentionRows,
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
// Per-table records, so a mirror push can be asserted without being confused
// with the applications push.
let upsertedBy = {}
let keptBy = {}
// Tables the fake should pretend don't exist, to exercise the graceful-skip
// path for a project that hasn't re-run schema.sql.
let missingTables = new Set()
// Distinct from missingTables on purpose: an RLS denial quotes the table name
// too, and the old substring check treated it as "this project hasn't created
// the table yet" — so a genuinely broken mirror was skipped silently forever.
let rlsTables = new Set()

function makeQuery(table) {
  const q = {
    _rows: table === 'applications' ? remoteRows : [],
    select() { return q },
    eq() { return q },
    gte() { return q },
    in(_col, vals) { deletedLocalIds.push(...vals); return q },
    // Used by the mirrors to delete everything EXCEPT the current local ids.
    not(_col, _op, vals) {
      keptBy[table] = String(vals).replace(/[()]/g, '').split(',').filter(Boolean).map(Number)
      return q
    },
    order() { return q },
    delete() { q._deleting = true; return q },
    upsert(payload) {
      if (missingTables.has(table)) {
        return Promise.resolve({ error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } })
      }
      if (rlsTables.has(table)) {
        return Promise.resolve({ error: { code: '42501', message: `new row violates row-level security policy for table "${table}"` } })
      }
      upserted.push(...payload)
      upsertedBy[table] = (upsertedBy[table] || []).concat(payload)
      return Promise.resolve({ error: null })
    },
    then(res) {
      let error = null
      if (missingTables.has(table)) {
        error = { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }
      } else if (rlsTables.has(table)) {
        error = { code: '42501', message: `new row violates row-level security policy for table "${table}"` }
      }
      return Promise.resolve({ data: q._rows, error }).then(res)
    },
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

const reset = () => {
  upserted = []; deletedLocalIds = []; upsertedBy = {}; keptBy = {}
  interviewRows = []; attentionRows = []; missingTables = new Set(); rlsTables = new Set()
}

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

  // ── Desktop-owned mirrors ───────────────────────────────────────
  // Interviews and attention jobs are pushed as a full set: the phone can't
  // edit them, so there's nothing to reconcile, only to replicate.
  rows = []
  remoteRows = []
  reset()
  interviewRows = [{
    id: 5, application_id: 1, scheduled_at: '2026-08-14 14:30:00', has_time: 1,
    source: 'inbox', note: 'Invite', job_title: 'Dev', company: 'Acme', platform: 'Seek',
  }]
  attentionRows = [{
    id: 9, job_title: 'Lead', company: 'Globex', platform: 'Indeed', salary: '$150k',
    salary_min: 150000, salary_max: 150000, job_url: 'https://x/1', match_score: 71,
    talking_points: '[]', reason: 'Requires manual application', closing_date: null,
    found_at: '2026-08-01 09:00:00',
  }]
  await cloudSync.sync()

  check('sync completed without error', cloudSync.getStatus().error, null)
  check('interview mirrored to cloud', upsertedBy.interview_events?.[0]?.local_id, 5)
  check('interview carries its application id', upsertedBy.interview_events?.[0]?.application_local_id, 1)
  check('interview has_time normalised to boolean', upsertedBy.interview_events?.[0]?.has_time, true)
  check('interview keeps the desktop local time', upsertedBy.interview_events?.[0]?.scheduled_at, '2026-08-14 14:30:00')
  check('attention job mirrored to cloud', upsertedBy.attention_jobs?.[0]?.local_id, 9)
  check('attention job carries parsed salary', upsertedBy.attention_jobs?.[0]?.salary_min, 150000)
  // Anything the cloud still holds that isn't in the local set is removed.
  check('mirror keeps only current interview ids', keptBy.interview_events, [5])
  check('mirror keeps only current attention ids', keptBy.attention_jobs, [9])

  // An empty local set must delete everything rather than build an invalid
  // `not in ()` clause.
  reset()
  await cloudSync.sync()
  check('empty mirror still syncs cleanly', cloudSync.getStatus().error, null)
  check('empty mirror issues an unfiltered delete', keptBy.interview_events, undefined)

  // ── Optional tables ─────────────────────────────────────────────
  // A Supabase project that hasn't re-run schema.sql has no mirror tables. That
  // must not fail the whole sync and take applications down with it.
  reset()
  interviewRows = [{
    id: 5, application_id: 1, scheduled_at: '2026-08-14 14:30:00', has_time: 1,
    source: 'inbox', note: '', job_title: 'Dev', company: 'Acme', platform: 'Seek',
  }]
  missingTables = new Set(['interview_events', 'attention_jobs'])
  await cloudSync.sync()
  check('missing mirror tables do not fail the sync', cloudSync.getStatus().error, null)

  // ── A real failure must NOT be mistaken for a missing table ─────
  // RLS denials and permission errors quote the table name, and the old
  // substring check swallowed them as "not set up yet" — so a mirror that was
  // genuinely broken looked like an optional feature nobody had enabled.
  reset()
  attentionRows = [{ id: 9, job_title: 'Dev', company: 'Acme', platform: 'Seek' }]
  rlsTables = new Set(['attention_jobs'])
  await cloudSync.sync()
  check('an RLS denial is surfaced, not swallowed', /row-level security/.test(cloudSync.getStatus().error || ''), true)

  done()
})()
