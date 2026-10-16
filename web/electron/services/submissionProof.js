// Proof of submission: a full-page screenshot of the platform's confirmation
// page, taken the moment verifySubmission() accepted it.
//
// "Applied" in the history is Hiro's word for it. When an employer later says
// no application arrived, or a platform quietly drops one, the user needs the
// platform's own word — and the confirmation page is gone the moment the
// browser closes. So it is kept, one image per application, under the profile
// directory beside the database: <CONFIG_DIR>/screenshots/<appId>.png.
//
// Encryption. The page shows the job, the employer and often the user's name
// and email, so when database encryption is on the image is encrypted with the
// same data key (dbCrypto, AES-256-GCM) and stored as <appId>.png.enc. Skipping
// the screenshot under encryption would have been simpler, but would silently
// drop the feature for exactly the users who care most about their records.
// Reading decrypts in memory; nothing is ever written back out in plaintext.

const fs = require('fs')
const path = require('path')
const configService = require('./config')

function dir() {
  return path.join(configService.CONFIG_DIR, 'screenshots')
}

function shouldEncrypt() {
  try { return !!configService.load().encryptDatabase } catch { return false }
}

// Write the PNG for an application. Returns the stored path, or null when there
// was nothing to store or the write failed — proof is a bonus, never a reason
// to fail an application that was submitted.
function save(applicationId, png) {
  if (!applicationId || !Buffer.isBuffer(png) || png.length === 0) return null
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const encrypt = shouldEncrypt()
    const file = path.join(dir(), `${Number(applicationId)}.png${encrypt ? '.enc' : ''}`)
    const data = encrypt ? require('./dbCrypto').encodeForWrite(png, true) : png
    fs.writeFileSync(file, data, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

// Only files inside the screenshots directory are ever read or deleted: the
// path comes from a database row, and a row is not a trusted file path.
function isOurs(file) {
  if (!file) return false
  const rel = path.relative(dir(), path.resolve(file))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// The image as a data URL for the renderer, or null when there is none (never
// taken, deleted, or undecryptable).
function readDataUrl(file) {
  if (!isOurs(file) || !fs.existsSync(file)) return null
  try {
    let buf = fs.readFileSync(file)
    if (file.endsWith('.enc')) buf = require('./dbCrypto').decryptBuffer(buf)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function remove(file) {
  if (!isOurs(file)) return
  try { fs.unlinkSync(file) } catch { /* already gone */ }
}

// Called by the applicator after an application row exists: store the image the
// scraper captured and record where it went.
function attach(database, applicationId, png) {
  const file = save(applicationId, png)
  if (file) {
    try { database.setSubmissionScreenshot(applicationId, file) } catch { /* best-effort */ }
  }
  return file
}

module.exports = { save, readDataUrl, remove, attach, dir, isOurs }
