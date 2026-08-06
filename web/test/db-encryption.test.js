// Encryption at rest for the database and its backups.
//
// The failure modes here are the expensive kind — a database that opens as empty
// looks exactly like having lost every application ever recorded — so these
// assertions are mostly about refusing loudly:
//
//   • A tampered or truncated file must fail its integrity check, not be opened
//     as garbage.
//   • The wrong key must fail, not produce plausible nonsense.
//   • Turning encryption on must cover the BACKUPS too, or an encrypted database
//     beside seven plaintext daily copies protects nothing.
//   • Turning it off again must actually leave a readable SQLite file.

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-crypt-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true } ) } catch {} })

let config = { encryptDatabase: false }

// Stand in for Electron's safeStorage, which is what wraps the data key in the OS
// keychain. `available` is a switch so the "keychain is gone" path is reachable:
// that is the case a user actually hits after restoring a home directory onto a
// new machine, and it must produce a clear error rather than an empty database.
const keychain = {
  available: true,
  // A fixed key stands in for the OS secret; the wrapping itself is not what is
  // under test here, the behaviour around it is.
  secret: Buffer.from('0123456789abcdef0123456789abcdef'),
  isEncryptionAvailable() { return this.available },
  encryptString(s) {
    const iv = Buffer.alloc(16, 7)
    const c = crypto.createCipheriv('aes-256-cbc', this.secret, iv)
    return Buffer.concat([c.update(s, 'utf8'), c.final()])
  },
  decryptString(buf) {
    const iv = Buffer.alloc(16, 7)
    const d = crypto.createDecipheriv('aes-256-cbc', this.secret, iv)
    return Buffer.concat([d.update(buf), d.final()]).toString('utf8')
  },
}

stub({
  './config': {
    CONFIG_DIR: TMP,
    load: () => config,
    update: (patch) => { config = { ...config, ...patch }; return config },
  },
  './logger': { append: () => {} },
  // dbCrypto reaches for electron's safeStorage; give it this one.
  electron: { safeStorage: keychain },
})

const dbCrypto = service('dbCrypto')
const db = service('database')
const { check, done } = createChecker()

const DB_PATH = path.join(TMP, 'autoapply.db')
const BACKUP_DIR = path.join(TMP, 'backups')
const SQLITE_HEADER = 'SQLite format 3'

const head = (file, n = 16) => fs.readFileSync(file).subarray(0, n).toString('latin1')
const isPlain = (file) => head(file).startsWith(SQLITE_HEADER)

let seq = 0
function add(company) {
  seq++
  db.insertApplication({
    job_title: `Role ${seq}`,
    company,
    platform: 'Seek',
    salary: '',
    job_url: `https://example.com/job/${seq}`,
    job_description: 'A very confidential job description.',
    match_score: 88,
    match_explanation: '',
    tailored_resume: 'CONFIDENTIAL RESUME TEXT',
    screening_qa: [],
    status: 'applied',
    closing_date: null,
  })
  return seq
}

