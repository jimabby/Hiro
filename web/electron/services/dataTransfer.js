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

// `dryRun` performs the whole merge inside a transaction and rolls it back, so
// the preview reports exactly what the import would do: "would add X, skip Y,
// these columns are not known here". Nothing is written either way until the
// user confirms.
function importBundle(text, passphrase = '', { dryRun = false } = {}) {
  const read = readBundle(text, passphrase)
  if (!read.ok) return { success: false, ...read }
  const data = read.bundle?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { success: false, reason: 'That export contains no data.' }
  }
  try {
    const result = database.importAll(data, { dryRun })
    return { success: true, exportedAt: read.bundle.exportedAt, ...result }
  } catch (err) {
    // The merge is one transaction, so a failure here has changed nothing.
    return { success: false, reason: `The import was not applied, and nothing was changed: ${err.message}` }
  }
}

function previewImport(text, passphrase = '') {
  return importBundle(text, passphrase, { dryRun: true })
}

// What an export would hold, without writing one, so the button can say what it
// is about to save.
function preview() {
  return { counts: buildBundle().counts }
}

// ─── Scheduled export ────────────────────────────────────────────
//
// The manual export is the copy that survives a lost keychain, but only if
// somebody remembers to make one, and the moment it is needed is the moment
// after it was last forgotten. This writes the same encrypted file on a
// schedule into a folder the user picked, typically one already covered by a
// backup tool or a synced drive, and keeps the newest N.
//
// Always encrypted. A file written unattended into a synced folder, holding
// every résumé, cover letter and recruiter address, is not something to write
// in the clear by default, and a scheduled job has nobody to tick the box. The
// passphrase is a config secret (OS keychain), entered once.
//
// Only files this feature named are ever rotated away: the prefix below. A
// folder the user also keeps other things in is safe.
const SCHEDULED_PREFIX = 'hiro-scheduled-'
const SCHEDULED_EXT = '.hirodata'
const FREQUENCIES = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }
const MAX_KEEP = 100

function scheduleSettings(cfg) {
  const s = cfg.scheduledExport || {}
  return {
    enabled: !!s.enabled,
    folder: String(s.folder || ''),
    frequency: FREQUENCIES[s.frequency] ? s.frequency : 'weekly',
    keep: Math.max(1, Math.min(MAX_KEEP, Math.round(Number(s.keep) || 5))),
  }
}

function nextDueAt(cfg) {
  const settings = scheduleSettings(cfg)
  if (!settings.enabled) return null
  const last = Date.parse(cfg.scheduledExportLastRunAt || '')
  return Number.isFinite(last) ? new Date(last + FREQUENCIES[settings.frequency]).toISOString() : new Date(0).toISOString()
}

function getScheduledExportStatus() {
  const configService = require('./config')
  const cfg = configService.load()
  return {
    ...scheduleSettings(cfg),
    // Never the passphrase itself: the renderer only needs to know it is set.
    hasPassphrase: !!cfg.scheduledExportPassphrase,
    lastRunAt: cfg.scheduledExportLastRunAt || null,
    lastResult: cfg.scheduledExportLastResult || null,
    nextDueAt: nextDueAt(cfg),
    files: listScheduledExports(scheduleSettings(cfg).folder),
  }
}

function listScheduledExports(folder) {
  const fs = require('fs')
  const path = require('path')
  if (!folder) return []
  try {
    return fs.readdirSync(folder)
      .filter(name => name.startsWith(SCHEDULED_PREFIX) && name.endsWith(SCHEDULED_EXT))
      // The name carries a sortable UTC timestamp, so name order is age order
      // without trusting mtimes a sync client may have rewritten.
      .sort().reverse()
      .map(name => {
        const st = fs.statSync(path.join(folder, name))
        return { name, size: st.size, mtime: st.mtime.toISOString() }
      })
  } catch {
    return []
  }
}

