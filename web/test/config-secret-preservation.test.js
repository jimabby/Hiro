// Secrets that this machine cannot decrypt must survive, not be overwritten.
//
// The bug this guards against destroyed data silently and routinely. Config
// secrets are stored as "enc:v1:…", wrapped by the OS keychain. decryptValue
// returned '' whenever the keychain was unavailable or refused the value — and
// save() then wrote that '' straight back over the ciphertext. Since
// configService.update() runs at the end of every single scan (to stamp
// lastScanAt), one scan was enough to permanently destroy the AI API key, the
// Gmail app password, the Supabase refresh token and the cloud data key.
//
// It needed no corruption and no crash to trigger, just a keychain that was
// locked, missing (a Linux box with no secret service), or belonged to a
// different machine — the last being the ordinary case of restoring a profile.
//
// dbCrypto has always refused to guess in exactly this situation; these checks
// hold config.js to the same standard. There is no Electron here, so
// safeStorage is absent and canEncrypt() is false — which is precisely the
// condition that used to destroy the values.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-cfg-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
process.env.HIRO_CONFIG_DIR = TMP

const configService = require('../electron/services/config')
const { check, done } = createChecker()

const CONFIG_FILE = path.join(TMP, 'config.json')
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

function seed(values) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(values, null, 2))
  configService._resetSecretState()
}

const CIPHERTEXT = {
  aiApiKey: 'enc:v1:AAAABBBBCCCC',
  gmailAppPassword: 'enc:v1:DDDDEEEEFFFF',
  supabaseRefreshToken: 'enc:v1:GGGGHHHHIIII',
  cloudDataKey: 'enc:v1:JJJJKKKKLLLL',
}

// ─── The core guarantee ──────────────────────────────────────────
seed({ ...CIPHERTEXT, setupComplete: true })

const loaded = configService.load()
check('an undecryptable secret reads as empty to callers', loaded.aiApiKey, '')
check('the load is otherwise intact', loaded.setupComplete, true)
check('the situation is reported rather than silent', typeof configService.getSecretError(), 'string')
check('the report names the affected fields',
  configService.getSecretError().includes('aiApiKey') && configService.getSecretError().includes('cloudDataKey'), true)

// The exact operation that used to destroy them.
configService.update({ lastScanAt: new Date().toISOString() })
check('a background write preserves the AI key', onDisk().aiApiKey, CIPHERTEXT.aiApiKey)
check('a background write preserves the Gmail password', onDisk().gmailAppPassword, CIPHERTEXT.gmailAppPassword)
check('a background write preserves the refresh token', onDisk().supabaseRefreshToken, CIPHERTEXT.supabaseRefreshToken)
check('a background write preserves the cloud data key', onDisk().cloudDataKey, CIPHERTEXT.cloudDataKey)
check('the write it was actually making still happened', typeof onDisk().lastScanAt, 'string')

// Repeated writes must not erode them either — the scan loop does this daily.
for (let i = 0; i < 5; i++) configService.update({ lastScanAt: new Date().toISOString() })
check('secrets survive repeated background writes', onDisk().aiApiKey, CIPHERTEXT.aiApiKey)

// ─── But the user must still be able to replace one ──────────────
// Preservation that cannot be overridden would be its own bug: a user whose key
// really has been revoked could never enter a new one.
configService.update({ aiApiKey: 'sk-a-freshly-typed-key' })
check('a user-supplied value replaces the preserved one', onDisk().aiApiKey, 'sk-a-freshly-typed-key')
check('replacing one secret leaves the others alone', onDisk().gmailAppPassword, CIPHERTEXT.gmailAppPassword)

// ─── A partial patch must not drop what it omits ─────────────────
seed({ ...CIPHERTEXT, setupComplete: true })
configService.load()
configService.save({ setupComplete: true, lastScanAt: 'x' }) // every secret key absent
check('a save that omits the secret keys keeps them', onDisk().aiApiKey, CIPHERTEXT.aiApiKey)

