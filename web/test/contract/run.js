// Contract tests: do the external services still behave the way Hiro assumes?
//
// Separate from `npm test` on purpose. The unit suites are hermetic and must stay
// that way — they run on every push and a network blip must never fail a PR. These
// go the other way: they make real calls, and their whole value is telling you
// that Greenhouse changed a field name or a model changed its output shape, which
// no amount of mocking can reveal.
//
//   npm run test:contract
//
// Each suite decides for itself whether it can run. The job-board suites need only
// an internet connection; the AI suites need a real API key in the environment and
// SKIP (loudly, not silently) without one. A skip is not a pass — the summary
// counts them separately so "everything passed" cannot mean "nothing ran".

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.contract.js')).sort()
const failed = []
const skipped = []

for (const file of files) {
  console.log(`\n── ${file}`)
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' })
    process.stdout.write(out)
    // Exit code 0 with no checks run means the suite skipped itself.
    if (/^SKIP /m.test(out) && !/^PASS /m.test(out)) skipped.push(file)
  } catch (err) {
    process.stdout.write(err.stdout || '')
    process.stderr.write(err.stderr || '')
    failed.push(file)
  }
}

const ran = files.length - skipped.length
console.log(`\n${failed.length === 0 ? '✓' : '✗'} ${ran} of ${files.length} contract suite(s) ran`
  + `${skipped.length ? `, ${skipped.length} skipped (${skipped.join(', ')})` : ''}`
  + `${failed.length ? `, ${failed.length} FAILED (${failed.join(', ')})` : ''}`)

if (failed.length > 0) {
  console.log('\nA failure here usually means an upstream service changed, not that Hiro')
  console.log('regressed. Read the assertion, check the provider\'s docs, and fix the adapter.')
}
process.exit(failed.length === 0 ? 0 : 1)
