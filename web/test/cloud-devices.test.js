// Devices on the cloud account: registration, the two strengths of revocation,
// and new-device alerts.
//
// The honesty of this feature is the thing worth testing. Supabase gives a
// signed-in client no way to invalidate ANOTHER client's refresh token, so there
// are two mechanisms with genuinely different reach, and the UI promises exactly
// what each one does:
//
//   revokeDevice        cooperative — stamps revoked_at and kills the push token
//                       now; the device signs itself out when it next connects.
//   signOutEverywhere   authoritative — auth.signOut({ scope: 'global' }),
//                       which Supabase honours server-side for every session on
//                       the account, this desktop's included.
//
// The previously-claimed behaviour — that deleting a registry row protected a lost
// phone — was the thing that needed fixing, so "a deleted row does not revoke
// anything" is an assertion here rather than an omission.

const { stub, service, createChecker } = require('./helpers')

// ── Fake Supabase ─────────────────────────────────────────────────
let deviceRows = []
let missingColumns = new Set()
let signOutCalls = []
let deletedAll = false

function table(name) {
  const state = { filters: {}, inList: null }
  const rowsFor = () => (name === 'devices' ? deviceRows : [])
  const matches = (r) => Object.entries(state.filters).every(([k, v]) => r[k] === v)

  const api = {
    select() { return api },
    eq(col, val) { state.filters[col] = val; return api },
    order() { return api },
    limit() { return api },
    maybeSingle() {
      const found = rowsFor().find(matches)
      return Promise.resolve({ data: found || null, error: null })
    },
    then(resolve) {
      return Promise.resolve({ data: rowsFor().filter(matches), error: null, count: rowsFor().filter(matches).length }).then(resolve)
    },
    upsert(payload) {
      const bad = [...missingColumns].find(c => c in (payload[0] || {}))
      if (bad) {
        return Promise.resolve({ error: { code: 'PGRST204', message: `Could not find the '${bad}' column of 'devices' in the schema cache` } })
      }
      for (const row of payload) {
        const existing = deviceRows.find(r => r.user_id === row.user_id && r.device_id === row.device_id)
        if (existing) Object.assign(existing, row)
        else deviceRows.push({ created_at: new Date().toISOString(), ...row })
      }
      return Promise.resolve({ error: null })
    },
    update(patch) {
      const bad = [...missingColumns].find(c => c in patch)
      if (bad) {
        return Promise.resolve({ error: { code: 'PGRST204', message: `Could not find the '${bad}' column of 'devices' in the schema cache` } })
      }
      const chain = {
        eq(col, val) { state.filters[col] = val; return chain },
        then(resolve) {
          for (const r of rowsFor().filter(matches)) Object.assign(r, patch)
          return Promise.resolve({ error: null }).then(resolve)
        },
      }
      return chain
    },
    delete() {
      const chain = {
        eq(col, val) { state.filters[col] = val; return chain },
        in() { return chain },
        not() { return chain },
        select() { return chain },
        then(resolve) {
          // Only the devices table is modelled. Without this guard the
          // interview/attention mirrors — which delete by user_id with no other
          // filter — would wipe deviceRows on every sync.
          if (name === 'devices') {
            const before = deviceRows.length
            deviceRows = deviceRows.filter(r => !matches(r))
            if (!('device_id' in state.filters) && before > 0) deletedAll = true
          }
          return Promise.resolve({ error: null, data: [] }).then(resolve)
        },
      }
      return chain
    },
  }
  return api
}

const client = {
  from: (name) => table(name),
  auth: {
    signOut: (opts) => { signOutCalls.push(opts?.scope || 'local'); return Promise.resolve({ error: null }) },
    refreshSession: () => Promise.resolve({ data: { session: { refresh_token: 'r2' }, user: { id: 'user-1' } }, error: null }),
    signInWithPassword: () => Promise.resolve({ data: { user: { id: 'user-1' }, session: { refresh_token: 'r1' } }, error: null }),
  },
}

// ── Config, database and notification stubs ───────────────────────
let config = {
  supabaseUrl: 'https://x.supabase.co',
  supabaseAnonKey: 'anon',
  cloudSyncEnabled: true,
  supabaseRefreshToken: 'r1',
  deviceId: 'desktop-1',
  deviceName: 'Jim’s Laptop',
}

const pushed = []

