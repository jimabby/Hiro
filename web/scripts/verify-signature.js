#!/usr/bin/env node
// Report — and optionally enforce — the code-signing state of the installers in
// dist-electron.
//
// An unsigned installer is not a cosmetic problem. Windows SmartScreen and
// macOS Gatekeeper both warn on it, which trains users to click through exactly
// the dialog that protects them; and electron-updater's Windows update path
// verifies the publisher of a downloaded update against the installed app, so a
// mix of signed and unsigned releases can break auto-update outright.
//
// Usage:
//   node scripts/verify-signature.js                  # report only
//   node scripts/verify-signature.js --require-signed # exit 1 when unsigned
//
// Linux AppImages have no equivalent OS-level signature, so they report as
// "not applicable" and never fail the check.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const OUT_DIR = path.join(__dirname, '..', 'dist-electron')
const requireSigned = process.argv.includes('--require-signed')

function sh(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Never throw out of a probe: "the tool failed" and "the file is unsigned" are
// different findings and both need to be reported rather than crash the job.
function trySh(file, args) {
  try {
    return { ok: true, out: sh(file, args) }
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}`.trim() || err.message }
  }
}

function findArtifacts(exts) {
  if (!fs.existsSync(OUT_DIR)) return []
  return fs.readdirSync(OUT_DIR)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(OUT_DIR, f))
}

// ── Windows: Authenticode ────────────────────────────────────────
function checkWindows() {
  const results = []
  for (const file of findArtifacts(['.exe'])) {
    // -ExpandProperty on a compound object loses the signer, so emit both
    // fields on one line and split. `-NonInteractive` keeps a broken cert store
    // from hanging the build on a prompt.
    const ps = trySh('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = Get-AuthenticodeSignature -FilePath '${file}'; ` +
      `"$($s.Status)|$($s.SignerCertificate.Subject)|$($s.TimeStamperCertificate.Subject)"`,
    ])
    if (!ps.ok) {
      results.push({ file, state: 'unknown', detail: ps.out })
      continue
    }
    const [status, signer, timestamper] = ps.out.trim().split('|')
    results.push({
      file,
      state: status === 'Valid' ? 'signed' : 'unsigned',
      detail: [
        `Authenticode status: ${status || 'unknown'}`,
        signer ? `signer: ${signer}` : 'signer: none',
        // A signature with no countersignature stops validating the day the
        // certificate expires, taking every already-shipped installer with it.
        timestamper ? `timestamped by: ${timestamper}` : 'NOT timestamped — signature will expire with the certificate',
      ].join('\n    '),
    })
  }
  return results
}

// ── macOS: Developer ID + notarization ───────────────────────────
function checkMac() {
  const results = []

  // The .app inside the staging directory is what actually carries the
  // signature; the DMG only carries the notarization ticket.
  const apps = []
  if (fs.existsSync(OUT_DIR)) {
    for (const entry of fs.readdirSync(OUT_DIR)) {
      const dir = path.join(OUT_DIR, entry)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const inner of fs.readdirSync(dir)) {
        if (inner.endsWith('.app')) apps.push(path.join(dir, inner))
      }
    }
  }

  for (const app of apps) {
    const verify = trySh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    const info = trySh('codesign', ['-dv', '--verbose=4', app])
    const authority = (info.out.match(/^Authority=.*$/m) || [])[0] || 'Authority: none'
    const isDeveloperId = /Authority=Developer ID Application:/.test(info.out)
    results.push({
      file: app,
      state: verify.ok && isDeveloperId ? 'signed' : 'unsigned',
      detail: [
        `codesign --verify: ${verify.ok ? 'ok' : 'FAILED'}`,
        authority.trim(),
        verify.ok ? null : verify.out,
      ].filter(Boolean).join('\n    '),
    })
  }

  // Whether the app this build signed carries a Developer ID signature. The DMG
  // takes its signing state from it when Gatekeeper's verdict on the DMG does
  // not say.
  const appSigned = results.length > 0 && results.every(r => r.state === 'signed')

  for (const dmg of findArtifacts(['.dmg'])) {
    // Gatekeeper's own verdict, which is what an end user's Mac will apply.
    // "Notarized Developer ID" is the only answer that opens without a warning.
    //
    // A signed DMG with no notarization ticket is NOT unsigned, and used to be
    // reported as such — so a build with a certificate but no API key failed
    // --require-signed, contradicting RELEASING.md, which documents that state
    // as "signed but un-notarized. Gatekeeper warns on first open". It is now
    // its own state: it passes the signing gate and is flagged as a warning.
    const assess = trySh('spctl', ['--assess', '--type', 'install', '--verbose=4', dmg])
    const notarized = /source=Notarized Developer ID/.test(assess.out)
    let signed = /source=(Unnotarized )?Developer ID/.test(assess.out)
    if (!notarized && !signed) {
      const info = trySh('codesign', ['-dv', '--verbose=4', dmg])
      signed = /Authority=Developer ID Application:/.test(info.out) || appSigned
    }
    results.push({
      file: dmg,
      state: notarized ? 'notarized' : signed ? 'signed-not-notarized' : 'unsigned',
      detail: [
        `spctl: ${assess.out.split('\n').map(l => l.trim()).filter(Boolean).join(' / ') || 'no output'}`,
        notarized || !signed ? null : 'Developer ID signed, but no notarization ticket — Gatekeeper warns on first open. Add the App Store Connect API key (RELEASING.md).',
      ].filter(Boolean).join('\n    '),
    })
  }

  return results
}

function checkLinux() {
  return findArtifacts(['.appimage']).map(file => ({
    file,
    state: 'n/a',
    detail: 'AppImages carry no OS-level signature; integrity comes from the GitHub release checksum.',
  }))
}

const byPlatform = { win32: checkWindows, darwin: checkMac, linux: checkLinux }
const results = (byPlatform[process.platform] || checkLinux)()

if (results.length === 0) {
  console.error(`No installers found in ${OUT_DIR} — run the build first.`)
  process.exit(1)
}

const ICON = { signed: '✓', notarized: '✓', 'signed-not-notarized': '!', 'n/a': '–', unsigned: '✗', unknown: '?' }
for (const r of results) {
  console.log(`${ICON[r.state] || '?'} ${r.state.toUpperCase()}  ${path.basename(r.file)}`)
  console.log(`    ${r.detail}`)
}

const bad = results.filter(r => r.state === 'unsigned' || r.state === 'unknown')
const unnotarized = results.filter(r => r.state === 'signed-not-notarized')
if (bad.length === 0) {
  console.log('\nAll artifacts are signed.')
  if (unnotarized.length) {
    // Signed is what --require-signed asks for; notarization is a separate,
    // documented step (RELEASING.md), so this warns rather than fails.
    console.log(`Warning: ${unnotarized.length} macOS artifact(s) are signed but not notarized — Gatekeeper will warn on first open.`)
  }
  process.exit(0)
}

const summary = `${bad.length} of ${results.length} artifact(s) are not properly signed.`
if (!requireSigned) {
  console.log(`\n${summary}`)
  console.log('Publishing unsigned installers means SmartScreen/Gatekeeper warnings for every user.')
  console.log('See RELEASING.md for the certificates and secrets this needs.')
  process.exit(0)
}

console.error(`\n${summary}`)
console.error('Refusing to publish. See RELEASING.md to configure signing, or set the')
console.error('ALLOW_UNSIGNED_RELEASE repository variable to 1 to ship unsigned anyway.')
process.exit(1)
