#!/usr/bin/env node
// Builds the store uploads for the extension:
//
//   extension/dist/hiro-importer-chrome-<version>.zip   Chrome Web Store, Edge Add-ons
//   extension/dist/hiro-importer-firefox-<version>.zip  addons.mozilla.org
//
// One source tree serves both. Firefox needs an add-on id and its data
// collection declaration in `browser_specific_settings`, which Chrome flags as
// an unrecognised key, so that block is added to the Firefox copy only.
//
// No dependencies: the zip is written here (stored + deflated entries, the
// format every store accepts), so packaging runs on a clean checkout.
//
//   node extension/scripts/package.js

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'dist')

// What ships. Everything else in extension/ (README, scripts, dist) stays out.
const FILES = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  'protocol.js',
  'pairChannel.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
]

// addons.mozilla.org requires an id it can keep across updates, and (for new
// add-ons) a statement of what data leaves the browser. The listing's text and
// address go to the user's own Hiro desktop, which Mozilla's definitions
// count as website content being transmitted.
const FIREFOX_SETTINGS = {
  gecko: {
    id: 'job-importer@hiro.app',
    // storage.session, scripting and MV3 optional host permissions.
    strict_min_version: '128.0',
    data_collection_permissions: { required: ['websiteContent'] },
  },
}

function manifestFor(target) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
  if (target === 'firefox') {
    delete manifest.minimum_chrome_version
    manifest.browser_specific_settings = FIREFOX_SETTINGS
  }
  return manifest
}

// ─── A minimal zip writer ─────────────────────────────────────────

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  // A fixed timestamp, so the same source always gives the same zip.
  const { time, day } = dosDateTime(new Date(2026, 0, 1))
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = zlib.crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)        // version made by
    central.writeUInt16LE(20, 6)        // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function build(target) {
  const manifest = manifestFor(target)
  const entries = FILES.map(name => ({
    name,
    data: name === 'manifest.json'
      ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
      : fs.readFileSync(path.join(ROOT, name)),
  }))
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `hiro-importer-${target}-${manifest.version}.zip`)
  fs.writeFileSync(file, zip(entries))
  return file
}

if (require.main === module) {
  for (const target of ['chrome', 'firefox']) {
    const file = build(target)
    console.log(`${target}: ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`)
  }
}

module.exports = { FILES, manifestFor, zip, build }
