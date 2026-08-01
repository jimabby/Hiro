// Recovery-grade sync: the three pieces that turn "mirrors data" into
// "survives a machine dying".
//
//   * the first-sync gate — merge is only one of three reasonable answers, and
//     picking wrong destroys data on one side
//   * the conflict log — the desktop-wins rule is correct but was silent, and a
//     conflict nobody can see is indistinguishable from data loss
//   * device identity — stable across launches, or it cannot be revoked

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-recovery-' + Date.now())

// A config double that actually persists, so "generated once" is testable.
let store = {}
stub({
  './config': {
    load: () => ({ ...store }),
    update: (patch) => { store = { ...store, ...patch } },
    CONFIG_DIR,
  },
})

const db = service('database.js')
const identity = service('deviceIdentity.js')
const configDouble = { load: () => ({ ...store }), update: (patch) => { store = { ...store, ...patch } } }
const { check, done } = createChecker()

// ── Device identity ────────────────────────────────────────────
{
  store = {}
  const first = identity.ensureDeviceIdentity(configDouble)
  check('a device id is generated', typeof first.deviceId === 'string' && first.deviceId.length > 10, true)
  check('a device name is generated', !!first.deviceName, true)

  // The whole point of an id you can revoke is that it does not change.
  const second = identity.ensureDeviceIdentity(configDouble)
  check('the device id is stable across calls', second.deviceId, first.deviceId)
  check('the device name is stable across calls', second.deviceName, first.deviceName)

  // A user-renamed device must not be overwritten on next launch.
  store.deviceName = 'Work laptop'
  check('a renamed device keeps its name',
    identity.ensureDeviceIdentity(configDouble).deviceName, 'Work laptop')
}

// ── First-sync gate ────────────────────────────────────────────
{
  const fresh = {}
  // Both sides hold data and nobody has decided: this is the only case where
  // guessing can destroy something, so it is the only case that asks.
  check('both sides populated asks',
    identity.resolveFirstSyncMode(fresh, { localCount: 12, remoteCount: 30 }), 'ask')

  // Every other combination has exactly one sensible answer.
  check('empty cloud seeds without asking',
    identity.resolveFirstSyncMode(fresh, { localCount: 12, remoteCount: 0 }), 'merge')
  check('empty local restores without asking',
    identity.resolveFirstSyncMode(fresh, { localCount: 0, remoteCount: 30 }), 'merge')
  check('both empty does not ask',
    identity.resolveFirstSyncMode(fresh, { localCount: 0, remoteCount: 0 }), 'merge')

  // Once answered, never asked again — including after the counts change.
  for (const choice of ['merge', 'cloud', 'local']) {
    check(`a recorded "${choice}" choice is honoured`,
      identity.resolveFirstSyncMode({ cloudFirstSyncChoice: choice }, { localCount: 5, remoteCount: 5 }), choice)
  }

  // A config hand-edited to nonsense must fall back to asking, not to silently
  // running an unknown mode.
  check('an unknown recorded choice still asks',
    identity.resolveFirstSyncMode({ cloudFirstSyncChoice: 'yolo' }, { localCount: 5, remoteCount: 5 }), 'ask')
  check('choice validation rejects nonsense', identity.isValidChoice('yolo'), false)
  check('choice validation accepts cloud', identity.isValidChoice('cloud'), true)
}

;(async () => {
  await db.init()

  const app = db.insertApplication({
    job_title: 'Senior Engineer', company: 'Acme', platform: 'Seek',
    job_url: 'https://example.com/1', job_description: 'jd', match_score: 91,
    tailored_resume: 'T', cover_letter: 'L', screening_qa: [], status: 'applied',
  })

  // ── Conflict log ─────────────────────────────────────────────
  db.recordSyncConflict({
    applicationId: app.id, field: 'status',
    localValue: 'applied', remoteValue: 'interview', resolvedAs: 'local-kept',
  })

  let conflicts = db.getSyncConflicts()
  check('a conflict is logged', conflicts.length, 1)
  check('the discarded value is kept', conflicts[0].remote_value, 'interview')
  check('the kept value is recorded too', conflicts[0].local_value, 'applied')
  check('the job is identifiable afterwards', conflicts[0].job_title, 'Senior Engineer')
  check('the company is captured', conflicts[0].company, 'Acme')
  check('the resolution is recorded', conflicts[0].resolved_as, 'local-kept')
  check('the count matches', db.countSyncConflicts(), 1)

  // ── Recovering from a wrong automatic resolution ─────────────
  // This is why the discarded value is stored rather than just noted.
  const res = db.applyConflictResolution(conflicts[0].id)
  check('the discarded value can be applied', res.success, true)
  check('the application now holds the remote value', db.getApplication(app.id).status, 'interview')
  check('re-applying is recorded', db.getSyncConflicts()[0].resolved_as, 'remote-applied')
  check('the row is queued for upload', db.getApplication(app.id).cloud_dirty, 1)

  // A status change made this way belongs in the timeline like any other.
  check('the timeline records it',
    db.getStatusHistory(app.id).some(h => h.status === 'interview'), true)

  // ── Guards ───────────────────────────────────────────────────
  check('an unknown conflict fails cleanly', db.applyConflictResolution(99999).success, false)
  db.recordSyncConflict({
    applicationId: app.id, field: 'match_score',
    localValue: '91', remoteValue: '40', resolvedAs: 'local-kept',
  })
  const scoreConflict = db.getSyncConflicts().find(c => c.field === 'match_score')
  check('only phone-editable fields can be re-applied',
    db.applyConflictResolution(scoreConflict.id).success, false)
  check('recording without an application id is refused',
    db.recordSyncConflict({ field: 'status' }).success, false)

  // ── Seeding the cloud from this device ───────────────────────
  // Only rows changed since the last sync would push otherwise, so a re-seed
  // would upload a fraction of history and call it a backup.
  db.markCloudSynced(app.id, new Date().toISOString(), db.getApplication(app.id).updated_at)
  check('a synced row is clean', db.getApplication(app.id).cloud_dirty, 0)
  db.markAllDirty()
  check('seeding marks every row for upload', db.getApplication(app.id).cloud_dirty, 1)

  // ── Taking the cloud copy ────────────────────────────────────
  // Wiping local history tombstones every row. Those tombstones must not
  // survive to be replayed as deletions against the cloud we are restoring
  // from — that turns "restore my data" into "delete my data everywhere".
  db.clearAllApplications()
  check('local history is gone', db.countApplications(), 0)
  check('wiping produced tombstones', db.getTombstones().length > 0, true)
  db.clearTombstones(db.getTombstones())
  check('tombstones are cleared before any pull', db.getTombstones().length, 0)
  check('conflicts for deleted rows go too', db.countSyncConflicts(), 0)

  db.clearSyncConflicts()
  check('the log can be cleared', db.countSyncConflicts(), 0)

  done()
})()