stub({
  '@supabase/supabase-js': { createClient: () => client },
  './config': {
    CONFIG_DIR: require('os').tmpdir(),
    load: () => config,
    update: (patch) => { config = { ...config, ...patch }; return config },
  },
  './logger': { append: () => {} },
  './deviceIdentity': {
    ensureDeviceIdentity: () => config,
    resolveFirstSyncMode: () => 'merge',
    isValidChoice: () => true,
  },
  // Only the reads sync() performs on its way to registerDevice. The
  // application-reconciliation logic has its own suite (cloud-sync.test.js); an
  // empty database here keeps this one about devices. Every method sync() touches
  // has to exist, though — a missing one throws inside sync's try/catch and
  // silently skips everything after it, registerDevice included.
  './database': {
    batch: (fn) => fn(),
    countApplications: () => 0,
    getTombstones: () => [],
    clearTombstones: () => {},
    countSyncConflicts: () => 0,
    getAllApplicationIds: () => [],
    getDirtyApplications: () => [],
    getAllInterviewEventsForSync: () => [],
    getAttentionJobs: () => [],
    getOffers: () => ({ offers: [] }),
  },
  './push': {
    notifyNewDevice: async (d) => { pushed.push(d.device_id) },
    runDueChecks: async () => {},
  },
})

const cloudSync = service('cloudSync')
const { check, done } = createChecker()

// signIn() and init() both kick off a sync without awaiting it, and sync()
// returns immediately if one is already in flight. So an assertion that depends
// on a sync having finished has to wait for the loose one first, or it silently
// measures the wrong pass.
async function drain() {
  for (let i = 0; i < 100 && cloudSync.getStatus().syncing; i++) {
    await new Promise(r => setTimeout(r, 5))
  }
}

async function syncOnce() {
  await drain()
  await cloudSync.sync()
}

const other = (patch = {}) => ({
  user_id: 'user-1',
  device_id: 'phone-1',
  name: 'Jim’s iPhone',
  platform: 'ios',
  kind: 'mobile',
  created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
  session_started_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  last_seen_at: new Date().toISOString(),
  push_token: 'ExponentPushToken[abc]',
  ...patch,
})

