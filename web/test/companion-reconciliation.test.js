// Exercise real SQLite plus the phone's actual CloudClient code against the
// same simulated server. Unit tests of either side alone missed these bugs.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-companion-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
let cfg = { cloudSyncEnabled: true, supabaseUrl: 'https://test.invalid', supabaseAnonKey: 'anon', supabaseRefreshToken: 'refresh', cloudFirstSyncChoice: 'merge', deviceId: 'desktop-A', cloudDataKey: crypto.randomBytes(32).toString('base64') }
const tables = { applications: [], devices: [], scan_requests: [], review_requests: [], interview_events: [], attention_jobs: [], offers: [] }
let failUploads = false
function query(table) {
  let where = [], action = 'select', payload, conflict = [], range = null, single = false
  const q = {
    select() { return q }, eq(k, v) { where.push(r => r[k] === v); return q },
    in(k, v) { where.push(r => v.includes(r[k])); return q },
    not(k, op, v) { const ids = v.slice(1, -1).split(',').map(Number); where.push(r => !ids.includes(r[k])); return q },
    order() { return q }, range(a, b) { range = [a, b]; return q }, maybeSingle() { single = true; return q },
    delete() { action = 'delete'; return q }, update(data) { action = 'update'; payload = data; return q },
    upsert(data, options) { action = 'upsert'; payload = Array.isArray(data) ? data : [data]; conflict = (options?.onConflict || 'id').split(','); return q },
    then(ok, bad) {
      if (failUploads && table === 'applications' && action === 'upsert') return Promise.resolve({ error: { message: 'Offline upload' } }).then(ok, bad)
      let rows = tables[table] || [], matched = rows.filter(r => where.every(test => test(r)))
      if (action === 'delete') tables[table] = rows.filter(r => !matched.includes(r))
      if (action === 'update') matched.forEach(r => Object.assign(r, payload))
      if (action === 'upsert') {
        for (const row of payload) {
          const old = rows.find(r => conflict.every(k => r[k] === row[k]))
          if (old) Object.assign(old, row); else rows.push({ id: crypto.randomUUID(), ...row })
        }
        tables[table] = rows
      }
      if (range) matched = matched.slice(range[0], range[1] + 1)
      return Promise.resolve({ data: single ? structuredClone(matched[0] || null) : structuredClone(matched), count: matched.length, error: null }).then(ok, bad)
    },
  }
  return q
}
const server = { from: query, auth: { refreshSession: async () => ({ data: { session: { refresh_token: 'refresh' }, user: { id: 'user' } }, error: null }) } }
stub({
  './config': { CONFIG_DIR: tmp, load: () => cfg, update: p => { cfg = { ...cfg, ...p }; return cfg } },
  './logger': { append() {} }, '@supabase/supabase-js': { createClient: () => server },
})
const db = service('database'), sync = service('cloudSync'), encryption = service('cloudCrypto')
const { check, done } = createChecker()
const phoneSource = fs.readFileSync(path.join(__dirname, '../../app/src/supabase.js'), 'utf8')
const sandbox = {
  supabase: server, url: cfg.supabaseUrl, console, randomUUID: crypto.randomUUID,
  // Same signatures as app/src/cloudCrypto.js: an optional row context that
  // binds the envelope to the row it is written to.
  decryptCloudPayload: async (p, context) => encryption.decrypt(cfg.cloudDataKey, p, context),
  encryptCloudPayload: async (p, context) => encryption.encrypt(cfg.cloudDataKey, p, context),
  rowContext: encryption.rowContext,
}
vm.createContext(sandbox)
vm.runInContext(phoneSource.slice(phoneSource.indexOf('const VALID_STATUSES')).replace('export class CloudClient', 'class CloudClient') + '\nglobalThis.Client = CloudClient;', sandbox)
const phone = new sandbox.Client('user')
;(async () => {
  await db.init()
  const local = db.insertApplication({ job_title: 'Engineer', company: 'Local Co', platform: 'Seek', job_url: 'https://local/job', job_description: '', status: 'applied' })
  const remoteId = crypto.randomUUID()
  tables.applications.push({ id: remoteId, user_id: 'user', local_id: local.id, job_title: 'Designer', company: 'Remote Co', platform: 'Seek', job_url: 'https://remote/job', status: 'applied', updated_at: '2026-01-01T00:00:00Z', next_action_at: '2026-10-20', next_action_note: 'Call' })
  let status = await sync.sync()
  check('collision sync succeeds', status.error, null)
  check('keep both retains both local jobs', db.countApplications(), 2)
  check('keep both retains both cloud jobs', tables.applications.length, 2)
  check('existing remote identity unchanged', tables.applications.find(r => r.id === remoteId).job_title, 'Designer')
  const localId = db.getApplication(local.id).cloud_id
  check('new job has a distinct UUID', typeof localId === 'string' && localId !== remoteId, true)
  check('restored follow-up retains date', db.getApplicationByCloudId(remoteId).next_action_at, '2026-10-20')
  db.updateApplicationComment(local.id, 'Old desktop comment'); await sync.sync()
  await phone.updateComment(localId, 'New private phone comment')
  const uploaded = tables.applications.find(r => r.id === localId)
  check('phone leaves plaintext blank', uploaded.comment, '')
  check('phone writes authenticated ciphertext', encryption.decrypt(cfg.cloudDataKey, uploaded.encrypted_comment).comment, 'New private phone comment')
  check('reload displays new comment', (await phone.getApplication(localId)).comment, 'New private phone comment')
  await sync.sync()
  check('desktop receives phone comment', db.getApplication(local.id).comment, 'New private phone comment')
  await phone.setNextAction(localId, { date: '2026-10-22', note: 'References' }); await sync.sync()
  check('desktop receives phone date', db.getApplication(local.id).next_action_at, '2026-10-22')
  check('desktop receives phone note', db.getApplication(local.id).next_action_note, 'References')
  await phone.completeNextAction(localId); await sync.sync()
  check('phone completion clears desktop reminder', db.getApplication(local.id).next_action_at, null)
  check('phone completion records completion', !!db.getApplication(local.id).next_action_done_at, true)
  db.setNextAction(local.id, { date: '2026-10-24', note: 'Portfolio' }); await sync.sync()
  check('desktop follow-up reaches phone', (await phone.getApplication(localId)).next_action_at, '2026-10-24')
  const items = db.updateChecklist(local.id, { title: 'Prepare references', due: '2026-10-23' })
  db.updateChecklist(local.id, { id: items[0].id, done: true })
  await sync.sync()
  const payload = tables.applications.find(r => r.id === localId).encrypted_checklist
  check('checklist sync is encrypted', JSON.parse(encryption.decrypt(cfg.cloudDataKey, payload).checklist)[0].done, true)
  check('phone reads encrypted checklist', (await phone.getChecklist(localId))[0].title, 'Prepare references')
  const mobileTasks = await phone.updateChecklist(localId, { title: 'Phone task', due: '2026-10-25' })
  check('phone can add a task', mobileTasks.length, 2)
  await sync.sync()
  check('phone task reaches desktop', db.getChecklist(local.id)[1].title, 'Phone task')
  db.updateChecklist(local.id, { title: 'Send portfolio' })
  failUploads = true; status = await sync.sync()
  check('failure surfaces pending application', status.failedItems.some(r => r.id === local.id), true)
  check('failed upload remains dirty', db.getApplication(local.id).cloud_dirty, 1)
  failUploads = false; status = await sync.sync()
  check('retry clears failed uploads', status.failedItems.length, 0)
  check('retry clears pending changes', status.pendingChanges.length, 0)
  db.deleteApplication(local.id); await sync.sync()
  check('UUID tombstone deletes only its own job', tables.applications.map(r => r.id), [remoteId])
  check('unrelated colliding job remains local', db.countApplications(), 1)
  const legacy = db.insertApplication({ job_title: 'Legacy job', company: 'Existing Co', platform: 'Seek', job_url: 'https://legacy/job', job_description: '', status: 'applied' })
  const legacyCloudId = crypto.randomUUID()
  tables.applications.push({ id: legacyCloudId, user_id: 'user', local_id: legacy.id, job_title: 'Legacy job', company: 'Existing Co', platform: 'Seek', job_url: 'https://legacy/job', status: 'applied', updated_at: '2026-01-01T00:00:00Z' })
  tables.attention_jobs.push({ id: crypto.randomUUID(), user_id: 'user', source_device: 'desktop-B', local_id: 1 })
  await sync.sync()
  check('legacy matching row adopts its existing cloud UUID', db.getApplication(legacy.id).cloud_id, legacyCloudId)
  check('legacy migration does not duplicate applications', db.countApplications(), 2)
  check('sync preserves another desktop mirror', tables.attention_jobs.length, 1)
  server.auth.signInWithPassword = async () => ({ data: { session: { refresh_token: 'refresh' }, user: { id: 'user' } }, error: null })
  server.auth.signOut = async () => ({ error: null })
  await sync.signIn('user@example.com', 'new-password-for-test')
  for (let attempt = 0; sync.getStatus().syncing && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  check('password reset rewrites known UUIDs before decrypting old data', sync.getStatus().error, null)
  check('password reset preserves application identities', tables.applications.length, 2)
  check('rewritten metadata uses the new key', encryption.decrypt(cfg.cloudDataKey, tables.applications.find(r => r.id === legacyCloudId).encrypted_meta).job_title, 'Legacy job')
  await sync.signOut()
  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
