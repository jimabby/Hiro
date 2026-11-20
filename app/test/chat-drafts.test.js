// Ask Hiro's replies are split into conversation and drafted documents by the
// same function on the phone and on the desktop. The phone carries a copy
// (Metro cannot reach into web/), so this pins the two together: same answers,
// and the same source.

const fs = require('fs')
const path = require('path')
const { createChecker } = require('./helpers')
const { splitDrafts, wordCount } = require('../src/chatDrafts')

const { check, done } = createChecker()

check('a reply with a résumé and a letter', splitDrafts('Here.\n<<<RESUME>>>\nJane\n<<<END>>>\nAlso:\n<<<COVER_LETTER>>>\nDear Sam'), [
  { type: 'text', text: 'Here.' },
  { type: 'draft', kind: 'resume', text: 'Jane', index: 0 },
  { type: 'text', text: 'Also:' },
  { type: 'draft', kind: 'coverLetter', text: 'Dear Sam', index: 1 },
])
check('plain advice is one block', splitDrafts('Use one column.'), [{ type: 'text', text: 'Use one column.' }])
check('words are counted', wordCount('a b\nc'), 3)

const body = (file) => fs.readFileSync(file, 'utf8').replace(/^\/\/.*\n/gm, '')
check('the phone\'s copy has the same code as the desktop\'s',
  body(path.join(__dirname, '..', 'src', 'chatDrafts.js')), body(path.join(__dirname, '..', '..', 'web', 'src', 'chatDrafts.js')))

done()
