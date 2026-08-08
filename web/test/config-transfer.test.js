// Encrypted settings export/import. Two things must hold or the feature is
// actively harmful: credentials must not leave the machine unless explicitly
// asked for, and machine-specific runtime state must never be restored onto a
// different machine (a stale scan queue or mobile pairing token would be
// resurrected silently).

const { stub, service, createChecker } = require('./helpers')

// Fake config service so nothing here reads or writes the real ~/.hiro.
let stored = {
  aiProvider: 'claude',
  aiApiKey: 'sk-secret-key',
  gmailAddress: 'me@example.com',
  gmailAppPassword: 'app-password',
  jobKeywords: 'engineer',
  resumes: [{ id: 'a', name: 'General', text: 'resume text' }],
  resumeRules: [{ id: '1', keywords: 'data', resumeId: 'a' }],
  blacklistedCompanies: ['Acme', 'Globex'],
  matchThreshold: 85,
  companyCooldownDays: 30,
  // Runtime / machine-specific — must never travel.
  pendingScans: [{ id: 'queued-scan' }],
  lastScanAt: '2026-03-01T00:00:00Z',
  mobileApiToken: 'pairing-token',
  supabaseRefreshToken: 'refresh-token',
  setupComplete: true,
  cloudSyncEnabled: true,
  calendarRefreshToken: 'calendar-refresh',
  calendarClientSecret: 'calendar-secret',
  deviceId: 'desktop-a',
  deviceName: 'Desktop A',
  knownDeviceIds: ['desktop-a'],
  mobileDevices: [{ id: 'phone-a', tokenHash: 'hash' }],
  calendarSyncCursor: 'cursor-a',
  encryptDatabase: true,
}

stub({
  './config': {
    load: () => ({ ...stored }),
    update: (patch) => {
      stored = typeof patch === 'function' ? patch({ ...stored }) : { ...stored, ...patch }
      return stored
    },
  },
})

const ct = service('configTransfer')
const { check, done } = createChecker()

const PASS = 'a-good-passphrase'

// ── Round trip ────────────────────────────────────────────────────
const bundle = ct.exportBundle(PASS, { includeSecrets: false })
const opened = ct.inspectBundle(bundle, PASS)

check('round trip preserves a normal setting', opened.payload.matchThreshold, 85)
check('round trip preserves resumes', opened.payload.resumes.length, 1)
check('round trip preserves routing rules', opened.payload.resumeRules.length, 1)
check('round trip preserves blacklist', opened.payload.blacklistedCompanies, ['Acme', 'Globex'])
check('reports it carries no credentials', opened.includesSecrets, false)

// ── Secrets are opt-in ────────────────────────────────────────────
check('API key excluded by default', 'aiApiKey' in opened.payload, false)
check('email password excluded by default', 'gmailAppPassword' in opened.payload, false)
check('calendar refresh token excluded by default', 'calendarRefreshToken' in opened.payload, false)
check('calendar client secret excluded by default', 'calendarClientSecret' in opened.payload, false)
check('non-secret email address still travels', opened.payload.gmailAddress, 'me@example.com')

const withSecrets = ct.inspectBundle(ct.exportBundle(PASS, { includeSecrets: true }), PASS)
check('API key included when opted in', withSecrets.payload.aiApiKey, 'sk-secret-key')
check('calendar credential included when opted in', withSecrets.payload.calendarRefreshToken, 'calendar-refresh')
check('flags that it carries credentials', withSecrets.includesSecrets, true)

// ── Runtime state never travels ───────────────────────────────────
for (const key of ['pendingScans', 'lastScanAt', 'mobileApiToken', 'supabaseRefreshToken', 'setupComplete', 'cloudSyncEnabled', 'deviceId', 'deviceName', 'knownDeviceIds', 'mobileDevices', 'calendarSyncCursor', 'encryptDatabase']) {
  check(`runtime key excluded: ${key}`, key in opened.payload, false)
}

// ── Encryption actually happens ───────────────────────────────────
check('plaintext resume is not in the file', bundle.includes('resume text'), false)
check('plaintext keyword is not in the file', bundle.includes('engineer'), false)

// ── Failure modes ─────────────────────────────────────────────────
const throws = (fn) => { try { fn(); return null } catch (e) { return e.message } }

check('wrong passphrase rejected',
  throws(() => ct.inspectBundle(bundle, 'wrong-passphrase')), 'Could not decrypt — check the passphrase.')
check('short passphrase rejected on export',
  throws(() => ct.exportBundle('short')), 'Passphrase must be at least 8 characters.')
check('non-Hiro JSON rejected',
  throws(() => ct.inspectBundle('{"hello":1}', PASS)), 'This file is not a Hiro config backup.')
check('malformed file rejected',
  throws(() => ct.inspectBundle('not json at all', PASS)), 'This file is not a Hiro config backup (invalid JSON).')

const future = JSON.parse(bundle); future.version = 99
check('newer format version rejected with a useful message',
  /newer version of Hiro/.test(throws(() => ct.inspectBundle(JSON.stringify(future), PASS))), true)

// Tampering must fail rather than silently importing altered settings.
const tampered = JSON.parse(bundle)
const bytes = Buffer.from(tampered.data, 'base64')
bytes[0] ^= 0xff
tampered.data = bytes.toString('base64')
check('tampered ciphertext rejected',
  throws(() => ct.inspectBundle(JSON.stringify(tampered), PASS)), 'Could not decrypt — check the passphrase.')

// ── Applying ──────────────────────────────────────────────────────
ct.applyBundle({ matchThreshold: 60, jobKeywords: 'designer' })
check('apply writes settings through', stored.matchThreshold, 60)
check('apply writes the second setting too', stored.jobKeywords, 'designer')

// Defence in depth: a hand-edited or older bundle must not be able to clobber
// live runtime state even if it somehow contains it.
ct.applyBundle({ matchThreshold: 70, pendingScans: [], mobileApiToken: 'attacker-token' })
check('apply ignores runtime keys in the payload', stored.mobileApiToken, 'pairing-token')
check('apply ignores a runtime scan queue', stored.pendingScans, [{ id: 'queued-scan' }])
check('apply still writes the legitimate setting', stored.matchThreshold, 70)

check('apply rejects a non-object', throws(() => ct.applyBundle(null)), 'Nothing to import.')

done()
