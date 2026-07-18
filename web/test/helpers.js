// Minimal test harness — no framework, just node.
//
// The main-process services are CommonJS singletons that require each other by
// relative path, so `stub()` intercepts those requires to inject fakes. Only
// requires originating from inside services/ are intercepted, so a test can
// still pull in real modules normally.

const Module = require('module')
const path = require('path')

const SERVICES_DIR = path.join(__dirname, '..', 'electron', 'services')

let installed = false
let stubs = {}

function stub(map) {
  stubs = map
  if (installed) return
  installed = true
  const origLoad = Module._load
  Module._load = function (request, parent) {
    if (parent && parent.filename && parent.filename.startsWith(SERVICES_DIR) && stubs[request]) {
      return stubs[request]
    }
    return origLoad.apply(this, arguments)
  }
}

function service(name) {
  return require(path.join(SERVICES_DIR, name))
}

function createChecker() {
  let failures = 0
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
  }
  const done = () => {
    console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
    process.exit(failures === 0 ? 0 : 1)
  }
  return { check, done }
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

module.exports = { stub, service, createChecker, tick, SERVICES_DIR }