// ─── Plaintext values are untouched by any of this ───────────────
// Without a keychain, encryptValue deliberately stores plaintext rather than
// locking the user out. That path must keep working exactly as before.
seed({ setupComplete: true })
configService.load()
configService.update({ aiApiKey: 'plain-key' })
check('a plaintext secret round-trips when there is no keychain', configService.load().aiApiKey, 'plain-key')
check('no spurious error is reported for readable config', configService.getSecretError(), null)

// And clearing a secret that was readable must actually clear it.
configService.update({ aiApiKey: '' })
check('a readable secret can be cleared', onDisk().aiApiKey, '')

// ─── The report must not eat itself ──────────────────────────────
//
// decryptForLoad used the module-level `secretError` as its own scratch space:
// it only assigned err.message `if (!secretError)`, then built the final
// sentence by interpolating `secretError` into itself. So the second load
// embedded the whole of the first load's message inside the new one, and the
// third embedded the second:
//
//   "1 saved secret (aiApiKey) could not be decrypted because 1 saved secret
//    (aiApiKey) could not be decrypted because 1 saved secret …"
//
// load() runs on nearly every operation in the app — every mobile API request
// goes through it — so the string grew by ~200 bytes each time, and what the
// Settings page displayed was unreadable from the second load onwards.
//
// Deliberately NOT calling _resetSecretState between the loads: doing that is
// what let every existing check in this file pass while the bug was live.
seed({ aiApiKey: 'enc:v1:AAAA', setupComplete: true })
configService.load()
const firstReport = configService.getSecretError()
check('the first load reports the problem', typeof firstReport, 'string')

for (let i = 0; i < 8; i++) configService.load()
const laterReport = configService.getSecretError()
check('repeated loads do not grow the message', laterReport.length, firstReport.length)
check('the message is identical every time', laterReport, firstReport)
check('the reason is a reason, not a nested report',
  (laterReport.match(/could not be decrypted because/g) || []).length, 1)

// And it must still clear itself once the secrets become readable again.
seed({ setupComplete: true })
configService.load()
check('a clean load clears a previous report', configService.getSecretError(), null)


// ─── What the renderer sees, and what it may write back ──────────
//
// config:get used to hand every decrypted secret to the renderer, and
// config:save wrote the renderer's stale form back almost verbatim — so saving
// Settings resurrected revoked phone tokens and disconnected calendar tokens.
// ipc/configGuard.js is the boundary main.js now puts around both.
const guard = require('../electron/ipc/configGuard')
const P = guard.SECRET_PLACEHOLDER

const stored = {
  aiApiKey: 'sk-real', gmailAddress: 'me@example.com', gmailAppPassword: 'app-pass',
  supabaseRefreshToken: 'refresh-1', cloudDataKey: 'data-key', calendarRefreshToken: 'cal-refresh',
  calendarClientSecret: 'cal-secret', proxyPassword: 'proxy-pass', mobileApiToken: 'legacy',
  scheduledExportPassphrase: 'export-pass',
  proxyServer: 'http://proxy:8080', matchThreshold: 80,
  mobileDevices: [{ id: 'phone-a', tokenHash: 'h1' }, { id: 'phone-b', tokenHash: 'h2' }],
  calendarProvider: 'google', calendarSyncEnabled: true, calendarId: 'work',
  webhooks: [{ id: 'w1', provider: 'generic', url: 'https://hooks.example.com/abc', secret: 'f'.repeat(64), enabled: true }],
}

const served = guard.redactForRenderer(stored)
for (const key of guard.REDACTED_KEYS) {
  check(`config:get never carries ${key}`, served[key], P)
}
check('an unset secret is served as empty, not as the placeholder',
  guard.redactForRenderer({ aiApiKey: '' }).aiApiKey, '')
check('a webhook URL is masked', served.webhooks[0].url, P)
check('with a hint of where it points', served.webhooks[0].urlHint, 'https://hooks.example.com/…')
check('a webhook secret is never served', 'secret' in served.webhooks[0], false)
check('but whether it has one is', served.webhooks[0].hasSecret, true)
check('ordinary settings are served as they are', served.matchThreshold, 80)
check('nothing in the served config is a real secret',
  JSON.stringify(served).includes('sk-real') || JSON.stringify(served).includes('refresh-1')
    || JSON.stringify(served).includes('hooks.example.com/abc'), false)