// Validate and store. `passphrase` blank keeps the stored one, so changing the
// schedule does not mean retyping it.
function configureScheduledExport(input = {}) {
  const fs = require('fs')
  const path = require('path')
  const configService = require('./config')
  const cfg = configService.load()
  const current = scheduleSettings(cfg)
  const next = scheduleSettings({ scheduledExport: { ...current, ...input } })
  const passphrase = typeof input.passphrase === 'string' ? input.passphrase : ''

  if (passphrase && passphrase.length < 8) return { success: false, reason: 'The passphrase must be at least 8 characters.' }
  if (next.enabled) {
    if (!next.folder || !path.isAbsolute(next.folder)) return { success: false, reason: 'Choose a folder for the exports.' }
    try {
      if (!fs.statSync(next.folder).isDirectory()) return { success: false, reason: 'That path is not a folder.' }
    } catch {
      return { success: false, reason: 'That folder does not exist.' }
    }
    if (!passphrase && !cfg.scheduledExportPassphrase) {
      return { success: false, reason: 'Set a passphrase. Scheduled exports are always encrypted.' }
    }
  }
  configService.update(c => ({
    ...c,
    scheduledExport: next,
    ...(passphrase ? { scheduledExportPassphrase: passphrase } : {}),
  }))
  return { success: true, ...getScheduledExportStatus() }
}

function stamp(now) {
  return now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
}

// Write one export now and rotate. Records the outcome either way, so a
// schedule that has been failing silently for a month shows up in Settings.
function runScheduledExport({ now = new Date() } = {}) {
  const fs = require('fs')
  const path = require('path')
  const configService = require('./config')
  const cfg = configService.load()
  const settings = scheduleSettings(cfg)
  // Only a success moves the schedule on. A failure (a folder on a drive that
  // is not mounted yet) is retried at the next hourly check, not a week later.
  const record = (result) => {
    configService.update(result.success
      ? { scheduledExportLastRunAt: now.toISOString(), scheduledExportLastResult: result }
      : { scheduledExportLastResult: result })
    return result
  }
  if (!settings.folder) return record({ success: false, reason: 'No export folder is set.', at: now.toISOString() })
  if (!cfg.scheduledExportPassphrase) {
    return record({ success: false, reason: 'No passphrase is set (or the keychain could not unlock it).', at: now.toISOString() })
  }
  try {
    const bundle = exportBundle(cfg.scheduledExportPassphrase)
    const file = path.join(settings.folder, `${SCHEDULED_PREFIX}${stamp(now)}${SCHEDULED_EXT}`)
    // Temp file and rename, so a sync client watching the folder never uploads
    // half a file and the rotation below never counts one.
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, bundle.text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    const removed = []
    for (const old of listScheduledExports(settings.folder).slice(settings.keep)) {
      try { fs.unlinkSync(path.join(settings.folder, old.name)); removed.push(old.name) } catch { /* next run retries */ }
    }
    return record({ success: true, file, removed, counts: bundle.counts, at: now.toISOString() })
  } catch (err) {
    return record({ success: false, reason: err.message, at: now.toISOString() })
  }
}

// The scheduler hook: cheap to call often (main.js calls it hourly and at
// launch), and does nothing unless an export is enabled and due. A machine that
// was asleep at the due time exports on the next call after waking, rather than
// waiting a whole period.
function maybeRunScheduledExport({ now = new Date() } = {}) {
  const configService = require('./config')
  const cfg = configService.load()
  const due = nextDueAt(cfg)
  if (!due || Date.parse(due) > now.getTime()) return { ran: false }
  return { ran: true, ...runScheduledExport({ now }) }
}

module.exports = {
  exportBundle, importBundle, previewImport, readBundle, preview, MAGIC, FORMAT_VERSION,
  getScheduledExportStatus, configureScheduledExport, runScheduledExport, maybeRunScheduledExport,
  SCHEDULED_PREFIX,
}