async function main() {
  await db.init()

  // ── Off by default, and the file is a plain SQLite database ───
  add('Plaintext Ltd')
  check('encryption is off by default', dbCrypto.getStatus().enabled, false)
  check('the database is a plain SQLite file', isPlain(DB_PATH), true)
  check('no key exists until encryption is turned on', dbCrypto.hasKey(), false)
  // The whole reason this feature exists: the documents are readable on disk.
  check('resume text is readable on disk while unencrypted',
    fs.readFileSync(DB_PATH).includes('CONFIDENTIAL RESUME TEXT'), true)

  // A backup exists too, so the switch has something to convert.
  db.backupNow()
  const backupName = db.listBackups()[0].name
  check('the backup is plaintext too', isPlain(path.join(BACKUP_DIR, backupName)), true)

  // ── Turning it on ────────────────────────────────────────────
  const on = db.setEncryption(true)
  check('turning encryption on succeeds', on.success, true)
  check('the setting is now on', dbCrypto.getStatus().enabled, true)
  check('a key was created', dbCrypto.hasKey(), true)
  check('the database is no longer a plain SQLite file', isPlain(DB_PATH), false)
  check('the database carries the Hiro header', head(DB_PATH, 8), 'HIRODB01')
  // The backup matters as much as the database.
  check('the backup was converted too', isPlain(path.join(BACKUP_DIR, backupName)), false)
  check('resume text is no longer readable on disk',
    fs.readFileSync(DB_PATH).includes('CONFIDENTIAL RESUME TEXT'), false)
  check('the status reports the database as encrypted', db.getEncryptionStatus().databaseEncrypted, true)
  check('no plaintext backups remain', db.getEncryptionStatus().plaintextBackups, [])
  check('listBackups labels the backup encrypted', db.listBackups()[0].encrypted, true)

  // ── It still works ───────────────────────────────────────────
  add('Encrypted Co')
  check('rows can still be written', db.getApplications({}).length, 2)
  check('the file stayed encrypted after a write', isPlain(DB_PATH), false)

  // Reopening is the real test: the whole database has to come back.
  await db.init()
  const companies = db.getApplications({}).map(a => a.company).sort()
  check('reopening an encrypted database returns every row', companies, ['Encrypted Co', 'Plaintext Ltd'])

  // A new backup, taken while encrypted, is encrypted without special handling —
  // backupNow copies the file, so it inherits whatever state that file is in.
  // The daily rotation is one file per day, so this REPLACES the plaintext backup
  // taken earlier in the run; it now holds two rows.
  db.backupNow()
  check('a new backup is encrypted', db.listBackups().every(b => b.encrypted), true)

  // ── Restoring from a backup ──────────────────────────────────
  add('Will Be Rolled Back Inc')
  check('three rows before the restore', db.getApplications({}).length, 3)
  const restore = db.restoreBackup(backupName)
  check('restoring an encrypted backup succeeds', restore.success, true)
  check('the restore rolled the database back',
    db.getApplications({}).map(a => a.company).sort(), ['Encrypted Co', 'Plaintext Ltd'])
  check('the restored database is still encrypted', isPlain(DB_PATH), false)

  // ── Integrity ────────────────────────────────────────────────
  // A byte flipped in the ciphertext must fail the GCM tag, not decrypt to
  // garbage that sql.js then reports as a corrupt or empty database.
  const good = fs.readFileSync(DB_PATH)
  const tampered = Buffer.from(good)
  tampered[tampered.length - 20] ^= 0xff
  let error = null
  try { dbCrypto.decryptBuffer(tampered) } catch (err) { error = err }
  check('a tampered file is refused', error?.code, 'integrity-failed')
  check('and says to restore a backup', /Restore a backup/.test(error?.message || ''), true)

  // Truncation is the shape a power cut used to produce.
  error = null
  try { dbCrypto.decryptBuffer(good.subarray(0, good.length - 100)) } catch (err) { error = err }
  check('a truncated file is refused', error?.code, 'integrity-failed')

  // A header that is not ours at all.
  error = null
  try { dbCrypto.decryptBuffer(Buffer.from('SQLite format 3\0 and then some')) } catch (err) { error = err }
  check('a plaintext file is not mistaken for an encrypted one', error?.code, 'not-encrypted')

  // ── The wrong key ────────────────────────────────────────────
  error = null
  try { dbCrypto.decryptBuffer(good, crypto.randomBytes(32)) } catch (err) { error = err }
  check('the wrong key fails the integrity check', error?.code, 'integrity-failed')

  // ── Recovery key ─────────────────────────────────────────────
  const recovery = dbCrypto.exportRecoveryKey()
  check('the recovery key is identifiable', /^HIRO-RECOVERY-1:/.test(recovery.key), true)
  check('it is offered in transcribable groups', /^[\w+/=]{1,8}( [\w+/=]{1,8})+$/.test(recovery.groups), true)

  // The case it exists for: the profile is on a machine whose keychain cannot
  // unwrap the stored key.
  dbCrypto._resetKeyCache()
  const originalSecret = keychain.secret
  keychain.secret = crypto.randomBytes(32) // a different machine
  error = null
  try { dbCrypto.loadKey() } catch (err) { error = err }
  check('a keychain that cannot unwrap the key says so', error?.code, 'key-unwrap-failed')
  check('and points at the recovery key', /recovery key/.test(error?.message || ''), true)

  // Importing the recovery key re-wraps it with THIS machine's keychain.
  const imported = dbCrypto.importRecoveryKey(recovery.key)
  check('the recovery key can be imported', imported.success, true)
  dbCrypto._resetKeyCache()
  await db.init()
  check('the database opens again after recovery', db.getApplications({}).length, 2)

  check('a malformed recovery key is rejected',
    dbCrypto.importRecoveryKey('not a key').success, false)
  check('with an explanation rather than a stack trace',
    /HIRO-RECOVERY-1/.test(dbCrypto.importRecoveryKey('nope').reason), true)
  keychain.secret = originalSecret
  dbCrypto._resetKeyCache()
  dbCrypto.importRecoveryKey(recovery.key)

  // ── No keychain at all ───────────────────────────────────────
  keychain.available = false
  dbCrypto._resetKeyCache()
  error = null
  try { dbCrypto.loadKey() } catch (err) { error = err }
  check('a missing keychain is reported clearly', error?.code, 'keychain-unavailable')
  check('the status says the keychain is unavailable', dbCrypto.getStatus().keychainAvailable, false)
  keychain.available = true
  dbCrypto._resetKeyCache()

  // ── Turning it off ───────────────────────────────────────────
  await db.init()
  const off = db.setEncryption(false)
  check('turning encryption off succeeds', off.success, true)
  check('the database is a plain SQLite file again', isPlain(DB_PATH), true)
  check('the backups are plaintext again', db.listBackups().every(b => !b.encrypted), true)
  await db.init()
  check('the decrypted database still holds its rows', db.getApplications({}).length, 2)

  // ── Idempotence ──────────────────────────────────────────────
  check('turning off an already-off setting is a no-op', db.setEncryption(false).unchanged, true)
  db.setEncryption(true)
  check('turning on an already-on setting is a no-op', db.setEncryption(true).unchanged, true)

  done()
}

main().catch(err => { console.error(err); process.exitCode = 1 })
