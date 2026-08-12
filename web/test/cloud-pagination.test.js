const { stub, service, createChecker } = require('./helpers')
stub({
  './config': { load: () => ({}), update: () => ({}) },
  './database': { getTombstones: () => [], countSyncConflicts: () => 0 },
  './logger': { append: () => {} },
})
const { selectAll } = service('cloudSync')
const { check, done } = createChecker()

;(async () => {
  const source = Array.from({ length: 1205 }, (_, i) => ({ id: i + 1 }))
  const ranges = []
  const rows = await selectAll(() => ({
    range(from, to) { ranges.push([from, to]); return Promise.resolve({ data: source.slice(from, to + 1), error: null }) },
  }), 500)
  check('reads beyond the first Supabase page', rows.length, 1205)
  check('preserves the final row', rows.at(-1).id, 1205)
  check('requests every page exactly once', ranges, [[0, 499], [500, 999], [1000, 1499]])
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
