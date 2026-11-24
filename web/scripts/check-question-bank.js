#!/usr/bin/env node
// Validates the practice question bank (web/electron/data/questions.json).
//
// Run on every pull request that touches the bank, so a community contribution
// or an AI-suggested fix cannot ship something the app would drop or misshow.
// Installed apps download this file from main (services/practice.js
// refreshBank), so whatever passes here reaches users without a release.
//
// Usage: node web/scripts/check-question-bank.js [path] [--against previous.json]
//
// --against compares with the copy the change started from (the workflow
// passes the base commit's file): when any question changed, the file's
// updatedAt has to move forward to a current date.

const fs = require('fs')
const path = require('path')
const core = require('../electron/services/practiceCore')

const argv = process.argv.slice(2)
const againstAt = argv.indexOf('--against')
const against = againstAt >= 0 ? argv[againstAt + 1] : null
const positional = argv.filter((a, i) => !a.startsWith('--') && !(againstAt >= 0 && i === againstAt + 1))
const file = positional[0] || path.join(__dirname, '..', 'electron', 'data', 'questions.json')
const ALLOWED_TAGS = new Set(['p', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'code', 'pre', 'br'])
const DAY = /^\d{4}-\d{2}-\d{2}$/
const problems = []
const warn = []

let parsed
try {
  parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`✗ ${file} is not valid JSON: ${err.message}`)
  process.exit(1)
}

if (parsed.schema !== 1) problems.push(`"schema" must be 1 (got ${JSON.stringify(parsed.schema)})`)
if (!DAY.test(String(parsed.updatedAt || ''))) problems.push('"updatedAt" must be a date like 2026-11-21')
const list = Array.isArray(parsed.questions) ? parsed.questions : []
if (!list.length) problems.push('"questions" must be a non-empty array')

const ids = new Set()
const texts = new Map()
let newest = ''
for (const [i, q] of list.entries()) {
  const where = q && q.id ? q.id : `#${i + 1}`
  if (!core.cleanQuestion(q)) {
    problems.push(`${where}: missing or invalid id, topic, question or answer (ids are lowercase letters, digits and hyphens)`)
    continue
  }
  if (ids.has(q.id)) problems.push(`${where}: duplicate id`)
  ids.add(q.id)
  const key = q.question.trim().toLowerCase()
  if (texts.has(key)) problems.push(`${where}: same question as ${texts.get(key)}`)
  texts.set(key, q.id)
  for (const m of q.answer.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    if (!ALLOWED_TAGS.has(m[1].toLowerCase())) problems.push(`${where}: <${m[1]}> is not allowed in answers`)
    else if (m[2].trim()) problems.push(`${where}: attributes are not allowed (${m[0]})`)
  }
  if (q.difficulty != null && !core.DIFFICULTIES.includes(q.difficulty)) problems.push(`${where}: difficulty must be easy, medium or hard`)
  if (q.category != null && !core.normalizeCategory(q.category)) problems.push(`${where}: unknown category "${q.category}" (one of ${core.CATEGORIES.join(', ')})`)
  if (!q.category) warn.push(`${where}: no category`)
  for (const f of ['updatedAt', 'reviewedAt']) {
    if (q[f] != null && !DAY.test(String(q[f]))) problems.push(`${where}: ${f} must be a date like 2026-11-21`)
  }
  if (q.updatedAt && q.updatedAt > newest) newest = q.updatedAt
  if (core.answerBlocks(q.answer).length === 0) problems.push(`${where}: the answer has no readable text`)
}
// The app keeps the copy it shipped with unless the published file is at least
// as new, so a changed question with an old file date would never be fetched.
if (newest && parsed.updatedAt < newest) problems.push(`"updatedAt" (${parsed.updatedAt}) is older than a question's updatedAt (${newest}); bump it`)

// A device that downloaded the bank keeps its copy over the one an update
// ships whenever the dates tie, and the daily download is what replaces it. So
// a change to the questions that leaves the date alone reaches people late,
// and the date stops saying anything. It stayed 2026-11-21 through three
// rounds of new questions before this check existed.
if (against) {
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(against, 'utf8')) } catch { previous = null }
  if (previous && JSON.stringify(previous.questions) !== JSON.stringify(parsed.questions)) {
    const prevAt = String(previous.updatedAt || '')
    const at = String(parsed.updatedAt || '')
    // Later than before; or the same date when that date is current, so two
    // edits on one day do not need tomorrow's date. Not "today" outright: a
    // reviewed pull request dated the day it was opened may merge days later.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (at < prevAt || (at === prevAt && prevAt < yesterday)) {
      problems.push(`the questions changed but "updatedAt" is ${at || 'missing'} (was ${prevAt || 'missing'}); set it to today's date`)
    }
  }
}

for (const w of warn.slice(0, 10)) console.log(`  note: ${w}`)
if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${path.basename(file)}:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
const topics = new Set(list.map(q => q.topic))
console.log(`✓ ${list.length} questions across ${topics.size} topics, updated ${parsed.updatedAt}.`)
