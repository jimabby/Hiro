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

// Insert a row by name, letting SQLite fill in whatever the export did not
// carry. `skip` drops columns that must not cross machines — the primary key
// above all, which is reassigned here.
function insertRow(run, table, row, skip = new Set()) {
  const columns = Object.keys(row).filter(c => !skip.has(c) && !c.startsWith('_') && row[c] !== undefined)
  if (columns.length === 0) return
  const placeholders = columns.map(() => '?').join(', ')
  run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map(c => row[c]))
}

// Columns whose values describe this machine's relationship to a cloud project,
// not the application. A merged row starts as unsynced and unseen, which is
// what makes the next sync push it rather than believing it is already up there.
const CLOUD_COLUMNS = new Set(['cloud_dirty', 'cloud_updated_at'])

function merge({ query, queryOne, run, batch }, data) {
  const added = {}
  const skipped = {}
  const bump = (bag, table, n = 1) => { bag[table] = (bag[table] || 0) + n }

  batch(() => {
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
      insertRow(run, 'applications', app, new Set(['id', ...CLOUD_COLUMNS]))
      const created = queryOne('SELECT last_insert_rowid() as id')?.id
      if (created) urlToId.set(app.job_url, created)
      bump(added, 'applications')
    }

    const attentionUrls = new Set(
      query('SELECT job_url FROM attention_jobs WHERE job_url IS NOT NULL').map(r => r.job_url))
    for (const job of data.attention_jobs || []) {
      if (!job?.job_url || attentionUrls.has(job.job_url)) { bump(skipped, 'attention_jobs'); continue }
      insertRow(run, 'attention_jobs', job, new Set(['id']))
      attentionUrls.add(job.job_url)
      bump(added, 'attention_jobs')
    }

    // ── Child rows, re-pointed at the ids they ended up with ──────
    for (const { table } of CHILDREN) {
      for (const row of data[table] || []) {
        const parentId = urlToId.get(row._job_url)
        // The parent was skipped as a duplicate, so its children are already
        // here under the existing row — importing them again would double every
        // status change and every stored reply.
        if (!parentId) { bump(skipped, table); continue }
        if (queryOne(`SELECT 1 FROM ${table} WHERE application_id = ? LIMIT 1`, [parentId])) {
          bump(skipped, table)
          continue
        }
        insertRow(run, table, { ...row, application_id: parentId }, new Set(['id']))
        bump(added, table)
      }
    }

    // ── Standalone tables ─────────────────────────────────────────
    for (const { table, key, unique } of STANDALONE) {
      const rows = data[table] || []
      if (rows.length === 0) continue
      const seen = key
        ? new Set(query(`SELECT ${key} FROM ${table}`).map(r => r[key]))
        : new Set(unique ? query(`SELECT ${unique.join(', ')} FROM ${table}`).map(r => unique.map(c => r[c]).join('')) : [])
      for (const row of rows) {
        const identity = key ? row[key] : (unique ? unique.map(c => row[c]).join('') : null)
        if (identity != null && seen.has(identity)) { bump(skipped, table); continue }
        insertRow(run, table, row, new Set(key ? [] : ['id']))
        if (identity != null) seen.add(identity)
        bump(added, table)
      }
    }
  })

  const total = Object.values(added).reduce((n, v) => n + v, 0)
  return { added, skipped, total }
}

module.exports = { build, merge, STANDALONE, CHILDREN }
