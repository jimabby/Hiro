// A local model is a configured model.
//
// Ollama and LM Studio authenticate nothing, and Setup lets "local" be chosen
// without a key. Eight sites nevertheless asked for `aiProvider && aiApiKey`,
// so the most private configuration Hiro offers ran as if there were no AI at
// all — and on the three auto-apply flows that meant screening questions were
// skipped outright, leaving the form's required answers blank.

const fs = require('fs')
const path = require('path')
const { service, createChecker } = require('./helpers')
const { isAiConfigured } = service('ai/configured')
const { check, done } = createChecker()

check('a local model needs no key', isAiConfigured({ aiProvider: 'local', aiApiKey: '' }), true)
check('a hosted provider needs a key', isAiConfigured({ aiProvider: 'claude', aiApiKey: '' }), false)
check('a whitespace key is no key', isAiConfigured({ aiProvider: 'openai', aiApiKey: '   ' }), false)
check('a hosted provider with a key is configured', isAiConfigured({ aiProvider: 'gemini', aiApiKey: 'k' }), true)
check('no provider is not configured', isAiConfigured({ aiApiKey: 'k' }), false)
check('no config is not configured', isAiConfigured(null), false)

// No call site may go back to testing the key directly. Scanned rather than
// listed, so a new site written the old way fails here too.
const ROOT = path.join(__dirname, '..', 'electron')
const offenders = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) {
      const src = fs.readFileSync(full, 'utf8')
      if (/aiProvider\s*&&\s*cfg\.aiApiKey|!cfg\.aiApiKey\b/.test(src)) offenders.push(path.relative(ROOT, full))
    }
  }
}
walk(ROOT)
check('no call site gates AI on the key alone', offenders, [])

done()
