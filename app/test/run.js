// Mobile test runner. Same shape as web/test/run.js — one process per suite, no
// framework.
//
// Only pure modules are tested here. Anything that imports react-native or an
// expo-* package needs a native runtime, and the closest thing to coverage for
// those is `expo export` in CI, which runs Metro over every module and catches a
// bad import or a syntax error. So the logic worth pinning — the stats and chart
// derivations that must agree with the desktop, and the local-date handling — was
// extracted into src/stats.js and src/dates.js precisely so it could be reached
// from plain Node.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()
const failed = []

for (const file of files) {
  console.log(`\n── ${file}`)
  try {
    execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' })
  } catch {
    failed.push(file)
  }
}

console.log(
  failed.length === 0
    ? `\n✓ ${files.length} suite${files.length === 1 ? '' : 's'} passed.`
    : `\n✗ ${failed.length} of ${files.length} suites failed: ${failed.join(', ')}`
)
process.exit(failed.length === 0 ? 0 : 1)
