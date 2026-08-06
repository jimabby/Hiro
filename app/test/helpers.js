// Minimal checker, mirroring web/test/helpers.js so the two suites read alike.

function createChecker() {
  let failures = 0
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
  }
  const done = () => {
    console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
    process.exitCode = failures === 0 ? 0 : 1
  }
  return { check, done }
}

// A fixed instant, so nothing here depends on when the suite happens to run.
// Deliberately mid-afternoon local: a test written against midnight would pass
// even if the code used UTC boundaries.
const NOW = new Date(2026, 7, 6, 15, 30, 0) // 2026-08-06 15:30 local

// applied_at as the cloud stores it: an ISO instant.
function at(daysAgo, hour = 12) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour, 0, 0)
  return d.toISOString()
}

let seq = 0
function app(overrides = {}) {
  seq++
  return {
    id: seq,
    local_id: seq,
    job_title: `Role ${seq}`,
    company: `Company ${seq}`,
    platform: 'Seek',
    status: 'applied',
    match_score: 85,
    applied_at: at(0),
    updated_at: at(0),
    ...overrides,
  }
}

module.exports = { createChecker, NOW, at, app }
