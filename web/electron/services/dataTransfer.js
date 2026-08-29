// A portable copy of the job search itself — every application, the documents
// that went out, the replies that came back, and the notes around them.
//
// What already existed, and why none of it is this:
//
//   the rotating backups   the whole SQLite file, which on an encrypted profile
//                          is unreadable without this machine's keychain entry.
//                          That is correct for a backup and useless as an escape
//                          hatch, because the failure it protects against least
//                          well is the one where the keychain is what you lost.
//   settings export        configTransfer.js, deliberately settings ONLY.
//   CSV export             fourteen columns for a spreadsheet. No résumé, no
//                          cover letter, no reply, no history.
//   cloud sync             optional, needs an account, and mirrors a subset.
//
// So there was no way to take a job search to another machine, or to read it
// with anything other than Hiro, without trusting a keychain to still be there.
//
// The format is plain JSON with an explicit table map. It is meant to be
// readable by a person and by any other tool; the version number is what a
// future importer reads before touching anything.
//
// Encryption is offered and defaults to on, because the payload carries every
// résumé, every cover letter and every recruiter's address — the same reasoning
// that made configTransfer encrypted by default. A passphrase-free export is a
// deliberate choice the UI makes the user tick.
//
// Importing MERGES and never deletes. Cloud sync's first-contact gate exists
// because "combine these two datasets" has three reasonable answers and two of
// them destroy data; the same is true here, so this only ever does the
// non-destructive one and says exactly what it added.

const crypto = require('crypto')
const database = require('./database')

const MAGIC = 'hiro-data-export'
const FORMAT_VERSION = 1
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // scrypt's default maxmem is below what these parameters need.
    maxmem: 64 * 1024 * 1024,
  })
}

function buildBundle() {
  const data = database.exportAll()
  const counts = Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length]))
  return {
    magic: MAGIC,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    // A reader that is not Hiro should be able to tell what it has without
    // walking the whole file.
    counts,
    data,
  }
}

// `passphrase` empty means write it in the clear — a choice, not a default.
function exportBundle(passphrase = '') {
  const bundle = buildBundle()
  if (!passphrase) return { text: JSON.stringify(bundle, null, 2), encrypted: false, counts: bundle.counts }

  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()])
  // The header stays in the clear so a future version — or a person with a text
  // editor — can recognise the file and be told what it is, rather than meeting
  // an undifferentiated decryption failure.
  const envelope = {
    magic: MAGIC,
    version: FORMAT_VERSION,
    encrypted: true,
    exportedAt: bundle.exportedAt,
    counts: bundle.counts,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  }
  return { text: JSON.stringify(envelope, null, 2), encrypted: true, counts: bundle.counts }
}

// Read a bundle back, encrypted or not. Every failure here is one the user can
// act on, so each gets its own sentence rather than a parser error.
function readBundle(text, passphrase = '') {
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'That file is not a Hiro export — it is not valid JSON.' }
  }
  if (envelope?.magic !== MAGIC) {
    return { ok: false, reason: 'That file is not a Hiro data export. A settings export is a different file — import it from Settings → Data.' }
  }
  if (Number(envelope.version) > FORMAT_VERSION) {
    return { ok: false, reason: `That export was written by a newer version of Hiro (format ${envelope.version}). Update Hiro and try again.` }
  }
  if (!envelope.encrypted) return { ok: true, bundle: envelope }

  if (!passphrase) return { ok: false, needsPassphrase: true, reason: 'That export is encrypted — enter its passphrase.' }
  try {
    const key = deriveKey(passphrase, Buffer.from(envelope.kdf.salt, 'base64'))
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
    return { ok: true, bundle: JSON.parse(plain.toString('utf8')) }
  } catch {
    // GCM refused the tag. Overwhelmingly a wrong passphrase; possibly a damaged
    // file. Both mean the same thing to the user standing here.
    return { ok: false, needsPassphrase: true, reason: 'Wrong passphrase, or the file has been altered since it was written.' }
  }
}

function importBundle(text, passphrase = '') {
  const read = readBundle(text, passphrase)
  if (!read.ok) return { success: false, ...read }
  const data = read.bundle?.data
  if (!data || typeof data !== 'object') {
    return { success: false, reason: 'That export contains no data.' }
  }
  const result = database.importAll(data)
  return { success: true, exportedAt: read.bundle.exportedAt, ...result }
}

// What an export would hold, without writing one, so the button can say what it
// is about to save.
function preview() {
  return { counts: buildBundle().counts }
}

module.exports = { exportBundle, importBundle, readBundle, preview, MAGIC, FORMAT_VERSION }