// A test button sends whatever is in the form, which for a saved key is the
// placeholder — the handler swaps the stored value back in.
check('the placeholder resolves to the stored secret', guard.resolveSecret(P, 'sk-real'), 'sk-real')
check('a typed value is used as typed', guard.resolveSecret('sk-new', 'sk-real'), 'sk-new')

const store = guard.createSnapshotStore()
const id = store.remember(served)

// Services move on while the form sits on screen: a phone is revoked, the
// calendar is disconnected, the refresh token is rotated.
const later = {
  ...stored,
  mobileDevices: [{ id: 'phone-a', tokenHash: 'h1' }],
  supabaseRefreshToken: 'refresh-2',
  calendarProvider: '', calendarRefreshToken: '', calendarSyncEnabled: false, calendarId: '',
  gmailAddress: '', gmailAppPassword: '', // the mailbox was disconnected
}
// …and the user saves the stale form, having changed only the threshold.
const staleForm = { ...served, [guard.SNAPSHOT_KEY]: id, matchThreshold: 70 }
let merged = guard.mergeRendererSave(later, staleForm, store.get(id))
check('the user\'s actual change is saved', merged.matchThreshold, 70)
check('a revoked phone stays revoked', merged.mobileDevices.map(d => d.id), ['phone-a'])
check('a rotated refresh token is not rolled back', merged.supabaseRefreshToken, 'refresh-2')
check('a disconnected calendar stays disconnected', [merged.calendarProvider, merged.calendarRefreshToken], ['', ''])
check('an untouched toggle a service changed keeps the service\'s value', merged.calendarSyncEnabled, false)
check('a signed-out mailbox is not signed back in', [merged.gmailAddress, merged.gmailAppPassword], ['', ''])
check('a placeholder never reaches disk', JSON.stringify(merged).includes(P), false)
check('the snapshot id is not saved', guard.SNAPSHOT_KEY in merged, false)

// Credentials the user edits in a form must still be saveable.
merged = guard.mergeRendererSave(stored, { ...served, [guard.SNAPSHOT_KEY]: id, gmailAppPassword: 'new-app-pass', aiApiKey: 'sk-typed' }, store.get(id))
check('a newly typed app password is saved', merged.gmailAppPassword, 'new-app-pass')
check('a newly typed API key is saved', merged.aiApiKey, 'sk-typed')
check('an untouched secret keeps its stored value', merged.proxyPassword, 'proxy-pass')
merged = guard.mergeRendererSave(stored, { ...served, [guard.SNAPSHOT_KEY]: id, proxyPassword: '' }, store.get(id))
check('clearing a saved secret on purpose clears it', merged.proxyPassword, '')

// Service-owned keys are refused outright, even when "changed".
merged = guard.mergeRendererSave(later, { ...served, mobileDevices: stored.mobileDevices, calendarRefreshToken: 'forged', deviceId: 'x' }, null)
check('the renderer cannot write the device list', merged.mobileDevices.length, 1)
check('or a calendar token', merged.calendarRefreshToken, '')
check('or the device id', merged.deviceId, undefined)

// Without a snapshot (the setup wizard builds its form from scratch) typed
// values are still taken, placeholders still are not.
merged = guard.mergeRendererSave(stored, { aiApiKey: 'sk-setup', gmailAppPassword: P, matchThreshold: 90 }, null)
check('without a snapshot a typed key is saved', merged.aiApiKey, 'sk-setup')
check('without a snapshot a placeholder keeps the stored secret', merged.gmailAppPassword, 'app-pass')
check('a key the renderer omits is kept rather than dropped', merged.proxyServer, 'http://proxy:8080')

// After a save the form IS what it sent; the next save compares against that.
const id2 = store.remember(served)
const firstSave = { ...served, [guard.SNAPSHOT_KEY]: id2, matchThreshold: 75 }
store.advance(id2, firstSave)
merged = guard.mergeRendererSave({ ...stored, matchThreshold: 75, calendarId: 'changed-by-service' }, { ...firstSave }, store.get(id2))
check('a second save of the same form does not undo a service write', merged.calendarId, 'changed-by-service')

