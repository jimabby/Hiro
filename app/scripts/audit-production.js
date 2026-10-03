const { spawnSync } = require('child_process')
const path = require('path')

// These two image-size parsers are reached through Expo/Metro's developer
// asset pipeline and never parse remote input in Hiro. The fixed release is
// image-size 2.x, whose API Metro's 1.x call sites cannot use, so it cannot be
// forced with an override. npm re-issued both under new ids (GHSA-5p2g-fcmc-qvqq,
// GHSA-w3rx-r6r6-pgpr); the old ids stay so an older npm cache still passes.
//
// braces (GHSA 1240992, stack exhaustion on a crafted glob) and node-forge (GHSA
// 1240912, lenient PKCS#1 v1.5 signature parsing) are reached ONLY through
// @expo/cli — braces via Metro's file map, node-forge via the dev server's
// code-signing certificates. Both run on the developer's machine at build time;
// neither is imported by app code, so Metro never bundles either into the phone
// app. Neither has a fixed release (3.0.3 and 1.4.0 are the latest), and npm's
// only suggested "fix" is a downgrade to Expo SDK 44. Accepted by advisory id,
// not by package, so a future advisory against either still fails the build.
const allowed = new Set([1138808, 1138809, 1239765, 1239766, 1240992, 1240912])

// Invoke npm through Node so this works identically on Windows, where spawning
// npm.cmd directly without a shell returns EINVAL, and on CI.
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const command = process.platform === 'win32' ? process.execPath : 'npm'
const args = process.platform === 'win32'
  ? [npmCli, 'audit', '--omit=dev', '--json']
  : ['audit', '--omit=dev', '--json']
const run = spawnSync(command, args, { encoding: 'utf8' })
if (run.error) { console.error(run.error.message); process.exit(1) }

let report
try { report = JSON.parse(run.stdout) } catch { console.error(run.stderr || run.stdout); process.exit(1) }
const vulnerabilities = report.vulnerabilities || {}
const leafAdvisories = new Map()

// npm represents transitive vulnerability paths as package-name strings. Walk
// those paths so an unrelated future high cannot hide behind an allowed leaf.
function accepted(name, seen = new Set()) {
  if (seen.has(name)) return true
  seen.add(name)
  const finding = vulnerabilities[name]
  if (!finding) return false
  const relevant = (finding.via || []).filter(via => {
    if (typeof via === 'string') return ['high', 'critical'].includes(vulnerabilities[via]?.severity)
    return via && ['high', 'critical'].includes(via.severity)
  })
  if (!relevant.length) return false
  return relevant.every(via => {
    if (typeof via === 'string') return accepted(via, new Set(seen))
    leafAdvisories.set(via.source, via)
    return allowed.has(via.source)
  })
}

const blocked = Object.values(vulnerabilities)
  .filter(v => ['high', 'critical'].includes(v.severity) && !accepted(v.name))
if (blocked.length) {
  for (const item of blocked) console.error(`${item.severity}: ${item.name} has an unaccepted production advisory`)
  process.exit(1)
}
for (const advisory of leafAdvisories.values()) {
  console.log(`accepted build-time advisory ${advisory.source}: ${advisory.title}`)
}
console.log('No unaccepted high/critical production advisories.')
