// Incremental cloud sync, the cloud schema check, row-bound envelopes, and
// mirrors that upload only what changed. Real SQLite against a simulated
// server that stamps synced_at the way the schema.sql trigger does.

const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-incremental-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

let cfg = {
  cloudSyncEnabled: true, supabaseUrl: 'https://test.invalid', supabaseAnonKey: 'anon', supabaseRefreshToken: 'refresh',
  cloudFirstSyncChoice: 'merge', deviceId: 'desktop-A', cloudDataKey: crypto.randomBytes(32).toString('base64'),
}
const tables = { applications: [], devices: [], scan_requests: [], review_requests: [], interview_events: [], attention_jobs: [], offers: [] }
let schemaVersion = 3
// Every request the desktop makes, so a test can say what was (not) fetched.
let log = []
// The server clock: strictly increasing, like now() across transactions.
let clock = Date.parse('2026-10-16T00:00:00Z')
const stampNow = () => new Date(clock += 1000).toISOString()

function query(table) {
  let where = [], action = 'select', columns = '*', payload, conflict = [], range = null, single = false, head = false
  const q = {
    select(cols = '*', opts = {}) { if (action === 'select') { columns = cols; head = !!opts.head } return q },
    eq(k, v) { where.push(r => r[k] === v); return q },
    gte(k, v) { where.push(r => r[k] >= v); return q },
    in(k, v) { where.push(r => v.includes(r[k])); return q },
    not(k, op, v) { const ids = v.slice(1, -1).split(',').map(Number); where.push(r => !ids.includes(r[k])); return q },
    order() { return q }, range(a, b) { range = [a, b]; return q }, maybeSingle() { single = true; return q },
    delete() { action = 'delete'; return q }, update(data) { action = 'update'; payload = data; return q },
    upsert(data, options) { action = 'upsert'; payload = Array.isArray(data) ? data : [data]; conflict = (options?.onConflict || 'id').split(','); return q },
    then(ok, bad) {
      let rows = tables[table] || [], matched = rows.filter(r => where.every(test => test(r)))
      log.push({ table, action, columns, count: matched.length, head })
      // The trigger: every insert and update is stamped by the server.
      const touch = (r) => { if (table === 'applications') r.synced_at = stampNow() }
      if (action === 'delete') tables[table] = rows.filter(r => !matched.includes(r))
      if (action === 'update') matched.forEach(r => { Object.assign(r, payload); touch(r) })
      if (action === 'upsert') {
        for (const row of payload) {
          const old = rows.find(r => conflict.every(k => r[k] === row[k]))
          if (old) { Object.assign(old, row); touch(old) } else { const fresh = { id: crypto.randomUUID(), ...row }; touch(fresh); rows.push(fresh) }
        }
        tables[table] = rows
      }
      if (range) matched = matched.slice(range[0], range[1] + 1)
      const shaped = columns === '*' ? matched : matched.map(r => Object.fromEntries(columns.split(',').map(c => c.trim()).map(c => [c, r[c]])))
      return Promise.resolve({ data: head ? null : (single ? structuredClone(shaped[0] || null) : structuredClone(shaped)), count: matched.length, error: null }).then(ok, bad)
    },
  }
  return q
}
const server = {
  from: query,
  rpc: async (name) => {
    if (name !== 'hiro_schema_version') return { data: null, error: { code: 'PGRST202', message: 'no such function' } }
    if (schemaVersion == null) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.hiro_schema_version without parameters in the schema cache' } }
    return { data: schemaVersion, error: null }
  },
  auth: { refreshSession: async () => ({ data: { session: { refresh_token: 'refresh' }, user: { id: 'user' } }, error: null }) },
}
stub({
  './config': { CONFIG_DIR: tmp, load: () => cfg, update: p => { cfg = typeof p === 'function' ? p(cfg) : { ...cfg, ...p }; return cfg } },
  './logger': { append() {} }, '@supabase/supabase-js': { createClient: () => server },
  './push': { runDueChecks: async () => {}, notifyNewDevice: async () => {} },
})
const db = service('database'), sync = service('cloudSync'), envelope = service('cloudCrypto')
const { check, done } = createChecker()
const fullFetches = () => log.filter(l => l.table === 'applications' && l.action === 'select' && l.columns === '*' && !l.head)
const fetchedRows = () => fullFetches().reduce((n, l) => n + l.count, 0)
const cloudRow = (cloudId) => tables.applications.find(r => r.id === cloudId)

