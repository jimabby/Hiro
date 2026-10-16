// Proof of submission: the confirmation page, kept per application.
//
// Stored under the profile directory, encrypted with the database key when
// database encryption is on, readable only from inside its own folder, and
// removed with the application.

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-proof-test-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

let config = { encryptDatabase: false }
const keychain = {
  secret: Buffer.from('0123456789abcdef0123456789abcdef'),
  isEncryptionAvailable() { return true },
  encryptString(s) {
    const c = crypto.createCipheriv('aes-256-cbc', this.secret, Buffer.alloc(16, 7))
    return Buffer.concat([c.update(s, 'utf8'), c.final()])
  },
  decryptString(buf) {
    const d = crypto.createDecipheriv('aes-256-cbc', this.secret, Buffer.alloc(16, 7))
    return Buffer.concat([d.update(buf), d.final()]).toString('utf8')
  },
}

stub({
  './config': { CONFIG_DIR: TMP, load: () => config, update: (p) => { config = { ...config, ...p }; return config } },
  './logger': { append: () => {} },
  electron: { safeStorage: keychain },
})

const db = service('database')
const proof = service('submissionProof')
const { check, done } = createChecker()

// A PNG signature is enough for the bytes to be recognisable.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')])

let seq = 0
function addApp() {
  seq++
  return db.insertApplication({
    job_title: `Role ${seq}`, company: 'Acme', platform: 'Seek', job_url: `https://x/${seq}`,
    status: 'applied', screening_qa: [],
  }).id
}

;(async () => {
  await db.init()

  // ── Plain ───────────────────────────────────────────────────────
  const a = addApp()
  const file = proof.attach(db, a, PNG)
  check('the screenshot is stored under the profile', file.startsWith(path.join(TMP, 'screenshots')), true)
  check('named for its application', path.basename(file), `${a}.png`)
  check('and recorded on the application', db.getSubmissionScreenshot(a), file)
  check('it reads back as a PNG data URL', proof.readDataUrl(file), `data:image/png;base64,${PNG.toString('base64')}`)

  // ── Encrypted when the database is ──────────────────────────────
  config = { encryptDatabase: true }
  const b = addApp()
  const encFile = proof.attach(db, b, PNG)
  check('an encrypted profile stores it encrypted', encFile.endsWith('.png.enc'), true)
  check('the bytes on disk are not the image', fs.readFileSync(encFile).includes(Buffer.from('fake image body')), false)
  check('it still reads back as the image', proof.readDataUrl(encFile), `data:image/png;base64,${PNG.toString('base64')}`)

  // ── Only our own folder ─────────────────────────────────────────
  const outside = path.join(TMP, 'not-a-screenshot.png')
  fs.writeFileSync(outside, PNG)
  check('a path outside the folder is never read', proof.readDataUrl(outside), null)
  proof.remove(outside)
  check('or deleted', fs.existsSync(outside), true)
  check('nothing stored, nothing returned', proof.attach(db, addApp(), null), null)

  // ── Removed with its application ────────────────────────────────
  db.deleteApplication(a)
  check('deleting the application deletes its screenshot', fs.existsSync(file), false)
  db.deleteApplication(b)
  check('encrypted ones too', fs.existsSync(encFile), false)
  check('a missing file reads as none', proof.readDataUrl(file), null)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
