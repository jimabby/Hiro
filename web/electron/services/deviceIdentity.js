// This desktop's stable identity, and the rule for what to do the first time it
// meets a cloud account that already has data.
//
// Both halves exist because "sync" quietly means two different operations that
// look identical from the code's point of view and opposite from the user's:
//
//   * a second machine joining an account — merge is right
//   * a reinstall on a machine whose database was wiped — restore is right
//   * a fresh account being seeded from this machine — push is right
//
// Merging blindly is only correct in the first case. In the third it uploads
// nothing dangerous, but in a variant of the second — where a half-empty local
// database meets a full cloud — a merge can resurrect rows the user deliberately
// deleted, or push local emptiness at rows they still want. Asking once, at the
// only moment the answer is knowable, is cheaper than any heuristic.

const crypto = require('crypto')
const os = require('os')

const CHOICES = new Set(['merge', 'cloud', 'local'])

// A device id is generated once and never changes. It identifies this
// installation across syncs so the account can list what is attached to it and
// so a lost machine can be revoked.
function ensureDeviceIdentity(configService) {
  const cfg = configService.load()
  const patch = {}
  if (!cfg.deviceId) patch.deviceId = crypto.randomUUID()
  if (!cfg.deviceName) patch.deviceName = defaultDeviceName()
  if (Object.keys(patch).length > 0) configService.update(patch)
  return { ...cfg, ...patch }
}

function defaultDeviceName() {
  // Hostnames are the one name the user already recognises. Fall back to the
  // platform rather than something anonymous — "this device" in a list of three
  // devices is useless.
  try {
    const host = os.hostname()
    if (host && host.trim()) return host.replace(/\.local$/i, '').trim()
  } catch { /* fall through */ }
  return `${process.platform} desktop`
}

// Whether this sync must stop and ask before touching anything.
//
// Only when BOTH sides hold data and no choice has been recorded. Every other
// combination has exactly one sensible outcome and asking would be noise:
// an empty cloud is a seed, an empty local is a restore, and a recorded choice
// is the user having already answered.
function needsFirstSyncChoice(cfg, { localCount, remoteCount }) {
  if (cfg.cloudFirstSyncChoice && CHOICES.has(cfg.cloudFirstSyncChoice)) return false
  return localCount > 0 && remoteCount > 0
}

// What to do once the counts are known and any choice has been recorded.
// Returns 'merge' | 'cloud' | 'local' | 'ask'.
function resolveFirstSyncMode(cfg, { localCount, remoteCount }) {
  if (needsFirstSyncChoice(cfg, { localCount, remoteCount })) return 'ask'
  const recorded = cfg.cloudFirstSyncChoice
  if (recorded && CHOICES.has(recorded)) return recorded
  // Nothing on one side or the other: merge does the right thing in both
  // directions and needs no decision from anyone.
  return 'merge'
}

function isValidChoice(choice) {
  return CHOICES.has(choice)
}

module.exports = { ensureDeviceIdentity, defaultDeviceName, needsFirstSyncChoice, resolveFirstSyncMode, isValidChoice, CHOICES }
