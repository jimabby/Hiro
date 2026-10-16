// Reading the whole job search out of the database, and merging one back in.
//
// Lives beside database.js rather than inside it because it is the only code
// that needs to know the SHAPE of the schema as a whole — which tables hang off
// an application, and what identifies a row across two machines. Everything else
// in database.js works one feature at a time.
//
// Two problems this has to solve, and neither is obvious from the outside:
//
//   Row identity. An application's primary key is an autoincrementing integer,
//   which means nothing on another machine — importing into a database that
//   already has rows 1..40 would collide with every one of them. The job URL is
//   the only thing that identifies the same application on two devices, and it
//   is already what hasSeenJobUrl and cloud sync key on.
//
//   Child rows. Status history, interviews, replies, snapshots and offers all
//   reference application_id. Those ids WILL be different after an import, so
//   every child row travels with its parent's URL and is re-pointed at whatever
//   id the parent ended up with here.
//
// The import merges and never deletes. Cloud sync refuses to guess between
// merging and replacing precisely because two of the three reasonable answers
// destroy data; the same is true here, so only the safe one is offered.

// Tables that stand on their own, with the column that identifies a row across
// machines. `null` means "append, no natural key" — a run log rather than a
// record of something.
const STANDALONE = [
  { table: 'screening_cache', key: 'question_hash' },
  { table: 'suppressed_roles', key: 'role_key' },
  { table: 'contacts', key: null, unique: ['email', 'company'] },
  { table: 'campaign_runs', key: null },
  // Answers the user worked out themselves, keyed on the normalised question.
  // Not attached to any application — the answer to "why are you leaving your
  // current role" belongs to the candidate, not to whichever employer asked it
  // first — so it stands on its own here, and losing it on a machine move would
  // be losing something hand-written.
  { table: 'interview_answers', key: 'question_key' },
]

// Tables whose rows belong to one application.
const CHILDREN = [
  { table: 'status_history' },
  { table: 'interview_events' },
  { table: 'interview_prep' },
  { table: 'application_snapshots' },
  { table: 'recruiter_replies' },
  // One row per application rather than many, but the same remapping applies.
  { table: 'offers' },
]

// Deliberately NOT exported: push_log, calendar_links, sync_conflicts,
// deleted_applications, automation_events and ai_usage. Every one of them is
// bookkeeping about THIS machine's runtime — notifications already sent from
// this install, events in this user's calendar account, tombstones owed to a
// cloud project, a health log about scrapes that happened here. Restoring them
// elsewhere would re-suppress notifications that were never sent, point at
// calendar events that do not exist, or tell cloud sync to delete rows.

function build({ query }) {
  const out = {}
  out.applications = query('SELECT * FROM applications')
  out.attention_jobs = query('SELECT * FROM attention_jobs')

  // The parent's URL travels with each child, because the id it currently has
  // will not survive the trip.
  const urlById = new Map(out.applications.map(a => [a.id, a.job_url]))
  for (const { table } of CHILDREN) {
    out[table] = query(`SELECT * FROM ${table}`)
      .map(row => ({ ...row, _job_url: urlById.get(row.application_id) || null }))
      // A child whose parent is gone cannot be re-pointed at anything, and
      // carrying it would import an orphan.
      .filter(row => row._job_url)
  }

  for (const { table } of STANDALONE) out[table] = query(`SELECT * FROM ${table}`)
  return out
}

// ─── The file is not trusted ─────────────────────────────────────
//
// An export is a JSON file the user picked from disk. It may have been written
// by a newer Hiro, edited by hand, or handed to them by someone else, and
// everything in it used to go into the database on trust:
//
//   Column names. The JSON keys were pasted into the INSERT unquoted. A key
//   like `job_title) VALUES ('x'); DROP TABLE applications; --` was SQL.
//   Columns are now checked against the table's real columns (PRAGMA
//   table_info), and anything else is dropped and reported, never interpolated.
//
//   Privileged values. screening_cache.source = 'user' tells the fabrication
//   guard that a human typed the answer, and the guard deliberately never
//   second-guesses a human. An imported answer did not come from this user at
//   this keyboard, so it arrives as 'ai' and is re-checked like model output.
//
//   Atomicity. batch() only defers the write to disk; it is not a transaction.
//   A row that threw half-way through (a duplicate id, a NOT NULL column the
//   file left out) left everything before it in the database and everything
//   after it missing. The whole merge now runs in one transaction and either
//   all of it lands or none of it does.
//
// The same code also answers "what would this do?" without doing it: a dry run
// performs the whole merge inside the transaction and rolls it back, so the
// preview cannot disagree with the import.

// Values a row from the file is forced to take, whatever it says.
const FORCED = {
  screening_cache: { source: 'ai' },
}