// ─── Webhooks ────────────────────────────────────────────────────
const wid = store.remember(served)
merged = guard.mergeRendererSave(stored, {
  ...served, [guard.SNAPSHOT_KEY]: wid,
  webhooks: [{ ...served.webhooks[0], enabled: false }],
}, store.get(wid))
check('a masked webhook URL is restored from the stored one', merged.webhooks[0].url, 'https://hooks.example.com/abc')
check('the stored signing secret is kept', merged.webhooks[0].secret, 'f'.repeat(64))
check('the edit itself is saved', merged.webhooks[0].enabled, false)
check('the display-only fields are not saved', ['urlHint', 'hasSecret'].some(k => k in merged.webhooks[0]), false)

merged = guard.mergeRendererSave(stored, {
  ...served, [guard.SNAPSHOT_KEY]: wid,
  webhooks: [{ ...served.webhooks[0], secret: '0'.repeat(64) }],
}, store.get(wid), { newSecret: () => 'n'.repeat(64) })
check('an existing webhook\'s secret cannot be replaced from the form', merged.webhooks[0].secret, 'f'.repeat(64))

merged = guard.mergeRendererSave(stored, {
  ...served, [guard.SNAPSHOT_KEY]: wid,
  webhooks: [...served.webhooks, { id: 'w2', provider: 'generic', url: 'https://new.example.com', secret: 'a'.repeat(64) },
    { provider: 'discord', url: 'https://discord.com/api/webhooks/1' }],
}, store.get(wid), { newSecret: () => 'n'.repeat(64) })
check('a new webhook keeps the secret it was shown on creation', merged.webhooks[1].secret, 'a'.repeat(64))
check('a webhook with no secret gets one', merged.webhooks[2].secret, 'n'.repeat(64))
check('and an id', typeof merged.webhooks[2].id, 'string')

// ── A changed Supabase project never inherits the session ─────────
// The URL/key are ordinary fields; a renderer that points them elsewhere must
// not get the stored refresh token sent to its host on the next sync.
const signedIn = { ...stored, supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'anon-1',
  supabaseRefreshToken: 'refresh-secret', cloudDataKey: 'data-key', cloudSyncEnabled: true, supabaseEmail: 'me@x.test' }
const sid = store.remember(guard.redactForRenderer(signedIn))
const sserved = { ...guard.redactForRenderer(signedIn), [guard.SNAPSHOT_KEY]: sid }
merged = guard.mergeRendererSave(signedIn, { ...sserved, supabaseUrl: 'https://evil.example.com' }, store.get(sid))
check('a new project URL is saved', merged.supabaseUrl, 'https://evil.example.com')
check('but the refresh token does not follow it', merged.supabaseRefreshToken, '')
check('nor the data key', merged.cloudDataKey, '')
check('and sync is off until the user signs in again', merged.cloudSyncEnabled, false)
check('the email is kept for convenience', merged.supabaseEmail, 'me@x.test')
merged = guard.mergeRendererSave(signedIn, { ...sserved, supabaseAnonKey: 'anon-2' }, store.get(sid))
check('a changed anon key drops the session too', merged.supabaseRefreshToken, '')
merged = guard.mergeRendererSave(signedIn, { ...sserved, supabaseUrl: 'https://abc.supabase.co/ ', aiModel: 'x' }, store.get(sid))
check('re-saving the same project (whitespace, trailing slash) keeps the session', merged.supabaseRefreshToken, 'refresh-secret')
check('the ordinary first-time setup (no session yet) is untouched',
  guard.withSessionBoundToProject({ supabaseUrl: '' }, { supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'k' }).supabaseUrl, 'https://abc.supabase.co')

check('older webhooks are given ids and secrets',
  guard.withWebhookIdentity([{ provider: 'slack', url: 'https://hooks.slack.com/x' }], () => 's'.repeat(64))[0].secret, 's'.repeat(64))
check('webhooks that already have both are left alone', guard.withWebhookIdentity(stored.webhooks, () => 'x'), null)

done()
