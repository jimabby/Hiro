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

done()
