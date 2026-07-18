// Test runner. Each test file is a standalone process because the services are
// CommonJS singletons — sharing one process would leak state between suites.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()
let failed = []

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