async function main() {
  await cloudSync.signIn('me@example.com', 'pw')
  await drain()

  // ── Listing ──────────────────────────────────────────────────
  deviceRows = [
    { user_id: 'user-1', device_id: 'desktop-1', name: 'Jim’s Laptop', platform: 'win32', kind: 'desktop', last_seen_at: new Date().toISOString(), session_started_at: new Date().toISOString(), created_at: new Date().toISOString() },
    other(),
  ]
  let devices = await cloudSync.listDevices()
  check('both devices are listed', devices.length, 2)
  const me = devices.find(d => d.device_id === 'desktop-1')
  const phone = devices.find(d => d.device_id === 'phone-1')
  check('this device is identified as such', me.isThisDevice, true)
  check('the phone is not', phone.isThisDevice, false)
  // Session age is what reveals a device nobody is using any more.
  check('session age is reported', phone.sessionAgeDays, 2)
  check('time since last contact is reported', phone.lastSeenDaysAgo, 0)
  check('a registered push token is visible', phone.pushRegistered, true)
  check('and nothing is pending revocation yet', phone.revokePending, false)

  // ── Cooperative revocation ───────────────────────────────────
  let res = await cloudSync.revokeDevice('phone-1')
  check('revoking another device succeeds', res.success, true)
  // Named honestly: the sign-out has not happened yet, only been requested.
  check('and reports itself as pending', res.pending, true)
  const stored = deviceRows.find(d => d.device_id === 'phone-1')
  check('revoked_at is stamped', !!stored.revoked_at, true)
  // This part IS enforceable from here, so it happens immediately.
  check('the push token is removed straight away', stored.push_token, null)

  devices = await cloudSync.listDevices()
  check('the device is shown as pending sign-out',
    devices.find(d => d.device_id === 'phone-1').revokePending, true)

  // A revoked device must stop receiving notifications at once, without waiting
  // for it to come online.
  let targets = await cloudSync.getPushTargets()
  check('a revoked device is not a push target', targets.length, 0)

  // Revoking the device you are sitting at would strand this desktop while
  // looking like it worked.
  res = await cloudSync.revokeDevice('desktop-1')
  check('revoking this device is refused', res.success, false)
  check('and says to sign out instead', /sign out instead/i.test(res.reason), true)

  // ── Honouring a revocation ───────────────────────────────────
  // The receiving half: this desktop finds its own row stamped and signs itself
  // out, wiping the stored refresh token.
  deviceRows = [{ user_id: 'user-1', device_id: 'desktop-1', revoked_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }]
  signOutCalls = []
  await syncOnce()
  check('a revoked desktop signs itself out', signOutCalls.length >= 1, true)
  check('the stored refresh token is wiped', config.supabaseRefreshToken, '')
  check('cloud sync is switched off', config.cloudSyncEnabled, false)
  check('and the reason is reported', /revoked/i.test(cloudSync.getStatus().error), true)
  // The flag is cleared on the way out, so a deliberate sign-in later is not
  // immediately revoked again.
  check('the revocation flag is cleared', deviceRows[0].revoked_at, null)

  // ── A deleted row is NOT a revocation ────────────────────────
  // This is the behaviour the old implementation claimed to have. Removing a row
  // is bookkeeping; the device simply re-registers.
  await cloudSync.signIn('me@example.com', 'pw')
  await drain()
  deviceRows = [other()]
  config = { ...config, knownDeviceIds: ['phone-1'] }
  res = await cloudSync.forgetDevice('phone-1')
  check('forgetting a device succeeds', res.success, true)
  check('the row is gone', deviceRows.length, 0)
  check('and it is forgotten locally too', config.knownDeviceIds, [])
  signOutCalls = []
  await syncOnce()
  check('a missing row does not sign this desktop out', signOutCalls.length, 0)
  check('and it re-registers itself',
    deviceRows.some(d => d.device_id === 'desktop-1'), true)

  // ── Registration detail ──────────────────────────────────────
  const registered = deviceRows.find(d => d.device_id === 'desktop-1')
  check('the desktop registers its kind', registered.kind, 'desktop')
  check('and when this session started', !!registered.session_started_at, true)

  // A project that has not re-run schema.sql lacks the newer columns. Registration
  // must still succeed — the list is merely less detailed, and re-running the
  // script is the fix.
  deviceRows = []
  missingColumns = new Set(['session_started_at'])
  await syncOnce()
  check('registration falls back when a column is missing',
    deviceRows.some(d => d.device_id === 'desktop-1'), true)
  check('and does not report a sync error', cloudSync.getStatus().error, null)
  missingColumns = new Set()

  // ── New-device alerts ────────────────────────────────────────
  // The first pass has nothing to compare against — every device would be "new",
  // including this one — so it records and stays quiet.
  config = { ...config, knownDeviceIds: null }
  deviceRows = [other(), { user_id: 'user-1', device_id: 'desktop-1', last_seen_at: new Date().toISOString() }]
  pushed.length = 0
  let announced = []
  await cloudSync.init({ onNewDevice: (d) => announced.push(d.device_id) })
  await syncOnce()
  check('the first pass announces nothing', [pushed.length, announced.length], [0, 0])
  check('but remembers what it saw',
    (config.knownDeviceIds || []).includes('phone-1'), true)

  // Now a phone the account has never had before appears.
  deviceRows.push(other({ device_id: 'phone-2', name: 'A New Phone' }))
  pushed.length = 0
  announced = []
  await syncOnce()
  check('a genuinely new device is announced', announced, ['phone-2'])
  check('and pushed to the existing phones', pushed, ['phone-2'])

  // Once is enough.
  pushed.length = 0
  announced = []
  await syncOnce()
  check('the same device is not announced twice', [pushed.length, announced.length], [0, 0])

  // ── Push targets ─────────────────────────────────────────────
  deviceRows = [
    other({ device_id: 'p1', push_token: 't1' }),
    other({ device_id: 'p2', push_token: null }),
    other({ device_id: 'p3', push_token: 't3', push_enabled: false }),
    other({ device_id: 'p4', push_token: 't4', revoked_at: new Date().toISOString() }),
  ]
  targets = await cloudSync.getPushTargets()
  check('only devices with a token, enabled and not revoked, are targets',
    targets.map(t => t.deviceId), ['p1'])

  await cloudSync.clearPushToken('p1')
  check('a token can be cleared at the source',
    deviceRows.find(d => d.device_id === 'p1').push_token, null)

  // ── Sign out everywhere ──────────────────────────────────────
  await cloudSync.signIn('me@example.com', 'pw')
  await drain()
  deviceRows = [other(), { user_id: 'user-1', device_id: 'desktop-1', last_seen_at: new Date().toISOString() }]
  signOutCalls = []
  deletedAll = false
  res = await cloudSync.signOutEverywhere()
  check('signing out everywhere succeeds', res.success, true)
  // The authoritative part: a global scope is what Supabase honours server-side.
  check('a GLOBAL sign-out is requested', signOutCalls, ['global'])
  // The registry and every push token go with it — after the sign-out this client
  // has no authority to write those rows.
  check('the device registry is cleared', deletedAll, true)
  check('this desktop is signed out too', config.cloudSyncEnabled, false)
  check('and its refresh token wiped', config.supabaseRefreshToken, '')
  check('known devices are forgotten', config.knownDeviceIds, [])

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