// sql.js binds numbers, strings, null and byte arrays. Anything else in a JSON
// file (an object, an array, a boolean) is turned into something it can bind
// rather than allowed to throw half-way through the import.
function bindable(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function columnsOf(query, table, cache) {
  if (!cache.has(table)) {
    cache.set(table, new Set(query(`PRAGMA table_info("${table}")`).map(c => c.name)))
  }
  return cache.get(table)
}

// The row as it will be inserted: only real columns, never the skipped ones,
// forced values applied. Unknown keys are reported through `unknown`.
function cleanRow(query, cache, table, row, skip, unknown) {
  const known = columnsOf(query, table, cache)
  const out = {}
  for (const [column, value] of Object.entries(row || {})) {
    if (column.startsWith('_') || skip.has(column) || value === undefined) continue
    if (!known.has(column)) {
      if (!unknown[table]) unknown[table] = new Set()
      unknown[table].add(column)
      continue
    }
    out[column] = bindable(value)
  }
  return { ...out, ...(FORCED[table] || {}) }
}

// Column names here have already been checked against PRAGMA table_info, and
// are quoted anyway.
function insertRow(run, table, row) {
  const columns = Object.keys(row)
  if (columns.length === 0) return
  run(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map(c => row[c]))
}

// Columns whose values describe this machine's relationship to a cloud project,
// not the application. A merged row starts as unsynced and unseen, which is
// what makes the next sync push it rather than believing it is already up there.
const CLOUD_COLUMNS = new Set(['cloud_dirty', 'cloud_updated_at', 'cloud_id'])

// Two rows are the same child when every column the file carries matches. The
// row's own id is not compared (it is reassigned on every machine); the parent
// id has already been re-pointed, so it is.
const sameValue = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b))

function merge({ query, queryOne, run, transaction }, data, { dryRun = false } = {}) {
  const added = {}
  const skipped = {}
  const unknown = {}
  const cache = new Map()
  const bump = (bag, table, n = 1) => { bag[table] = (bag[table] || 0) + n }

  const body = () => {
    // ── Applications, keyed by URL ────────────────────────────────
    // Existing rows are left exactly as they are. An import is new information
    // arriving, not a correction to what is already here — and silently
    // overwriting a row the user has since edited is the destructive answer this
    // deliberately does not offer.
    const urlToId = new Map(
      query('SELECT id, job_url FROM applications WHERE job_url IS NOT NULL').map(r => [r.job_url, r.id]))

    for (const app of data.applications || []) {
      if (!app?.job_url) { bump(skipped, 'applications'); continue }
      if (urlToId.has(app.job_url)) { bump(skipped, 'applications'); continue }
      insertRow(run, 'applications', cleanRow(query, cache, 'applications', app, new Set(['id', ...CLOUD_COLUMNS]), unknown))
      const created = queryOne('SELECT last_insert_rowid() as id')?.id
      if (created) urlToId.set(app.job_url, created)
      bump(added, 'applications')
    }

    const attentionUrls = new Set(
      query('SELECT job_url FROM attention_jobs WHERE job_url IS NOT NULL').map(r => r.job_url))
    for (const job of data.attention_jobs || []) {
      if (!job?.job_url || attentionUrls.has(job.job_url)) { bump(skipped, 'attention_jobs'); continue }
      insertRow(run, 'attention_jobs', cleanRow(query, cache, 'attention_jobs', job, new Set(['id']), unknown))
      attentionUrls.add(job.job_url)
      bump(added, 'attention_jobs')
    }

    // ── Child rows, re-pointed at the ids they ended up with ──────
    //
    // A child is skipped when an IDENTICAL row is already attached to its
    // parent. The check used to be "does this parent have any row in this
    // table", asked again for every row — so the first status change was
    // imported and every later one was taken for a duplicate of it, and an
    // application arrived with one interview, one reply and one history entry
    // however many it had.
    for (const { table } of CHILDREN) {
      const existingByParent = new Map()
      const existingFor = (parentId) => {
        if (!existingByParent.has(parentId)) {
          existingByParent.set(parentId, query(`SELECT * FROM "${table}" WHERE application_id = ?`, [parentId]))
        }
        return existingByParent.get(parentId)
      }
      for (const row of data[table] || []) {
        const parentId = urlToId.get(row?._job_url)
        if (!parentId) { bump(skipped, table); continue }
        const clean = cleanRow(query, cache, table, { ...row, application_id: parentId }, new Set(['id']), unknown)
        const columns = Object.keys(clean)
        const siblings = existingFor(parentId)
        // offers is keyed by application_id, so a parent has at most one.
        const duplicate = table === 'offers'
          ? siblings.length > 0
          : siblings.some(existing => columns.every(c => sameValue(existing[c], clean[c])))
        if (duplicate) { bump(skipped, table); continue }
        insertRow(run, table, clean)
        // Seen from now on, so the same row twice in one file is one row.
        siblings.push(clean)
        bump(added, table)
      }
    }

    // ── Standalone tables ─────────────────────────────────────────
    for (const { table, key, unique } of STANDALONE) {
      const rows = data[table] || []
      if (rows.length === 0) continue
      const seen = key
        ? new Set(query(`SELECT "${key}" FROM "${table}"`).map(r => r[key]))
        : new Set(unique ? query(`SELECT ${unique.map(c => `"${c}"`).join(', ')} FROM "${table}"`).map(r => unique.map(c => r[c]).join('')) : [])
      for (const row of rows) {
        const identity = key ? row?.[key] : (unique ? unique.map(c => row?.[c]).join('') : null)
        if (identity != null && seen.has(identity)) { bump(skipped, table); continue }
        // The row's own id is never taken from the file unless it IS the key:
        // an autoincrement id from another machine collides with one here.
        insertRow(run, table, cleanRow(query, cache, table, row, new Set(key === 'id' ? [] : ['id']), unknown))
        if (identity != null) seen.add(identity)
        bump(added, table)
      }
    }
  }

  transaction(body, { rollback: dryRun })

  const total = Object.values(added).reduce((n, v) => n + v, 0)
  const unknownColumns = Object.fromEntries(Object.entries(unknown).map(([t, set]) => [t, [...set].sort()]))
  return { added, skipped, total, unknownColumns, dryRun }
}

module.exports = { build, merge, STANDALONE, CHILDREN }
