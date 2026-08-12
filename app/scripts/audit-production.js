const { spawnSync } = require('child_process')
const path = require('path')

// These two image-size parsers are reached through Expo/Metro's developer
// asset pipeline, have no fixed release, and never parse remote input in Hiro.
const allowed = new Set([1138808, 1138809])

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