;(async () => {
  await db.init()

  // ── A stale cloud schema stops the sync with instructions ────────
  schemaVersion = 1
  let status = await sync.sync()
  check('a stale schema is reported', /re-run|paste the whole of supabase\/schema\.sql/i.test(status.error || ''), true)
  check('and names the versions', /version 1/.test(status.error || ''), true)
  check('nothing was uploaded first', log.some(l => l.action === 'upsert' && l.table === 'applications'), false)
  schemaVersion = null
  status = await sync.sync()
  check('a project without the version function is stale too', /schema is out of date/i.test(status.error || ''), true)
  schemaVersion = 3

  // ── First sync: full download, then the cursor takes over ─────────
  for (let i = 0; i < 5; i++) {
    db.insertApplication({ job_title: `Job ${i}`, company: 'Co', platform: 'Seek', job_url: `https://jobs/${i}`, status: 'applied' })
  }
  log = []
  status = await sync.sync()
  check('the first sync succeeds', status.error, null)
  check('all five rows reach the cloud', tables.applications.length, 5)
  // Rows this desktop just uploaded carry a newer server stamp, so the next
  // sync reads them back once. After that, nothing.
  clock += 10 * 60 * 1000
  await sync.sync()
  clock += 10 * 60 * 1000
  log = []
  await sync.sync()
  check('an idle sync downloads no full rows', fetchedRows(), 0)

  // ── A phone edit is fetched alone ─────────────────────────────────
  const target = db.getApplications({}).find(a => a.job_title === 'Job 2')
  const remote = cloudRow(target.cloud_id)
  // Simulate time passing beyond the overlap window, then a phone edit.
  clock += 60 * 60 * 1000
  remote.status = 'interview'; remote.updated_at = new Date(clock).toISOString(); remote.synced_at = stampNow()
  log = []
  await sync.sync()
  check('the phone edit is applied', db.getApplication(target.id).status, 'interview')
  check('only that row was downloaded in full', fetchedRows(), 1)

  // A phone with a slow clock: updated_at far in the past, but the server's
  // synced_at is what the cursor reads.
  clock += 60 * 60 * 1000
  remote.status = 'offer'; remote.updated_at = '2020-01-01T00:00:00Z'; remote.synced_at = stampNow()
  await sync.sync()
  check('an edit from a phone with a slow clock is not missed', db.getApplication(target.id).status, 'offer')

  // ── A row this device has never seen, older than the cursor ────────
  clock += 60 * 60 * 1000
  const otherId = crypto.randomUUID()
  tables.applications.push({
    id: otherId, user_id: 'user', local_id: 900, job_title: 'From desktop B', company: 'B', platform: 'Seek',
    job_url: 'https://b/1', status: 'applied', updated_at: '2026-10-15T00:00:00Z', synced_at: '2026-10-15T00:00:00Z',
  })
  log = []
  await sync.sync()
  check('the id listing finds a row older than the cursor', !!db.getApplicationByCloudId(otherId), true)
  check('and only it is fetched in full', fetchedRows(), 1)

  // ── Tombstones by cloud id, settled from the id listing ────────────
  db.deleteApplication(db.getApplicationByCloudId(otherId).id)
  await sync.sync()
  check('a local delete removes exactly that cloud row', !!cloudRow(otherId), false)
  check('and the tombstone is settled', db.getTombstones().length, 0)

  // ── Envelopes are bound to their row ──────────────────────────────
  const a = db.getApplications({}).find(x => x.job_title === 'Job 0')
  const b = db.getApplications({}).find(x => x.job_title === 'Job 1')
  db.updateApplicationComment(a.id, 'Comment for A')
  await sync.sync()
  const rowA = cloudRow(a.cloud_id), rowB = cloudRow(b.cloud_id)
  check('an uploaded envelope names its row', JSON.parse(rowA.encrypted_meta).ctx, `hiro:applications:${a.cloud_id}:encrypted_meta`)
  check('and opens where it belongs', envelope.decrypt(cfg.cloudDataKey, rowA.encrypted_comment, envelope.rowContext('applications', a.cloud_id, 'encrypted_comment')).comment, 'Comment for A')
  // Someone with write access copies A's comment onto B.
  clock += 60 * 60 * 1000
  rowB.encrypted_comment = rowA.encrypted_comment
  rowB.updated_at = new Date(clock).toISOString(); rowB.synced_at = stampNow()
  await sync.sync()
  check('a comment moved from another row is not applied', db.getApplication(b.id).comment, '')
  // Editing the stored context to match breaks the tag instead.
  let tampered = null
  try {
    const env = JSON.parse(rowA.encrypted_comment); env.ctx = `hiro:applications:${b.cloud_id}:encrypted_comment`
    envelope.decrypt(cfg.cloudDataKey, JSON.stringify(env), env.ctx)
  } catch (err) { tampered = err }
  check('rewriting the context to match fails authentication', !!tampered, true)

  // An older client's unbound envelope is still read, then rebound on push.
  clock += 60 * 60 * 1000
  const rowC = cloudRow(db.getApplications({}).find(x => x.job_title === 'Job 3').cloud_id)
  rowC.encrypted_comment = envelope.encrypt(cfg.cloudDataKey, { comment: 'From an older phone' })
  rowC.updated_at = new Date(clock).toISOString(); rowC.synced_at = stampNow()
  await sync.sync()
  check('an unbound legacy envelope is still read', db.getApplicationByCloudId(rowC.id).comment, 'From an older phone')
  check('and re-uploaded bound to its row', JSON.parse(cloudRow(rowC.id).encrypted_comment).ctx, `hiro:applications:${rowC.id}:encrypted_comment`)

  // ── Mirrors upload only rows that changed ─────────────────────────
  db.addInterviewEvent({ applicationId: a.id, scheduledAt: '2026-11-01 10:00:00', hasTime: true, note: 'Panel' })
  db.addInterviewEvent({ applicationId: b.id, scheduledAt: '2026-11-02 10:00:00', hasTime: true, note: 'Tech' })
  log = []
  await sync.sync()
  const interviewUploads = () => log.filter(l => l.table === 'interview_events' && l.action === 'upsert')
  check('new interviews are uploaded', tables.interview_events.length, 2)
  log = []
  await sync.sync()
  check('an unchanged interview is not uploaded again', interviewUploads().length, 0)
  const ev = db.getInterviewEvents(a.id)[0]
  db.updateInterviewEventTime(ev.id, { scheduledAt: '2026-11-03 10:00:00' })
  log = []
  await sync.sync()
  check('a changed interview is uploaded', interviewUploads().length, 1)
  // The cloud loses the rows without this desktop doing anything (a cascade).
  tables.interview_events = []
  await sync.sync()
  check('rows that vanished server-side are uploaded again', tables.interview_events.length, 2)

  // ── "Use the cloud copy" keeps the answer bank ────────────────────
  db.saveInterviewAnswer({ question: 'Tell me about yourself', answer: 'Mine', source: 'user' })
  const result = await sync.resolveFirstSync('cloud')
  check('taking the cloud copy succeeds', result.success, true)
  check('the interview answers are kept', db.listInterviewAnswers().length, 1)
  check('the applications come back from the cloud', db.countApplications(), tables.applications.length)

  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
