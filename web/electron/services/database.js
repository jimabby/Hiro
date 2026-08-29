const fs = require('fs')
const path = require('path')
const configService = require('./config')
const dbCrypto = require('./dbCrypto')
const { CONFIG_DIR } = configService
const { parseSalaryColumns } = require('./salaryParser')
const jobFingerprint = require('./jobFingerprint')
const dataExport = require('./dataExport')

const DB_PATH = path.join(CONFIG_DIR, 'autoapply.db')

let db = null
let SQL = null

async function init() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

  SQL = await require('sql.js')()

  if (fs.existsSync(DB_PATH)) {
    // readFile handles both states, so an encrypted profile and a plaintext one
    // load through the same path. A decryption failure is deliberately NOT
    // caught: falling through to `new SQL.Database()` would present an empty
    // database, which is indistinguishable from having lost every application
    // ever recorded. main.js turns this into a dialog that says what happened.
    const { data } = dbCrypto.readFile(DB_PATH)
    db = new SQL.Database(data)
  } else {
    db = new SQL.Database()
  }

  createTables()
  migrate()
  persist()
}

// Every write persists the WHOLE database file (sql.js has no incremental
// write), so a loop of single-row updates costs one full serialization per row.
// batch() suppresses those intermediate writes and flushes once at the end;
// callers that touch many rows (cloud sync, cascading deletes) must use it.
let persistDepth = 0

// Written via a temp file + rename. sql.js has no incremental write, so every
// persist replaces the entire database file — a crash or power loss partway
// through a bare writeFileSync left a truncated file that no longer opened,
// destroying all history. rename() is atomic on both NTFS and POSIX, so the
// old file survives intact until the new one is complete.
// rename() is atomic, but on its own it only guarantees ordering of the
// directory entry — not that the temp file's BYTES reached the platter first.
// After a power loss the rename can therefore land while the new file is still
// partly zeroes, which is the same corruption the temp file was meant to
// prevent. fsync the data before the rename, then fsync the directory so the
// rename itself is durable.
function fsyncFile(file, flags) {
  let fd = null
  try {
    fd = fs.openSync(file, flags)
    fs.fsyncSync(fd)
  } catch { /* best-effort: filesystems may refuse fsync on directories */ }
  finally { if (fd !== null) try { fs.closeSync(fd) } catch {} }
}

function persist() {
  if (!db || persistDepth > 0) return
  // Encryption rides on the existing atomic write rather than replacing it: the
  // bytes are encrypted, then written to a temp file, fsynced, and renamed
  // exactly as before. An encrypted database that could be truncated by a power
  // cut would be worse than a plaintext one, since GCM refuses a truncated file
  // outright.
  const data = dbCrypto.encodeForWrite(Buffer.from(db.export()), dbCrypto.shouldEncrypt())
  const tmp = DB_PATH + '.tmp'
  try {
    // 0600 whether or not encryption at rest is on. This file holds every job
    // description, tailored resume, cover letter and recruiter address; with
    // encryption off — the default — the umask alone decided who could read it.
    fs.writeFileSync(tmp, data, { mode: 0o600 })
    fsyncFile(tmp, 'r+')
    fs.renameSync(tmp, DB_PATH)
    try { fs.chmodSync(DB_PATH, 0o600) } catch { /* Windows ignores this */ }
    fsyncFile(CONFIG_DIR, 'r')
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort */ }
    throw err
  }
}

function batch(fn) {
  persistDepth++
  try {
    return fn()
  } finally {
    persistDepth--
    persist()
  }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title TEXT NOT NULL,
      company TEXT NOT NULL,
      platform TEXT NOT NULL,
      salary TEXT,
      job_url TEXT,
      job_description TEXT,
      match_score INTEGER,
      tailored_resume TEXT,
      screening_qa TEXT,
      status TEXT DEFAULT 'applied',
      applied_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      cloud_dirty INTEGER DEFAULT 1,
      cloud_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attention_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title TEXT NOT NULL,
      company TEXT NOT NULL,
      platform TEXT NOT NULL,
      salary TEXT,
      job_url TEXT,
      job_description TEXT,
      match_score INTEGER,
      talking_points TEXT,
      reason TEXT,
      dismissed INTEGER DEFAULT 0,
      found_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS follow_up_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL UNIQUE,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT DEFAULT 'held',
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS screening_cache (
      question_hash TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Roles the user has said are not worth re-drafting: a specific job title
    -- at a specific company that keeps being reposted under new URLs. Never
    -- populated automatically — see suppressRole().
    CREATE TABLE IF NOT EXISTS suppressed_roles (
      role_key TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      job_title TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interview_prep (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER,
      questions TEXT,
      saved_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      changed_at TEXT DEFAULT (datetime('now'))
    );

    -- Per-call AI usage, so the cost of a scan is visible instead of only
    -- showing up on the provider's monthly bill. One row per API call.
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      called_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS interview_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      has_time INTEGER DEFAULT 1,
      source TEXT DEFAULT 'manual',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Deletions the desktop has made but the cloud has not been told about yet.
    -- Cloud sync used to infer deletion from ABSENCE — any cloud row with no
    -- local counterpart was assumed deleted and removed. On a reinstalled or
    -- reset machine the local table is empty, so that inference deleted the
    -- user's entire cloud history. An explicit tombstone is the only safe
    -- signal: absence now means "this device hasn't seen it yet", which is a
    -- restore, not a delete.
    CREATE TABLE IF NOT EXISTS deleted_applications (
      local_id INTEGER PRIMARY KEY,
      deleted_at TEXT DEFAULT (datetime('now'))
    );

    -- Per-platform automation events, so a scraper that quietly stopped working
    -- can be told apart from a search that genuinely has no results. Bounded by
    -- pruning, not by retention rules: this is a diagnostic, not history.
    CREATE TABLE IF NOT EXISTS automation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      count INTEGER DEFAULT 0,
      at TEXT DEFAULT (datetime('now'))
    );

    -- Every time sync had to pick a winner, and what it discarded.
    --
    -- The desktop wins when both sides changed since the last sync, because it
    -- owns far more fields than the phone does. That is the right default and
    -- it stays — but it was silent, so a status set on the phone could vanish
    -- with no trace anywhere that it had ever existed. A conflict the user
    -- cannot see is indistinguishable from data loss.
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      job_title TEXT,
      company TEXT,
      field TEXT NOT NULL,
      local_value TEXT,
      remote_value TEXT,
      resolved_as TEXT NOT NULL,
      detected_at TEXT DEFAULT (datetime('now'))
    );

    -- What was actually sent, frozen at the moment it was sent.
    --
    -- The applications row is mutable: approving a held draft overwrites
    -- screening_qa, a re-tailor overwrites tailored_resume, and editing the
    -- master resume changes the base out from under every past application. So
    -- the row answers "what does this look like now", never "what did this
    -- employer receive". After a bad tailoring pass reaches an employer, that
    -- second question is the only one that matters, and it was unanswerable.
    --
    -- base_resume is stored in full rather than referenced: the whole point is
    -- that it survives the master resume being edited afterwards.
    CREATE TABLE IF NOT EXISTS application_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      taken_at TEXT DEFAULT (datetime('now')),
      base_resume TEXT,
      resume_name TEXT,
      tailored_resume TEXT,
      cover_letter TEXT,
      screening_qa TEXT,
      match_score INTEGER,
      status TEXT,
      -- Which model wrote this version. Without it, two snapshots of the same
      -- job are two blobs of text with no way to tell whether the difference
      -- came from a prompt change, a model change, or chance.
      provider TEXT,
      model TEXT
    );

    -- Notifications already sent, so a reminder that is recomputed on a
    -- two-minute sync loop arrives once rather than thirty times an hour.
    --
    -- The key is the EVENT ("the 24-hour reminder for interview 41"), not the
    -- send, and the row is written BEFORE the request goes out: claiming after a
    -- successful send would double-send whenever the response is lost, which is
    -- the common case on a laptop that just woke up. This has to survive a
    -- restart, so it is a table rather than a Set in memory.
    CREATE TABLE IF NOT EXISTS push_log (
      dedupe_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    -- Interviews mirrored into an external calendar, and what we last wrote
    -- there. Two-way sync needs three things this table holds and the
    -- interview_events row cannot: the provider's own id for the event, a hash
    -- of what we last pushed (so an unchanged event is not rewritten on every
    -- pass), and the direction of the last change (so an edit made in Google
    -- Calendar is not immediately overwritten by the local copy).
    CREATE TABLE IF NOT EXISTS calendar_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id INTEGER,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      -- Set when the event came FROM the calendar rather than from Hiro, so a
      -- deletion here does not delete an event the user created themselves.
      origin TEXT DEFAULT 'hiro',
      local_hash TEXT,
      remote_updated_at TEXT,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE (provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      email TEXT NOT NULL,
      company TEXT DEFAULT '',
      role TEXT DEFAULT '',
      relationship TEXT DEFAULT 'recruiter',
      notes TEXT DEFAULT '',
      next_action_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (email, company)
    );

    CREATE TABLE IF NOT EXISTS campaign_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      campaign_name TEXT DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT DEFAULT (datetime('now')),
      found INTEGER DEFAULT 0,
      applied INTEGER DEFAULT 0,
      held INTEGER DEFAULT 0,
      scoring_failures INTEGER DEFAULT 0,
      ok INTEGER DEFAULT 1,
      error TEXT DEFAULT ''
    );

    -- What a recruiter actually wrote back.
    --
    -- The inbox check already downloads the reply body to classify it, then
    -- threw it away. That body is the single most useful input to interview
    -- preparation there is — it names the interviewers, the format, the panel,
    -- the round — and regenerating questions from the job ad alone ignores
    -- everything the employer has since said.
    --
    -- Bodies are truncated on write: this is context for a prompt, not a mail
    -- archive, and an unbounded column would put whole quoted threads into a
    -- database that is rewritten in full on every save.
    CREATE TABLE IF NOT EXISTS recruiter_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      uid INTEGER,
      from_address TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      body TEXT DEFAULT '',
      classified_as TEXT DEFAULT '',
      received_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (application_id, uid)
    );

    -- Offers under consideration, and the things that decide between them.
    --
    -- Compensation is already normalised on the application row, but an offer
    -- is not a job ad: the number that matters is the one in the offer letter,
    -- not the one in the advert, and the deadline to accept is nowhere on the
    -- application at all.
    CREATE TABLE IF NOT EXISTS offers (
      application_id INTEGER PRIMARY KEY,
      base_salary INTEGER,
      bonus INTEGER,
      equity TEXT DEFAULT '',
      currency TEXT DEFAULT '',
      start_date TEXT,
      respond_by TEXT,
      location TEXT DEFAULT '',
      remote TEXT DEFAULT '',
      pros TEXT DEFAULT '',
      cons TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      -- 0–5, entirely the user's own judgement. Deliberately not derived from
      -- anything: the whole point is to hold the part no number captures.
      excitement INTEGER,
      decision TEXT DEFAULT 'considering',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  persist()
}

function migrate() {
  // Add columns if they don't exist (for existing databases)
  try { db.run('ALTER TABLE applications ADD COLUMN cover_letter TEXT DEFAULT ""') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN comment TEXT DEFAULT ""') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN match_explanation TEXT DEFAULT ""') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN follow_up_sent INTEGER DEFAULT 0') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN recruiter_email TEXT DEFAULT ""') } catch {}
  // How many follow-ups have gone out, and when the last one did.
  //
  // follow_up_sent was a boolean, so every application got exactly one nudge
  // ever — which is not how anybody actually chases an application. These two
  // replace it: the count decides which letter to write (see ai/prompts.js) and
  // whether there are any left, the timestamp spaces them out. The old column
  // stays as the seed, so an application already followed up once is at one and
  // does not get a duplicate first nudge on upgrade.
  try {
    db.run('ALTER TABLE applications ADD COLUMN follow_up_count INTEGER DEFAULT 0')
    db.run('UPDATE applications SET follow_up_count = COALESCE(follow_up_sent, 0)')
  } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN last_follow_up_at TEXT') } catch {}
  // Set when the user rejects a drafted follow-up. That is a decision about the
  // whole sequence, not just this letter — redrafting the next stage at someone
  // who has just declined to chase this employer is exactly the nagging the
  // stages are supposed to make deliberate.
  try { db.run('ALTER TABLE applications ADD COLUMN follow_up_stopped INTEGER DEFAULT 0') } catch {}
  // A fingerprint of the advert's text, so the same listing reposted under a new
  // URL and a tweaked title is recognised BEFORE it is scored and tailored
  // again. See jobFingerprint.js for why it is exact rather than fuzzy.
  //
  // Backfilled below rather than left null, because the whole value is in
  // recognising ads already in the history — a hash that only starts from today
  // catches nothing until the second repost.
  let addedApplicationHash = false
  let addedAttentionHash = false
  try {
    db.run('ALTER TABLE applications ADD COLUMN description_hash TEXT')
    addedApplicationHash = true
  } catch {}
  try {
    db.run('ALTER TABLE attention_jobs ADD COLUMN description_hash TEXT')
    addedAttentionHash = true
  } catch {}
  if (addedApplicationHash) backfillFingerprints('applications')
  if (addedAttentionHash) backfillFingerprints('attention_jobs')
  try { db.run('CREATE INDEX IF NOT EXISTS idx_applications_desc_hash ON applications(description_hash)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_desc_hash ON attention_jobs(description_hash)') } catch {}
  // Set when a suppression was made from a listing that had a description, so
  // "this role keeps being reposted" also catches the repost that renames it.
  try { db.run('ALTER TABLE suppressed_roles ADD COLUMN description_hash TEXT') } catch {}
  // Cloud sync tracking: cloud_dirty marks rows with local changes not yet
  // pushed (defaults 1 so existing rows push once); cloud_updated_at remembers
  // the remote updated_at we last saw, so pulls detect phone edits by equality
  // instead of comparing two devices' clocks.
  try { db.run('ALTER TABLE applications ADD COLUMN cloud_dirty INTEGER DEFAULT 1') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN cloud_updated_at TEXT') } catch {}
  // Application deadline parsed out of the job ad, so Needs Attention can sort
  // by what actually expires soonest instead of by when it was found.
  try { db.run('ALTER TABLE applications ADD COLUMN closing_date TEXT') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN closing_date TEXT') } catch {}
  // IMAP uid of the last recruiter reply we classified for this application.
  // The inbox check now revisits non-terminal statuses (not just 'applied'), so
  // without this it would re-download and re-classify the same email on every
  // pass — burning an AI call each time for no new information.
  try { db.run('ALTER TABLE applications ADD COLUMN last_reply_uid INTEGER') } catch {}
  // Salary parsed out of the ad's free-text salary string, so it can be
  // filtered, sorted, and averaged. NULL means "couldn't parse" (or not listed).
  try { db.run('ALTER TABLE applications ADD COLUMN salary_min INTEGER') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN salary_max INTEGER') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN salary_min INTEGER') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN salary_max INTEGER') } catch {}

  // Which resume was actually sent. Routing rules mean different jobs go out
  // with different resumes, and without recording the choice there's no way to
  // tell afterwards which one converts — the routing rules were untestable.
  try { db.run('ALTER TABLE applications ADD COLUMN resume_id TEXT') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN resume_name TEXT') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN campaign_id TEXT') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN campaign_name TEXT') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN campaign_id TEXT') } catch {}
  try { db.run('ALTER TABLE attention_jobs ADD COLUMN campaign_name TEXT') } catch {}
  // Review mode ('held' status) parks a job instead of submitting it. These
  // carry the drafted documents forward so approving it doesn't re-run the AI.
  try { db.run('ALTER TABLE applications ADD COLUMN held_at TEXT') } catch {}
  // Single quotes: double quotes are SQLite's IDENTIFIER syntax, and this only
  // stored "[]" as a string because of the legacy double-quoted-string fallback
  // that resolves an unknown identifier to a literal.
  try { db.run("ALTER TABLE applications ADD COLUMN fabrication_flags TEXT DEFAULT '[]'") } catch {}

  // Who wrote a cached screening answer.
  //
  // The cache is keyed on the QUESTION alone, so an answer written for one
  // employer is replayed verbatim to every employer that asks something similar
  // afterwards. That is the point of it — and it is also why a bad answer in
  // here does not stay contained. An answer the model produced from an untrusted
  // job ad has to stay re-checkable; one the user typed themselves is a
  // statement of fact by the only person entitled to make it, and must never be
  // second-guessed by a regex.
  //
  // Existing rows default to 'ai' — the cautious reading, since answers cached
  // before this column existed cannot be attributed and the AI path was the
  // common one. The cost of being wrong is that a user's own old answer is
  // re-verified once and, if it trips the guard, asked about again.
  try { db.run("ALTER TABLE screening_cache ADD COLUMN source TEXT DEFAULT 'ai'") } catch {}

  // The timezone the employer actually wrote, and the wall-clock time they
  // wrote in it.
  //
  // `scheduled_at` is, and stays, this machine's local time — everything that
  // reads it (the dashboard, the reminders, calendar sync, the .ics export)
  // depends on that. But a recruiter writing "2:00 PM AEDT" to someone in London
  // has said something the stored value cannot express, and until now the zone
  // was simply dropped: the time was recorded as 2pm London and the interview
  // was missed by nine hours.
  //
  // Keeping the original alongside the converted value means the UI can show
  // both — "2:00 PM AEDT · 3:00 AM your time" — which is the only presentation
  // that lets a user check the conversion rather than trust it. NULL means the
  // email named no zone, which is the common case and correctly implies "their
  // clock and yours are assumed to be the same".
  try { db.run('ALTER TABLE interview_events ADD COLUMN source_zone TEXT') } catch {}
  try { db.run('ALTER TABLE interview_events ADD COLUMN source_local TEXT') } catch {}

  // Indexes for frequent queries
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_applied_at ON applications(applied_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_job_url ON applications(job_url)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_url ON attention_jobs(job_url)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(called_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_platform ON applications(platform)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_company ON applications(company)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_campaign ON applications(campaign_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_campaign ON attention_jobs(campaign_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_campaign_runs_id ON campaign_runs(campaign_id, started_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_attention_dismissed ON attention_jobs(dismissed)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_history_app ON status_history(application_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_snapshots_app ON application_snapshots(application_id, taken_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_conflicts_at ON sync_conflicts(detected_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_automation_platform ON automation_events(platform, at DESC)') } catch {}
  try { db.run('ALTER TABLE application_snapshots ADD COLUMN provider TEXT') } catch {}
  try { db.run('ALTER TABLE application_snapshots ADD COLUMN model TEXT') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_interview_app ON interview_events(application_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_interview_at ON interview_events(scheduled_at)') } catch {}

  // ─── Pipeline ────────────────────────────────────────────────
  // The next thing the user has to DO about an application, and when. Status
  // says where the application got to; this says what is owed and by when, which
  // is the difference between a list of past events and a working pipeline.
  // Stored as local "YYYY-MM-DD" (a follow-up is a day, not an instant).
  try { db.run('ALTER TABLE applications ADD COLUMN next_action_at TEXT') } catch {}
  try { db.run('ALTER TABLE applications ADD COLUMN next_action_note TEXT DEFAULT ""') } catch {}
  // Set when a next action is completed, so a cleared reminder is not silently
  // indistinguishable from one that was never set.
  try { db.run('ALTER TABLE applications ADD COLUMN next_action_done_at TEXT') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_apps_next_action ON applications(next_action_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_push_log_at ON push_log(sent_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_calendar_interview ON calendar_links(interview_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_replies_app ON recruiter_replies(application_id, received_at DESC)') } catch {}
  // Rejection analysis walks the whole history looking for the stage each
  // application died at, so it reads status_history ordered by time per row.
  try { db.run('CREATE INDEX IF NOT EXISTS idx_history_app_at ON status_history(application_id, changed_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_offers_decision ON offers(decision)') } catch {}
}

// Convert sql.js result to array of objects
function toRows(result) {
  if (!result || result.length === 0) return []
  const { columns, values } = result[0]
  return values.map(row => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
}

function run(sql, params = []) {
  db.run(sql, params)
  persist()
}

function query(sql, params = []) {
  return toRows(db.exec(sql, params))
}

function queryOne(sql, params = []) {
  const rows = query(sql, params)
  return rows[0] || null
}

// ─── Applications ────────────────────────────────────────────────

// Columns that hold whole documents. A list view never renders them, but
// SELECT * shipped every one of them across the IPC boundary on every dashboard
// load — tens of MB once history builds up. getApplications keeps the full row
// for callers that genuinely need it (CSV export, cloud push); the UI uses
// getApplicationsList, which omits them and fetches detail on selection.
const LIST_COLUMNS = `id, job_title, company, platform, salary, salary_min, salary_max, job_url,
  match_score, match_explanation, status, comment, recruiter_email, applied_at, updated_at,
  closing_date, follow_up_sent, resume_id, resume_name, campaign_id, campaign_name,
  next_action_at, next_action_note`

function getApplications(filters = {}) {
  return runApplicationQuery('*', filters)
}

// Same filters and sorting, minus the document columns.
function getApplicationsList(filters = {}) {
  return runApplicationQuery(LIST_COLUMNS, filters)
}

function runApplicationQuery(columns, filters = {}) {
  let sql = `SELECT ${columns} FROM applications`
  const params = []
  const conditions = []

  if (filters.status) { conditions.push('status = ?'); params.push(filters.status) }
  if (filters.platform) { conditions.push('platform = ?'); params.push(filters.platform) }
  if (filters.dateFrom) { conditions.push('applied_at >= ?'); params.push(filters.dateFrom) }
  if (filters.dateTo) {
    // applied_at is 'YYYY-MM-DD HH:MM:SS'; a date-only upper bound would
    // lexicographically exclude every row on that final day.
    const to = /^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo) ? filters.dateTo + ' 23:59:59' : filters.dateTo
    conditions.push('applied_at <= ?'); params.push(to)
  }
  // Salary bounds work on the normalised annual columns. A row whose salary
  // couldn't be parsed has NULL on both and is excluded from a salary filter —
  // treating unknown as 0 would hide every unlisted-salary job behind a filter
  // the user didn't intend to be that aggressive.
  if (filters.salaryFrom != null && filters.salaryFrom !== '') {
    conditions.push('COALESCE(salary_max, salary_min) >= ?'); params.push(Number(filters.salaryFrom))
  }
  if (filters.salaryTo != null && filters.salaryTo !== '') {
    conditions.push('COALESCE(salary_min, salary_max) <= ?'); params.push(Number(filters.salaryTo))
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')

  // Sorting is whitelisted, never interpolated from caller input.
  const SORTS = {
    applied_at: 'applied_at DESC',
    match_score: 'match_score DESC, applied_at DESC',
    salary: 'COALESCE(salary_max, salary_min) DESC, applied_at DESC',
    company: 'company COLLATE NOCASE ASC, applied_at DESC',
    closing_date: "CASE WHEN closing_date IS NULL OR closing_date = '' THEN 1 ELSE 0 END, closing_date ASC, applied_at DESC",
  }
  sql += ' ORDER BY ' + (SORTS[filters.sort] || SORTS.applied_at)
  return query(sql, params)
}

function getApplication(id) {
  return queryOne('SELECT * FROM applications WHERE id = ?', [id])
}

function hasJobUrl(jobUrl) {
  return !!queryOne('SELECT 1 FROM applications WHERE job_url = ? LIMIT 1', [jobUrl])
}

// A job whose apply attempt failed lands in attention_jobs WITHOUT an
// applications row, so hasJobUrl alone didn't recognise it on the next scan:
// every run re-fetched the description, re-scored, re-tailored and re-submitted
// it, then inserted ANOTHER Needs Attention row for the same listing. Dismissed
// rows are deliberately still counted — the user has already ruled on that job
// and doesn't want it resurrected.
function hasAttentionJobUrl(jobUrl) {
  if (!jobUrl) return false
  return !!queryOne('SELECT 1 FROM attention_jobs WHERE job_url = ? LIMIT 1', [jobUrl])
}

// Either table has seen this listing before.
function hasSeenJobUrl(jobUrl) {
  return hasJobUrl(jobUrl) || hasAttentionJobUrl(jobUrl)
}

// One-off: hash the descriptions already on disk when the column is added.
//
// Done in a batch so the whole table costs one database write rather than one
// per row — sql.js re-serialises the entire file on every write, and a long
// history would otherwise turn a schema migration into a minutes-long stall at
// startup.
function backfillFingerprints(table) {
  try {
    const rows = query(`SELECT id, company, job_description FROM ${table}
                        WHERE description_hash IS NULL AND job_description IS NOT NULL
                          AND length(job_description) > 0`)
    if (rows.length === 0) return
    batch(() => {
      for (const row of rows) {
        const hash = jobFingerprint.fingerprint(row.company, row.job_description)
        if (hash) run(`UPDATE ${table} SET description_hash = ? WHERE id = ?`, [hash, row.id])
      }
    })
  } catch { /* a failed backfill costs recognition of old reposts, not correctness */ }
}

// Has this exact advert been seen before, under any URL?
//
// Returns the earlier row so the caller can say WHICH listing this repeats —
// "already seen as 'Data Engineer' on 3 March" is actionable in a way that
// "duplicate" is not. Checks both tables for the same reason hasSeenJobUrl does:
// a job whose apply failed sits in attention_jobs with no applications row.
function findJobByContent(company, description) {
  const hash = jobFingerprint.fingerprint(company, description)
  if (!hash) return null
  const applied = queryOne(
    `SELECT id, job_title, company, job_url, status, applied_at AS seen_at, 'application' AS source
     FROM applications WHERE description_hash = ? ORDER BY id DESC LIMIT 1`, [hash])
  if (applied) return applied
  return queryOne(
    `SELECT id, job_title, company, job_url, NULL AS status, found_at AS seen_at, 'attention' AS source
     FROM attention_jobs WHERE description_hash = ? ORDER BY id DESC LIMIT 1`, [hash])
}

// A suppressed role, matched on the advert's text rather than on its title.
// This is what catches the repost that renames itself — the case the exact
// company+title key cannot see by construction.
function isContentSuppressed(company, description) {
  const hash = jobFingerprint.fingerprint(company, description)
  if (!hash) return null
  return queryOne('SELECT company, job_title, reason FROM suppressed_roles WHERE description_hash = ? LIMIT 1', [hash])
}

// Has this company been applied to *recently*? Previously this matched any
// non-skipped row ever, so a single application permanently blacklisted the
// employer — every later role there was silently skipped. The window is
// configurable (companyCooldownDays; 0 disables) and defaults to 30 days,
// which keeps the anti-spam intent without burning a company forever.
// Per-listing and cross-platform duplicates are caught separately by
// hasJobUrl() and findDuplicateAcrossPlatforms().
function findRecentApplicationToCompany(company, cooldownDays) {
  const days = Number(cooldownDays)
  if (!Number.isFinite(days) || days <= 0) return null
  return queryOne(
    `SELECT job_title, applied_at FROM applications
     WHERE LOWER(company) = LOWER(?) AND ${SENT_ONLY}
       AND applied_at >= datetime('now', '-' || ? || ' days')
     ORDER BY applied_at DESC LIMIT 1`,
    [company, days]
  )
}

function insertApplication(data) {
  // Salary is stored both as scraped (for display) and normalised to annual
  // numbers (for filtering and averaging). Callers may pass the parsed values
  // through; anything unparsed falls back to deriving them here so no insert
  // path can silently skip it.
  const parsed = data.salary_min == null && data.salary_max == null
    ? parseSalaryColumns(data.salary || '')
    : { salary_min: data.salary_min ?? null, salary_max: data.salary_max ?? null }

  const status = data.status || 'applied'
  db.run(`
    INSERT INTO applications
      (job_title, company, platform, salary, job_url, job_description, match_score, match_explanation, tailored_resume, cover_letter, screening_qa, status, closing_date, salary_min, salary_max, resume_id, resume_name, recruiter_email, held_at, fabrication_flags, campaign_id, campaign_name, description_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title, data.company, data.platform, data.salary || '',
    data.job_url, data.job_description, data.match_score,
    data.match_explanation || '',
    data.tailored_resume, data.cover_letter || '',
    JSON.stringify(data.screening_qa || []),
    status,
    data.closing_date || null,
    parsed.salary_min, parsed.salary_max,
    data.resume_id || null, data.resume_name || null,
    data.recruiter_email || '',
    status === 'held' ? new Date().toISOString() : null,
    JSON.stringify(data.fabrication_flags || []),
    data.campaign_id || null, data.campaign_name || null,
    // Recorded on the way in, so the next repost of this advert is recognised
    // before it costs anything. Null when the ad is too short to fingerprint.
    jobFingerprint.fingerprint(data.company, data.job_description),
  ])
  // Read the new row id BEFORE persist(): db.export() resets last_insert_rowid.
  const newId = queryOne('SELECT last_insert_rowid() as id')?.id
  if (newId) db.run('INSERT INTO status_history (application_id, status) VALUES (?, ?)', [newId, status])
  // Freeze what was drafted. Only when something was actually generated —
  // rows created for skipped or unscored jobs carry no documents and a
  // snapshot of two empty strings is noise in the trail.
  if (newId && (data.tailored_resume || data.cover_letter)) {
    recordSnapshot(newId, status === 'held' ? 'drafted' : 'submitted', {
      base_resume: data.base_resume || '',
      resume_name: data.resume_name,
      tailored_resume: data.tailored_resume,
      cover_letter: data.cover_letter,
      screening_qa: data.screening_qa,
      match_score: data.match_score,
      status,
      provider: data.provider,
      model: data.model,
    })
  }
  persist()
  return { success: true, id: newId }
}

// ─── Review mode (held applications) ─────────────────────────────
// When review mode is on, a job that clears the match threshold is drafted in
// full (resume tailored, cover letter written) and parked as 'held' instead of
// being submitted. Nothing is sent until the user approves it, so a bad
// tailoring pass can't reach ten employers before anyone notices.

function getHeldApplications() {
  return query(`SELECT ${LIST_COLUMNS}, held_at FROM applications WHERE status = 'held' ORDER BY match_score DESC, held_at ASC`)
}

// Mark an approved-and-submitted held job as applied. Its documents are already
// on the row, so approving costs no AI calls.
function markHeldApplied(id, screeningQa) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(`UPDATE applications
       SET status = 'applied', applied_at = datetime('now'), held_at = NULL,
           screening_qa = ?, updated_at = datetime('now'), cloud_dirty = 1
       WHERE id = ?`, [JSON.stringify(screeningQa || []), id])
  if (current && current.status !== 'applied') recordStatusChange(id, 'applied')
  // The submission snapshot is the one that matters: it is the only record of
  // the screening answers, which are written during the submit itself and
  // overwrite whatever the held row carried.
  const row = queryOne('SELECT * FROM applications WHERE id = ?', [id])
  if (row) {
    recordSnapshot(id, 'submitted', {
      base_resume: '',
      resume_name: row.resume_name,
      tailored_resume: row.tailored_resume,
      cover_letter: row.cover_letter,
      screening_qa: screeningQa || [],
      match_score: row.match_score,
      status: 'applied',
    })
  }
  return { success: true }
}

// The user declined a held draft. It stays in history as 'skipped' so the same
// listing isn't re-scored and re-drafted on the next scan.
function rejectHeldApplication(id) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(`UPDATE applications SET status = 'skipped', held_at = NULL,
       updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?`, [id])
  if (current && current.status !== 'skipped') recordStatusChange(id, 'skipped')
  return { success: true }
}

// ─── Automation health events ────────────────────────────────────

function recordAutomationEvent({ platform, kind, detail, count }) {
  if (!platform || !kind) return { success: false }
  run('INSERT INTO automation_events (platform, kind, detail, count) VALUES (?, ?, ?, ?)',
    [platform, kind, detail == null ? null : String(detail).slice(0, 500), Number(count) || 0])
  // Keep the log to a working window per platform. Unbounded growth would make
  // a diagnostic table the biggest thing in the database.
  run(`DELETE FROM automation_events
       WHERE platform = ?
         AND id NOT IN (SELECT id FROM automation_events WHERE platform = ? ORDER BY id DESC LIMIT 200)`,
    [platform, platform])
  return { success: true }
}

function getAutomationEvents(platform, limit = 40) {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 40
  return query(`SELECT * FROM automation_events WHERE platform = ? ORDER BY id DESC LIMIT ${n}`, [platform])
}

function clearAutomationEvents() {
  run('DELETE FROM automation_events')
  return { success: true }
}

// ─── Sync conflict log ───────────────────────────────────────────
// Append-only, same reasoning as the audit trail: the value of a record of what
// was overwritten is that it cannot itself be overwritten.

function recordSyncConflict({ applicationId, field, localValue, remoteValue, resolvedAs }) {
  if (!applicationId || !field) return { success: false }
  const row = queryOne('SELECT job_title, company FROM applications WHERE id = ?', [applicationId])
  run(`
    INSERT INTO sync_conflicts
      (application_id, job_title, company, field, local_value, remote_value, resolved_as)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    applicationId, row?.job_title || null, row?.company || null, field,
    localValue == null ? null : String(localValue),
    remoteValue == null ? null : String(remoteValue),
    resolvedAs,
  ])
  return { success: true }
}

function getSyncConflicts(limit = 100) {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100
  return query(`SELECT * FROM sync_conflicts ORDER BY detected_at DESC, id DESC LIMIT ${n}`)
}

function countSyncConflicts() {
  return queryOne('SELECT COUNT(*) as c FROM sync_conflicts')?.c || 0
}

function clearSyncConflicts() {
  run('DELETE FROM sync_conflicts')
  return { success: true }
}

// Take the discarded side after the fact. The remote value is kept in the log
// precisely so a wrong automatic resolution is recoverable.
function applyConflictResolution(id) {
  const conflict = queryOne('SELECT * FROM sync_conflicts WHERE id = ?', [id])
  if (!conflict) return { success: false, reason: 'Conflict not found' }
  if (conflict.field !== 'status' && conflict.field !== 'comment') {
    return { success: false, reason: `Cannot re-apply the "${conflict.field}" field` }
  }
  const exists = queryOne('SELECT id FROM applications WHERE id = ?', [conflict.application_id])
  if (!exists) return { success: false, reason: 'That application no longer exists' }

  run(`UPDATE applications SET ${conflict.field} = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?`,
    [conflict.remote_value, conflict.application_id])
  if (conflict.field === 'status') recordStatusChange(conflict.application_id, conflict.remote_value)
  run('UPDATE sync_conflicts SET resolved_as = ? WHERE id = ?', ['remote-applied', id])
  return { success: true }
}

// ─── Audit / version history ─────────────────────────────────────
// Snapshots are append-only. Nothing in here is ever updated in place —
// a record that can be rewritten after the fact is not an audit trail.

function recordSnapshot(applicationId, reason, data = {}) {
  if (!applicationId || !reason) return { success: false, reason: 'applicationId and reason are required' }
  run(`
    INSERT INTO application_snapshots
      (application_id, reason, base_resume, resume_name, tailored_resume, cover_letter, screening_qa, match_score, status, provider, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    applicationId, reason,
    data.base_resume || '', data.resume_name || null,
    data.tailored_resume || '', data.cover_letter || '',
    JSON.stringify(data.screening_qa || []),
    data.match_score ?? null, data.status || null,
    data.provider || null, data.model || null,
  ])
  return { success: true, id: queryOne('SELECT last_insert_rowid() as id')?.id }
}

// Slim list for the history trail. The documents are deliberately left out —
// a row with three full resumes on it makes the panel crawl.
function getSnapshots(applicationId) {
  return query(`
    SELECT id, application_id, reason, taken_at, match_score, status, provider, model,
           LENGTH(tailored_resume) as tailored_length,
           LENGTH(cover_letter) as cover_letter_length
    FROM application_snapshots
    WHERE application_id = ?
    ORDER BY taken_at DESC, id DESC
  `, [applicationId])
}

function getSnapshot(id) {
  const row = queryOne('SELECT * FROM application_snapshots WHERE id = ?', [id])
  if (!row) return null
  let screeningQa = []
  try { screeningQa = JSON.parse(row.screening_qa || '[]') } catch { screeningQa = [] }
  return { ...row, screening_qa: screeningQa }
}

// What the tailoring pass changed, for one snapshot.
function getSnapshotDiff(id) {
  const snap = getSnapshot(id)
  if (!snap) return null
  const { diffLines, diffSummary } = require('./textDiff')
  const diff = diffLines(snap.base_resume || '', snap.tailored_resume || '')
  return { id: snap.id, taken_at: snap.taken_at, reason: snap.reason, diff, summary: diffSummary(diff) }
}

// Compare two saved versions of the same application.
//
// The base-vs-tailored diff answers "what did the model change about me".
// This answers the other question — "is the new model actually better?" —
// which needs two generated outputs side by side, not one against the source.
function compareSnapshots(idA, idB, field = 'tailored_resume') {
  if (field !== 'tailored_resume' && field !== 'cover_letter') {
    return { error: `Cannot compare the "${field}" field` }
  }
  const a = getSnapshot(idA)
  const b = getSnapshot(idB)
  if (!a || !b) return { error: 'Snapshot not found' }
  if (a.application_id !== b.application_id) {
    // Diffing two different jobs' documents produces a wall of changes that
    // means nothing. Refuse rather than render nonsense.
    return { error: 'Those versions belong to different applications' }
  }
  const { diffLines, diffSummary } = require('./textDiff')
  const diff = diffLines(a[field] || '', b[field] || '')
  return {
    field,
    from: { id: a.id, reason: a.reason, taken_at: a.taken_at, provider: a.provider, model: a.model },
    to: { id: b.id, reason: b.reason, taken_at: b.taken_at, provider: b.provider, model: b.model },
    diff,
    summary: diffSummary(diff),
  }
}

// Undo: put a previous version's documents back on the live row.
//
// Takes its own snapshot of the current state first, so restoring is itself
// reversible — otherwise "undo" is a one-way door that can destroy the very
// version someone was trying to compare against.
function restoreSnapshot(id) {
  const snap = getSnapshot(id)
  if (!snap) return { success: false, reason: 'Snapshot not found' }
  const current = queryOne('SELECT * FROM applications WHERE id = ?', [snap.application_id])
  if (!current) return { success: false, reason: 'This application no longer exists' }

  recordSnapshot(snap.application_id, 'before-restore', {
    base_resume: '',
    resume_name: current.resume_name,
    tailored_resume: current.tailored_resume,
    cover_letter: current.cover_letter,
    screening_qa: safeParseQa(current.screening_qa),
    match_score: current.match_score,
    status: current.status,
  })

  run(`UPDATE applications
       SET tailored_resume = ?, cover_letter = ?, updated_at = datetime('now'), cloud_dirty = 1
       WHERE id = ?`, [snap.tailored_resume || '', snap.cover_letter || '', snap.application_id])
  return { success: true, applicationId: snap.application_id }
}

function safeParseQa(raw) {
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

// Append to the per-application status timeline (only on real changes).
function recordStatusChange(id, status) {
  run('INSERT INTO status_history (application_id, status) VALUES (?, ?)', [id, status])
}

function getStatusHistory(applicationId) {
  return query('SELECT status, changed_at FROM status_history WHERE application_id = ? ORDER BY changed_at ASC, id ASC', [applicationId])
}

function updateApplicationStatus(id, status) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run("UPDATE applications SET status = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?", [status, id])
  if (current && current.status !== status) recordStatusChange(id, status)
  return { success: true }
}

function updateApplicationAfterApply(id, tailoredResume, coverLetter, screeningQa) {
  const current = queryOne('SELECT status FROM applications WHERE id = ?', [id])
  run(
    "UPDATE applications SET status = 'applied', tailored_resume = ?, cover_letter = ?, screening_qa = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?",
    [tailoredResume, coverLetter, JSON.stringify(screeningQa || []), id]
  )
  if (current && current.status !== 'applied') recordStatusChange(id, 'applied')
}

function updateApplicationComment(id, comment) {
  run("UPDATE applications SET comment = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?", [comment, id])
  return { success: true }
}

function updateRecruiterEmail(id, email) {
  run("UPDATE applications SET recruiter_email = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?", [email, id])
  const app = getApplication(id)
  if (email && app) saveContact({ email, company: app.company, role: `Recruiting contact for ${app.job_title}`, relationship: 'recruiter' })
  return { success: true }
}

// Deleting an application must take its dependent rows with it. interview_prep
// in particular was never cleaned up — the rows accumulated forever, inflated
// the count in Settings → Data, and had no way to be removed.
function deleteApplication(id) {
  batch(() => {
    // Tombstone first: if the process dies mid-delete, an extra tombstone for a
    // row that still exists is harmless (sync skips tombstones whose row is
    // present), whereas a missing tombstone silently resurrects the row.
    run('INSERT OR REPLACE INTO deleted_applications (local_id) VALUES (?)', [id])
    run('DELETE FROM applications WHERE id = ?', [id])
    run('DELETE FROM status_history WHERE application_id = ?', [id])
    run('DELETE FROM interview_prep WHERE application_id = ?', [id])
    run('DELETE FROM interview_events WHERE application_id = ?', [id])
    run('DELETE FROM recruiter_replies WHERE application_id = ?', [id])
    run('DELETE FROM offers WHERE application_id = ?', [id])
  })
  return { success: true }
}

function clearAllApplications() {
  batch(() => {
    run('INSERT OR REPLACE INTO deleted_applications (local_id) SELECT id FROM applications')
    run('DELETE FROM applications')
    run('DELETE FROM status_history')
    run('DELETE FROM interview_prep')
    run('DELETE FROM interview_events')
    run('DELETE FROM application_snapshots')
    run('DELETE FROM sync_conflicts')
    run('DELETE FROM recruiter_replies')
    run('DELETE FROM offers')
  })
  return { success: true }
}

// One-off sweep for rows orphaned by earlier versions, which deleted the
// application without its dependents. Runs on launch; cheap and idempotent.
function pruneOrphanedRows() {
  try {
    return batch(() => {
      const before = queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0
      run('DELETE FROM interview_prep WHERE application_id NOT IN (SELECT id FROM applications)')
      run('DELETE FROM status_history WHERE application_id NOT IN (SELECT id FROM applications)')
      run('DELETE FROM interview_events WHERE application_id NOT IN (SELECT id FROM applications)')
      // Reply bodies are the most sensitive rows in the database — someone
      // else's words about the user. An orphan is not just clutter here.
      run('DELETE FROM recruiter_replies WHERE application_id NOT IN (SELECT id FROM applications)')
      run('DELETE FROM offers WHERE application_id NOT IN (SELECT id FROM applications)')
      const after = queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0
      return { removedInterviewPreps: before - after }
    })
  } catch {
    return { removedInterviewPreps: 0 }
  }
}

// One-off backfill of the normalised salary columns for rows inserted before
// they existed. Runs on launch; idempotent, and skips rows already backfilled
// so it costs one query once the sweep has happened.
function backfillSalaryColumns() {
  try {
    const rows = query(`
      SELECT id, salary FROM applications
      WHERE salary_min IS NULL AND salary_max IS NULL AND salary IS NOT NULL AND salary != ''
    `)
    const attention = query(`
      SELECT id, salary FROM attention_jobs
      WHERE salary_min IS NULL AND salary_max IS NULL AND salary IS NOT NULL AND salary != ''
    `)
    if (rows.length === 0 && attention.length === 0) return { updated: 0 }

    let updated = 0
    batch(() => {
      for (const r of rows) {
        const { salary_min, salary_max } = parseSalaryColumns(r.salary)
        if (salary_min == null && salary_max == null) continue
        run('UPDATE applications SET salary_min = ?, salary_max = ? WHERE id = ?', [salary_min, salary_max, r.id])
        updated++
      }
      for (const r of attention) {
        const { salary_min, salary_max } = parseSalaryColumns(r.salary)
        if (salary_min == null && salary_max == null) continue
        run('UPDATE attention_jobs SET salary_min = ?, salary_max = ? WHERE id = ?', [salary_min, salary_max, r.id])
        updated++
      }
    })
    return { updated }
  } catch {
    return { updated: 0 }
  }
}

// Salary distribution across everything actually submitted, for the Analytics
// page. Rows whose salary couldn't be parsed are reported separately rather
// than folded in as zeros.
function getSalaryStats() {
  const rows = query(`
    SELECT salary_min, salary_max, match_score, status FROM applications
    WHERE ${SENT_ONLY}
  `)
  // Midpoint of the advertised range is the fairest single number to average;
  // a one-sided range contributes the side it states.
  const midpoints = []
  let unparsed = 0
  for (const r of rows) {
    if (r.salary_min == null && r.salary_max == null) { unparsed++; continue }
    if (r.salary_min != null && r.salary_max != null) midpoints.push((r.salary_min + r.salary_max) / 2)
    else midpoints.push(r.salary_min ?? r.salary_max)
  }
  if (midpoints.length === 0) return { count: 0, unparsed, min: null, max: null, median: null, average: null }
  midpoints.sort((a, b) => a - b)
  const mid = Math.floor(midpoints.length / 2)
  return {
    count: midpoints.length,
    unparsed,
    min: Math.round(midpoints[0]),
    max: Math.round(midpoints[midpoints.length - 1]),
    median: Math.round(midpoints.length % 2 ? midpoints[mid] : (midpoints[mid - 1] + midpoints[mid]) / 2),
    average: Math.round(midpoints.reduce((a, b) => a + b, 0) / midpoints.length),
  }
}

// ─── Ghost jobs ──────────────────────────────────────────────────
//
// A listing that keeps coming back is usually not a vacancy. Employers repost
// to keep a pipeline warm, to satisfy a policy that a role be advertised, or
// because an agency is farming CVs for a role that was filled months ago. From
// inside a single scan these are indistinguishable from a fresh opening, which
// is why they are so expensive: each repost is a new job_url, so the
// duplicate-skip cannot catch it, and every reappearance costs another score, a
// tailored résumé and a cover letter.
//
// The evidence only exists across time, and this database has been keeping it
// all along — every scan already records the title, the company and when it was
// seen. Titles and companies are compared case-insensitively and the URL must
// differ, so this counts genuine repostings rather than one listing seen twice.
//
// Deliberately reported rather than acted on. "Probably a ghost" is a judgement
// about an employer, and silently blacklisting on it would hide real jobs.
const GHOST_MIN_POSTINGS = 3
const GHOST_MIN_SPAN_DAYS = 45

function getGhostJobs({ minPostings = GHOST_MIN_POSTINGS, minSpanDays = GHOST_MIN_SPAN_DAYS } = {}) {
  // Both tables: a repost that was never applied to sits in attention_jobs, and
  // ignoring those would miss precisely the roles automation could not submit.
  const rows = query(`
    SELECT LOWER(TRIM(job_title)) as t, LOWER(TRIM(company)) as c,
           job_title, company, job_url, applied_at as seen_at, salary
    FROM applications
    WHERE job_title <> '' AND company <> ''
    UNION ALL
    SELECT LOWER(TRIM(job_title)) as t, LOWER(TRIM(company)) as c,
           job_title, company, job_url, found_at as seen_at, salary
    FROM attention_jobs
    WHERE job_title <> '' AND company <> ''
  `)

  const groups = new Map()
  for (const r of rows) {
    const key = `${r.t}\0${r.c}`
    if (!groups.has(key)) {
      groups.set(key, { jobTitle: r.job_title, company: r.company, urls: new Set(), seen: [], salary: r.salary || '' })
    }
    const g = groups.get(key)
    if (r.job_url) g.urls.add(r.job_url)
    if (r.seen_at) g.seen.push(r.seen_at)
  }

  const out = []
  for (const g of groups.values()) {
    // Distinct URLs is the repost count. The same URL seen twice is one posting
    // recorded twice, which says nothing about the employer.
    const postings = g.urls.size
    if (postings < minPostings || g.seen.length === 0) continue
    g.seen.sort()
    const first = g.seen[0]
    const last = g.seen[g.seen.length - 1]
    const spanDays = Math.round((new Date(last).getTime() - new Date(first).getTime()) / 86400000)
    if (!Number.isFinite(spanDays) || spanDays < minSpanDays) continue
    out.push({
      jobTitle: g.jobTitle,
      company: g.company,
      postings,
      firstSeen: first,
      lastSeen: last,
      spanDays,
      salary: g.salary,
      // Roughly how often it comes back. A monthly repost reads very differently
      // from three in a fortnight followed by silence.
      averageGapDays: postings > 1 ? Math.round(spanDays / (postings - 1)) : null,
    })
  }
  // Most-reposted first; ties broken by how long the employer has been at it.
  const suppressed = new Set(listSuppressedRoles().map(r => r.key))
  return out
    .map(g => ({ ...g, suppressed: suppressed.has(roleKey(g.company, g.jobTitle)) }))
    .sort((a, b) => b.postings - a.postings || b.spanDays - a.spanDays)
}

// ─── Suppressed roles ────────────────────────────────────────────
//
// The analysis above deliberately stops at reporting, and that stays right: a
// blanket "probably a ghost, blacklisted" would hide real jobs at a real
// employer on a heuristic about their posting habits.
//
// But the cost it names is still being paid. Every repost carries a new URL, so
// the duplicate check cannot see it, and each reappearance buys another score, a
// tailored resume and a cover letter for a role the user has already decided is
// not a vacancy. Reporting that and then doing it again next week is a strange
// place to stop.
//
// So: an explicit, per-ROLE, user-initiated suppression. Narrower than the
// company blacklist in the way that matters — "this specific role at this
// company keeps being reposted" says nothing about the company's other
// openings, and those keep being scanned and applied to as before. Reversible
// from the same screen, and it records WHY, so a list of them a year later is
// still legible.
// The separator is ASCII unit-separator, NOT a NUL.
//
// The in-memory grouping keys elsewhere in this file use \0 quite safely, and
// copying that here was wrong: this key goes through a bound SQL parameter, and
// SQLite treats an embedded NUL as the end of a text value. Every role at a
// given company therefore collapsed to the same stored key, so suppressing one
// role suppressed the whole employer — silently, and in the exact direction
// (hiding real jobs) that the feature is designed not to do.
const ROLE_KEY_SEP = '\u001f'

function roleKey(company, jobTitle) {
  return `${String(company || '').trim().toLowerCase()}${ROLE_KEY_SEP}${String(jobTitle || '').trim().toLowerCase()}`
}

function suppressRole({ company, jobTitle, reason = 'Repeatedly reposted' }) {
  const key = roleKey(company, jobTitle)
  // Strip the separator before testing for emptiness. It is a control character,
  // not whitespace, so trim() leaves it and a key of nothing-but-separator reads
  // as a perfectly good key.
  if (!key.split(ROLE_KEY_SEP).join('').trim()) {
    return { success: false, reason: 'A company and job title are required.' }
  }
  // Take the advert's fingerprint from whatever this role was last seen as, so
  // the suppression also covers the repost that renames itself — the exact
  // company+title key cannot catch that by construction, and renaming is how a
  // repeatedly-reposted listing usually comes back.
  const seen = queryOne(
    `SELECT description_hash FROM applications
     WHERE lower(trim(company)) = ? AND lower(trim(job_title)) = ? AND description_hash IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [String(company || '').trim().toLowerCase(), String(jobTitle || '').trim().toLowerCase()])
    || queryOne(
      `SELECT description_hash FROM attention_jobs
       WHERE lower(trim(company)) = ? AND lower(trim(job_title)) = ? AND description_hash IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [String(company || '').trim().toLowerCase(), String(jobTitle || '').trim().toLowerCase()])
  run(
    `INSERT INTO suppressed_roles (role_key, company, job_title, reason, description_hash) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(role_key) DO UPDATE SET reason = excluded.reason, created_at = datetime('now'),
       description_hash = COALESCE(excluded.description_hash, suppressed_roles.description_hash)`,
    [key, String(company).trim(), String(jobTitle).trim(), String(reason).slice(0, 200), seen?.description_hash || null]
  )
  return { success: true }
}

function unsuppressRole({ company, jobTitle }) {
  run('DELETE FROM suppressed_roles WHERE role_key = ?', [roleKey(company, jobTitle)])
  return { success: true }
}

function listSuppressedRoles() {
  return query('SELECT role_key as key, company, job_title, reason, created_at FROM suppressed_roles ORDER BY created_at DESC')
}

// Checked by the applicator before a listing costs anything. Exact
// company+title match, case- and whitespace-insensitive: a suppression is a
// statement about one role, and fuzzy-matching it would quietly turn it into a
// statement about a family of them.
function isRoleSuppressed(company, jobTitle) {
  return !!queryOne('SELECT 1 FROM suppressed_roles WHERE role_key = ? LIMIT 1', [roleKey(company, jobTitle)])
}

// ─── Advertised-pay benchmark ────────────────────────────────────
//
// What a role like this one has been advertised at, drawn from the history this
// app has already collected. The Offers page could show what an offer IS but had
// nothing to say about whether it was good, which is the only question anyone
// actually has while holding one.
//
// Matched on significant title words rather than an exact string, because
// "Senior Backend Engineer" and "Backend Engineer (Senior)" are the same market
// and an exact match would find neither. Every figure is an ADVERTISED range —
// what employers published, not what anyone was paid — and the caller must say
// so; presenting it as market rate would be the one failure here that actively
// misleads a negotiation.
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'at', 'or', 'with',
  'job', 'role', 'position', 'opportunity', 'new', 'x', 'f', 'm', 'd',
])

function titleTokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w))
}

function getSalaryBenchmark(jobTitle, { minSample = 5 } = {}) {
  const tokens = titleTokens(jobTitle)
  if (tokens.length === 0) return { sample: 0, tokens: [], comparable: false }

  const rows = query(`
    SELECT job_title, salary_min, salary_max FROM applications
    WHERE salary_min IS NOT NULL OR salary_max IS NOT NULL
    UNION ALL
    SELECT job_title, salary_min, salary_max FROM attention_jobs
    WHERE salary_min IS NOT NULL OR salary_max IS NOT NULL
  `)

  // A row counts when it shares at least half of this title's significant
  // words. Requiring all of them matches almost nothing; requiring one matches
  // every "engineer" ever advertised.
  const needed = Math.max(1, Math.ceil(tokens.length / 2))
  const midpoints = []
  for (const r of rows) {
    const other = new Set(titleTokens(r.job_title))
    if (tokens.filter(t => other.has(t)).length < needed) continue
    if (r.salary_min != null && r.salary_max != null) midpoints.push((r.salary_min + r.salary_max) / 2)
    else if (r.salary_min != null || r.salary_max != null) midpoints.push(r.salary_min ?? r.salary_max)
  }

  if (midpoints.length === 0) return { sample: 0, tokens, comparable: false }
  midpoints.sort((a, b) => a - b)
  const at = (q) => midpoints[Math.min(midpoints.length - 1, Math.max(0, Math.round(q * (midpoints.length - 1))))]
  return {
    sample: midpoints.length,
    tokens,
    // Under this, a "percentile" is a description of four numbers rather than a
    // market. Reported so the UI can show the figures but withhold the verdict.
    comparable: midpoints.length >= minSample,
    minSample,
    p25: Math.round(at(0.25)),
    median: Math.round(at(0.5)),
    p75: Math.round(at(0.75)),
    low: Math.round(midpoints[0]),
    high: Math.round(midpoints[midpoints.length - 1]),
  }
}

// Where a given figure falls in that distribution, as a percentile.
function percentileFor(benchmark, value) {
  if (!benchmark?.sample || !Number.isFinite(value)) return null
  // Reconstructed from the quartiles the benchmark exposes rather than a second
  // query: enough to say "around the median" / "top quarter", which is the
  // resolution the answer is actually good to.
  if (value <= benchmark.low) return 0
  if (value >= benchmark.high) return 100
  const points = [[benchmark.low, 0], [benchmark.p25, 25], [benchmark.median, 50], [benchmark.p75, 75], [benchmark.high, 100]]
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (value <= x1) {
      if (x1 === x0) return y1
      return Math.round(y0 + ((value - x0) / (x1 - x0)) * (y1 - y0))
    }
  }
  return 100
}

// ─── Cloud Sync Bookkeeping ──────────────────────────────────────

// Rows with local changes the cloud hasn't seen (new rows start dirty).
function getDirtyApplications() {
  return query('SELECT * FROM applications WHERE cloud_dirty = 1 OR cloud_updated_at IS NULL')
}

function getAllApplicationIds() {
  return query('SELECT id FROM applications').map(r => r.id)
}

// Mark every row as needing an upload. Used when the user chooses to seed a
// cloud account from this device: without it only rows edited since the last
// sync would push, and a re-seed would silently upload a fraction of history.
function markAllDirty() {
  run("UPDATE applications SET cloud_dirty = 1, cloud_updated_at = NULL")
  return { success: true }
}

function countApplications() {
  return queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0
}

// Local ids the desktop has deleted and the cloud has not been told about yet.
// Guarded against a tombstone whose id was later reused by AUTOINCREMENT reuse
// or a restore — a row that exists again is not a deletion.
function getTombstones() {
  return query(
    'SELECT local_id FROM deleted_applications WHERE local_id NOT IN (SELECT id FROM applications)'
  ).map(r => r.local_id)
}

// Dropped only after the cloud delete is confirmed, so an interrupted sync
// retries the deletion next time instead of losing it.
function clearTombstones(ids) {
  if (!ids || ids.length === 0) return
  batch(() => {
    for (const id of ids) run('DELETE FROM deleted_applications WHERE local_id = ?', [id])
  })
}

// Write a cloud row back into the local database under its original id. Used
// when this device has never seen the row (fresh install, restored machine) —
// the cloud is the only remaining copy, so it is a recovery, not a conflict.
// Inserted clean (cloud_dirty = 0) so restoring does not immediately re-push
// everything it just pulled down.
function restoreApplicationFromCloud(r) {
  run(
    `INSERT OR IGNORE INTO applications
      (id, job_title, company, platform, salary, salary_min, salary_max, job_url,
       job_description, match_score, match_explanation, tailored_resume, cover_letter,
       screening_qa, comment, recruiter_email, status, resume_id, resume_name,
       campaign_id, campaign_name, held_at, applied_at, updated_at, cloud_dirty, cloud_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    [
      r.local_id, r.job_title || '', r.company || '', r.platform || '', r.salary || '',
      r.salary_min ?? null, r.salary_max ?? null, r.job_url || '', r.job_description || '',
      r.match_score ?? null, r.match_explanation || '', r.tailored_resume || '',
      r.cover_letter || '', r.screening_qa || '', r.comment || '', r.recruiter_email || '',
      r.status || 'applied', r.resume_id || null, r.resume_name || null,
      r.campaign_id || null, r.campaign_name || null,
      r.held_at || null, r.applied_at || null, r.updated_at || null, r.updated_at || null,
    ]
  )
}

// Clear the dirty flag after a successful push — but only if the row wasn't
// edited again while the push was in flight (guarded by updated_at).
function markCloudSynced(id, cloudUpdatedAt, localUpdatedAt) {
  run('UPDATE applications SET cloud_dirty = 0, cloud_updated_at = ? WHERE id = ? AND updated_at = ?',
    [cloudUpdatedAt, id, localUpdatedAt])
}

// Record the remote version we saw without touching local data.
function markCloudSeen(id, cloudUpdatedAt) {
  run('UPDATE applications SET cloud_updated_at = ? WHERE id = ?', [cloudUpdatedAt, id])
}

// Apply a phone-side edit locally WITHOUT marking the row dirty, so the next
// push doesn't echo it straight back with a new timestamp.
function applyCloudEdit(id, { status, comment }, cloudUpdatedAt) {
  const sets = ["updated_at = datetime('now')", 'cloud_updated_at = ?']
  const params = [cloudUpdatedAt]
  if (status != null) { sets.push('status = ?'); params.push(status) }
  if (comment != null) { sets.push('comment = ?'); params.push(comment) }
  params.push(id)
  run(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`, params)
  if (status != null) recordStatusChange(id, status) // phone edits show in the timeline too
}

// Every interview joined to its application, for the cloud mirror. Unlike
// getUpcomingInterviews this isn't date-filtered — the phone applies its own
// window, and filtering here would make a past interview look deleted.
function getAllInterviewEventsForSync() {
  return query(`
    SELECT e.id, e.application_id, e.scheduled_at, e.has_time, e.source, e.note, e.source_zone, e.source_local,
           a.job_title, a.company, a.platform, a.job_url
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
  `)
}

// Move an interview. Used by calendar sync when the user rescheduled the event in
// their own calendar: the time changes and so does `source`, because it is no
// longer the time Hiro parsed out of an email and pretending otherwise would
// mislabel it as auto-detected forever.
function updateInterviewEventTime(id, { scheduledAt, hasTime = true, source = null }) {
  if (source) {
    run('UPDATE interview_events SET scheduled_at = ?, has_time = ?, source = ? WHERE id = ?',
      [scheduledAt, hasTime ? 1 : 0, source, id])
  } else {
    run('UPDATE interview_events SET scheduled_at = ?, has_time = ? WHERE id = ?',
      [scheduledAt, hasTime ? 1 : 0, id])
  }
  return { success: true }
}

// ─── Attention Jobs ──────────────────────────────────────────────

// Jobs with a known closing date come first, soonest deadline at the top —
// that's the decision the user is actually making on this page. Anything with
// no parsed deadline falls back to most-recently-found.
function getAttentionJobs() {
  return query(`
    SELECT * FROM attention_jobs WHERE dismissed = 0
    ORDER BY
      CASE WHEN closing_date IS NULL OR closing_date = '' THEN 1 ELSE 0 END,
      closing_date ASC,
      found_at DESC
  `)
}

function getAttentionJob(id) {
  return queryOne('SELECT * FROM attention_jobs WHERE id = ?', [id])
}

function insertAttentionJob(data) {
  // Guard at the write, not only at the caller: a re-scan, a cloud-triggered
  // scan and a manual retry all reach here, and a duplicate row is invisible
  // in the UI except as the same job listed twice.
  if (data.job_url && hasAttentionJobUrl(data.job_url)) {
    return { success: true, skipped: 'duplicate' }
  }
  const parsed = data.salary_min == null && data.salary_max == null
    ? parseSalaryColumns(data.salary || '')
    : { salary_min: data.salary_min ?? null, salary_max: data.salary_max ?? null }

  // Every nullable binding is coerced, because sql.js refuses `undefined` — and
  // it refuses it by throwing a bare STRING, not an Error. The applicator's
  // catch logged `err.message`, so a caller that omitted one optional field
  // produced "Scan error: undefined" and lost the job. That is exactly what
  // happened to every ATS-board match: nothing set job_description on the job
  // object, so the insert threw and the whole feature silently saved nothing.
  run(`
    INSERT INTO attention_jobs
      (job_title, company, platform, salary, job_url, job_description, match_score, talking_points, reason, closing_date, salary_min, salary_max, campaign_id, campaign_name, description_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.job_title ?? '', data.company ?? '', data.platform ?? '', data.salary || '',
    data.job_url ?? '', data.job_description ?? '', data.match_score ?? null,
    JSON.stringify(data.talking_points || []), data.reason || '',
    data.closing_date || null,
    parsed.salary_min ?? null, parsed.salary_max ?? null,
    data.campaign_id || null, data.campaign_name || null,
    jobFingerprint.fingerprint(data.company, data.job_description),
  ])
  return { success: true }
}

function dismissAttentionJob(id) {
  run('UPDATE attention_jobs SET dismissed = 1 WHERE id = ?', [id])
  return { success: true }
}

function deleteAttentionJob(id) {
  run('DELETE FROM attention_jobs WHERE id = ?', [id])
  return { success: true }
}

function clearAllAttentionJobs() {
  run('DELETE FROM attention_jobs')
  return { success: true }
}

// ─── Screening Answer Cache ──────────────────────────────────────

function normalizeQuestion(question) {
  return question.toLowerCase().trim().replace(/\s+/g, ' ')
}

function getCachedAnswer(question) {
  const hash = normalizeQuestion(question)
  return queryOne('SELECT answer FROM screening_cache WHERE question_hash = ?', [hash])?.answer || null
}

// The cached answer plus who wrote it, for callers that need to decide whether
// to trust it. getCachedAnswer stays as-is so existing call sites are unchanged.
function getCachedAnswerRecord(question) {
  const hash = normalizeQuestion(question)
  // updated_at travels with the answer so the caller can tell how long ago it
  // was last confirmed — these are submitted to employers for as long as they
  // sit here, and the facts under them move.
  const row = queryOne('SELECT answer, source, updated_at FROM screening_cache WHERE question_hash = ?', [hash])
  if (!row?.answer) return null
  return { answer: row.answer, source: row.source || 'ai', updated_at: row.updated_at || null }
}

// `source` is required, and deliberately has no default.
//
// It used to default to 'ai', and the ON CONFLICT clause overwrites it — so a
// caller that simply forgot the argument DOWNGRADED an answer the user had
// typed themselves. The fabrication guard only exempts 'user', so the next use
// re-checked the user's own words against the resume and deleted them for
// naming a degree or a year the resume does not spell out. A silent default on
// a field that decides whether something is trusted is a trap; refuse it.
function saveCachedAnswer(question, answer, source) {
  if (source !== 'ai' && source !== 'user') {
    throw new Error(`saveCachedAnswer needs an explicit source of 'ai' or 'user' (got ${JSON.stringify(source)})`)
  }
  const hash = normalizeQuestion(question)
  run(
    `INSERT INTO screening_cache (question_hash, question, answer, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(question_hash) DO UPDATE SET answer = excluded.answer, source = excluded.source, updated_at = datetime('now')`,
    [hash, question, answer, source]
  )
}

function getAllCachedAnswers() {
  return query('SELECT question, answer, source, updated_at FROM screening_cache ORDER BY updated_at DESC')
}

// "Yes, this is still true." Bumps the date without touching the answer or who
// wrote it.
//
// A cached answer is submitted to employers for as long as it sits here, and the
// facts underneath it move: "three years of Python" was right when it was typed
// and is wrong two years later; "available to start immediately" stops being
// true the day a job is accepted. Nothing ever aged these out, so the oldest
// answers — the ones most likely to have drifted — were the ones being reused
// most. Confirming is the cheap half of the fix; Settings showing which are
// stale is the other half.
function confirmCachedAnswer(question) {
  const hash = normalizeQuestion(question)
  if (!queryOne('SELECT 1 FROM screening_cache WHERE question_hash = ?', [hash])) {
    return { success: false, reason: 'That answer is no longer cached.' }
  }
  run(`UPDATE screening_cache SET updated_at = datetime('now') WHERE question_hash = ?`, [hash])
  return { success: true }
}

function deleteCachedAnswer(question) {
  const hash = normalizeQuestion(question)
  run('DELETE FROM screening_cache WHERE question_hash = ?', [hash])
  return { success: true }
}

// ─── Stats ───────────────────────────────────────────────────────

// applied_at is stored in UTC (datetime('now')); these boundaries convert the
// user's LOCAL start-of-day back to UTC so "today"/"this week" match the
// calendar the user actually lives in (previously UTC dates were used, which
// misbucketed mornings in UTC+ timezones).
const TODAY_START = "datetime('now','localtime','start of day','utc')"
const WEEK_START = "datetime('now','localtime','start of day','-6 days','utc')"
const LAST_WEEK_START = "datetime('now','localtime','start of day','-13 days','utc')"

// Statuses that mean "the employer got back to us". An offer implies the
// interview stage was reached and a rejection is still a reply, so both count —
// previously only 'interview' did, which meant moving a job forward to Offer
// silently LOWERED the response rate. Matches getScoreBandConversion, which
// already counted offers as conversions.
const RESPONDED_STATUSES = ['interview', 'offer', 'rejected', 'pending']
const RESPONDED_SQL = RESPONDED_STATUSES.map(s => `'${s}'`).join(', ')

// Rows that were never actually submitted to an employer: scored below the
// match threshold ('skipped') or waiting on the user's approval in review mode
// ('held'). They must stay out of every rate denominator and out of the
// "applied today / this week" counts, or holding a job for review would look
// like an application that simply never got a reply.
const UNSENT_STATUSES = ['skipped', 'held']
const UNSENT_SQL = UNSENT_STATUSES.map(s => `'${s}'`).join(', ')
const SENT_ONLY = `status NOT IN (${UNSENT_SQL})`
const UNSENT_ONLY = `status IN (${UNSENT_SQL})`

// The user pulled out: took another offer, or decided against the role after
// applying. Distinct from every other terminal status, and the distinction is
// the reason it exists rather than being folded into 'rejected' or 'skipped':
//
//   'rejected' would be a lie about who ended it, and it would land in the
//   rejection-stage analysis — the report whose entire purpose is to say whether
//   the resume or the interview is the problem. Withdrawals in there are noise
//   attributed to the candidate's documents.
//
//   'skipped' would be a lie about whether it was sent. It was, and it belongs
//   in the record of what went out.
//
// So it counts as SENT — it happened, it cost the spend, it is part of the
// history — but it is excluded from the rate DENOMINATORS below. A withdrawn
// application is one where the employer's answer is simply unknown, because the
// user stopped waiting for it. Counting it as a non-response would mean taking a
// job somewhere else made your response rate look worse.
const WITHDRAWN_STATUSES = ['withdrawn']
const NO_VERDICT_SQL = [...UNSENT_STATUSES, ...WITHDRAWN_STATUSES].map(s => `'${s}'`).join(', ')
// The denominator for response and interview rates: submitted, and the employer
// had a real chance to answer.
const RATE_ELIGIBLE = `status NOT IN (${NO_VERDICT_SQL})`

function getStats() {
  const interviews = queryOne("SELECT COUNT(*) as c FROM applications WHERE status IN ('interview', 'offer')")?.c || 0
  const responded = queryOne(`SELECT COUNT(*) as c FROM applications WHERE status IN (${RESPONDED_SQL})`)?.c || 0
  const appliedCount = queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${RATE_ELIGIBLE}`)?.c || 0

  return {
    // Every "applied" count is SENT_ONLY. They used to be plain COUNT(*), so a
    // dry run that skipped everything below the threshold — or a review-mode
    // scan that held ten jobs — reported ten applications the employer never
    // received. The unsent rows are still surfaced, as unsentToday/heldCount
    // and in byStatus, rather than hidden.
    totalAllTime: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY}`)?.c || 0,
    totalToday: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${TODAY_START}`)?.c || 0,
    totalThisWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${WEEK_START}`)?.c || 0,
    totalLastWeek: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${LAST_WEEK_START} AND applied_at < ${WEEK_START}`)?.c || 0,
    // Scored-and-skipped or held today. Lets the UI say "3 applied · 12 skipped"
    // instead of leaving the user wondering where a busy scan went.
    unsentToday: queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${UNSENT_ONLY} AND applied_at >= ${TODAY_START}`)?.c || 0,
    // Rows of every kind, including never-submitted ones — the size of the
    // local database rather than a count of applications.
    rowsAllTime: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    interviews,
    attentionCount: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    // Jobs parked by review mode, waiting for the user to approve or reject.
    heldCount: queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'held'")?.c || 0,
    followUpReviewCount: queryOne("SELECT COUNT(*) as c FROM follow_up_drafts WHERE status = 'held'")?.c || 0,
    byPlatform: query(`SELECT platform, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} GROUP BY platform`),
    // byStatus deliberately keeps every row: it is a breakdown BY status, so
    // 'skipped' and 'held' are the point rather than a distortion.
    byStatus: query("SELECT status, COUNT(*) as count FROM applications GROUP BY status"),
    todayJobs: query(`SELECT job_title, company, platform, match_score, status FROM applications WHERE ${SENT_ONLY} AND applied_at >= ${TODAY_START} ORDER BY applied_at DESC`),
    // Any reply at all, over everything submitted.
    responseRate: appliedCount > 0 ? Math.round((responded / appliedCount) * 100) : 0,
    // Reached interview or offer — the number most people actually mean when
    // they ask how the search is going. Reported alongside, not instead of.
    interviewRate: appliedCount > 0 ? Math.round((interviews / appliedCount) * 100) : 0,
  }
}

// How many applications were actually SUBMITTED to this platform today. Rows
// saved as 'skipped' (scored below the match threshold) and 'held' (waiting on
// review) were never sent, so they must not consume the daily limit — counting
// them meant a scan whose first N jobs scored badly stopped before applying to
// anything at all.
function getTodayCountByPlatform(platform) {
  return queryOne(
    `SELECT COUNT(*) as c FROM applications
     WHERE platform = ? AND status NOT IN ('skipped', 'held') AND applied_at >= ${TODAY_START}`,
    [platform]
  )?.c || 0
}

// Drafts held for review, created today, per platform.
//
// getTodayCountByPlatform above deliberately excludes these, and that is right
// for the limit it governs — the daily limit bounds what is SENT. But with
// review-before-submit on and no auto-submit threshold, nothing is ever sent,
// so that limit never engages and the scan walks every listing it scraped,
// paying for a score, a tailored résumé and a cover letter on each. The user
// who turned on the safest setting in the app got the largest bill.
//
// This is the matching bound for the other outcome: a cap on drafts produced.
function getTodayHeldCountByPlatform(platform) {
  return queryOne(
    `SELECT COUNT(*) as c FROM applications
     WHERE platform = ? AND status = 'held' AND applied_at >= ${TODAY_START}`,
    [platform]
  )?.c || 0
}

function holdApplicationDraft(id, data) {
  const row = queryOne('SELECT * FROM applications WHERE id = ?', [id])
  if (!row) return { success: false }
  const detail = (data.flags || []).map(f => `${f.kind}: ${f.value}`).join('; ')
  run(`UPDATE applications SET status = 'held', held_at = ?,
       tailored_resume = ?, cover_letter = ?, resume_id = ?, resume_name = ?,
       fabrication_flags = ?, match_explanation = ?,
       updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?`, [
    new Date().toISOString(), data.tailoredResume || '',
    data.coverLetter || '', data.resumeId || null, data.resumeName || null,
    JSON.stringify(data.flags || []),
    `${row.match_explanation || ''}${row.match_explanation ? '\n\n' : ''}Fabrication guard: ${detail}`,
    id,
  ])
  recordStatusChange(id, 'held')
  recordSnapshot(id, 'drafted', {
    base_resume: data.baseResume, resume_name: data.resumeName,
    tailored_resume: data.tailoredResume, cover_letter: data.coverLetter,
    match_score: row.match_score, status: 'held', provider: data.provider, model: data.model,
  })
  return { success: true }
}

// ATS boards never submit automatically; creating a Needs Attention draft is
// the spend-causing completed unit, so its daily cap must count those rows.
function getTodayAttentionCountByPlatform(platform) {
  return queryOne(
    `SELECT COUNT(*) as c FROM attention_jobs
     WHERE platform = ? AND found_at >= ${TODAY_START}`,
    [platform]
  )?.c || 0
}

function findDuplicateAcrossPlatforms(jobTitle, company, currentPlatform) {
  return queryOne(
    `SELECT id, platform FROM applications
     WHERE LOWER(job_title) = LOWER(?) AND LOWER(company) = LOWER(?) AND platform != ? AND ${SENT_ONLY} LIMIT 1`,
    [jobTitle, company, currentPlatform]
  )
}

// Both chart series count SUBMITTED applications only, matching the "Today" and
// "This Week" tiles. A skipped or held row on the same day would otherwise draw
// a spike that no employer ever saw.
function getApplicationsByDate() {
  return query(`SELECT DATE(applied_at,'localtime') as date, platform, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} GROUP BY DATE(applied_at,'localtime'), platform ORDER BY date DESC`)
}

function getApplicationsPerDay(days) {
  const rows = query(
    `SELECT DATE(applied_at,'localtime') as date, COUNT(*) as count FROM applications
     WHERE ${SENT_ONLY}
       AND applied_at >= datetime('now','localtime','start of day','-' || ? || ' days','utc')
     GROUP BY DATE(applied_at,'localtime') ORDER BY date ASC`,
    [days - 1]
  )
  // Pad missing days with zeros so charts always get a continuous series
  // (and match the mobile cloud client, which already pads).
  const byDate = {}
  for (const r of rows) byDate[r.date] = r.count
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, count: byDate[key] || 0 })
  }
  return out
}

// ─── Inbox reply tracking ────────────────────────────────────────
// Statuses the inbox check should keep watching. 'applied' is the obvious one,
// but 'pending' (a reply arrived that we couldn't classify) and 'no_response'
// (we gave up waiting) must stay in scope too — previously the inbox only
// looked at 'applied', so the moment a thread was marked pending it was frozen
// and a later email actually scheduling an interview was never seen.
// 'withdrawn' is deliberately absent: the user has left the process, so a later
// email is not an outcome to re-open the row with.
const OPEN_STATUSES = ['applied', 'pending', 'no_response']

function getApplicationsAwaitingReply() {
  const list = OPEN_STATUSES.map(s => `'${s}'`).join(', ')
  return query(`SELECT * FROM applications WHERE status IN (${list}) ORDER BY applied_at DESC`)
}

// Remember which email we last classified, so the next pass can skip it.
function setLastReplyUid(id, uid) {
  run('UPDATE applications SET last_reply_uid = ? WHERE id = ?', [uid ?? null, id])
}

// Applications due a follow-up, and which round each is due.
//
// Two clocks, not one. The FIRST follow-up is measured from the application —
// "it has been a week and I have heard nothing". Every one after that is
// measured from the previous follow-up, because that is the last time this
// employer heard from the candidate and it is the gap that would read as
// nagging. Measuring later rounds from the application date instead would fire
// them all at once the moment the first one went out.
//
// `maxCount` of 1 is exactly the old behaviour: one nudge, ever.
function getApplicationsForFollowUp(daysOld, { maxCount = 1, intervalDays = 14 } = {}) {
  const rounds = Math.max(1, Math.floor(Number(maxCount) || 1))
  // 0 is allowed and means "no enforced gap" — the next round is due on the
  // next pass. That is a coherent thing to ask for and the query should do what
  // it is told; Settings is where a silly value is talked out of the user.
  const gap = Math.max(0, Math.floor(Number(intervalDays) || 0))
  return query(`SELECT *, COALESCE(follow_up_count, 0) + 1 AS follow_up_stage FROM applications a
                WHERE status = 'applied'
                AND COALESCE(follow_up_stopped, 0) = 0
                AND COALESCE(follow_up_count, 0) < ?
                AND (
                  (COALESCE(follow_up_count, 0) = 0
                   AND applied_at <= datetime('now', '-' || ? || ' days'))
                  OR
                  (COALESCE(follow_up_count, 0) > 0
                   AND last_follow_up_at IS NOT NULL
                   AND last_follow_up_at <= datetime('now', '-' || ? || ' days'))
                )
                AND NOT EXISTS (SELECT 1 FROM follow_up_drafts d
                                WHERE d.application_id = a.id AND d.status = 'held')
                ORDER BY applied_at ASC`, [rounds, daysOld, gap])
}

// One follow-up has gone out. Advances the round rather than latching a flag, so
// the next one is spaced from here and asks for a different letter.
function markFollowUpSent(id) {
  run(`UPDATE applications
       SET follow_up_sent = 1,
           follow_up_count = COALESCE(follow_up_count, 0) + 1,
           last_follow_up_at = datetime('now')
       WHERE id = ?`, [id])
}

// The user declined a drafted follow-up. Ends the sequence for this application
// — see the note on follow_up_stopped in migrate().
function stopFollowUps(id) {
  run('UPDATE applications SET follow_up_stopped = 1 WHERE id = ?', [id])
}

// Undo that, for an application the user changes their mind about.
function resumeFollowUps(id) {
  run('UPDATE applications SET follow_up_stopped = 0 WHERE id = ?', [id])
  return { success: true }
}

function saveFollowUpDraft({ applicationId, recipient, subject, body }) {
  run(`INSERT INTO follow_up_drafts (application_id, recipient, subject, body, status)
       VALUES (?, ?, ?, ?, 'held')
       ON CONFLICT(application_id) DO UPDATE SET recipient = excluded.recipient,
       subject = excluded.subject, body = excluded.body, status = 'held',
       created_at = datetime('now'), resolved_at = NULL`,
  [applicationId, recipient, subject, body])
  return { success: true }
}

function getFollowUpDrafts() {
  return query(`SELECT d.*, a.job_title, a.company
                FROM follow_up_drafts d JOIN applications a ON a.id = d.application_id
                WHERE d.status = 'held' ORDER BY d.created_at ASC`)
}

function getFollowUpDraft(id) {
  return queryOne(`SELECT d.*, a.job_title, a.company
                   FROM follow_up_drafts d JOIN applications a ON a.id = d.application_id
                   WHERE d.id = ?`, [id])
}

// Settle a drafted follow-up, whichever way the user went.
//
// Advancing the application belongs HERE rather than in the callers, because it
// is what stops the draft being written again. Only the 'held' status keeps an
// application out of getApplicationsForFollowUp, so a draft resolved any other
// way used to leave it due on the next pass — the AI redrafted a message the
// user had already declined, every weekday, forever.
//
// The two outcomes are no longer the same, though, and that matters once there
// is more than one round. Approving means this letter went: advance to the next
// stage and let the interval decide when it is due. Rejecting means the user
// looked at chasing this employer and said no — so it ends the sequence rather
// than merely deferring it to the next round, which would be the same nagging
// with a fortnight's delay.
function resolveFollowUpDraft(id, status) {
  const draft = queryOne('SELECT application_id FROM follow_up_drafts WHERE id = ?', [id])
  if (!draft) return { success: false, reason: 'Follow-up draft not found' }
  batch(() => {
    run(`UPDATE follow_up_drafts SET status = ?, resolved_at = datetime('now') WHERE id = ?`, [status, id])
    if (status === 'sent' || status === 'approved') markFollowUpSent(draft.application_id)
    else stopFollowUps(draft.application_id)
  })
  return { success: true }
}

// ─── Stale applications ──────────────────────────────────────────
// An application that never gets a reply sat at 'applied' forever, which meant
// the response-rate denominator kept growing with rows that were never going to
// resolve. After `days` with no reply, move it to 'no_response' — a terminal
// status that's excluded from the response numerator but still visible, and
// still re-checked by the inbox in case a late reply arrives.
function markStaleApplications(days) {
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0) return { updated: 0 }
  const stale = query(
    `SELECT id FROM applications
     WHERE status = 'applied' AND applied_at <= datetime('now', '-' || ? || ' days')`,
    [n]
  )
  if (stale.length === 0) return { updated: 0 }
  batch(() => {
    for (const row of stale) updateApplicationStatus(row.id, 'no_response')
  })
  return { updated: stale.length }
}

function clearAllCachedAnswers() {
  run('DELETE FROM screening_cache')
  return { success: true }
}

// ─── Interview Prep ──────────────────────────────────────────────
function saveInterviewPrep(applicationId, questions) {
  run('DELETE FROM interview_prep WHERE application_id = ?', [applicationId])
  run('INSERT INTO interview_prep (application_id, questions) VALUES (?, ?)', [applicationId, JSON.stringify(questions)])
  persist()
}

function getInterviewPrep(applicationId) {
  const row = queryOne('SELECT questions FROM interview_prep WHERE application_id = ?', [applicationId])
  if (!row) return null
  try { return JSON.parse(row.questions) } catch { return null }
}

function deleteInterviewPrep(applicationId) {
  run('DELETE FROM interview_prep WHERE application_id = ?', [applicationId])
  persist()
}

// ─── Interview Schedule ──────────────────────────────────────────
// Interviews detected in recruiter replies (or entered by hand), so the user
// doesn't have to go dig the email back out after Hiro flags the reply.

function addInterviewEvent({ applicationId, scheduledAt, hasTime = true, source = 'manual', note = '', sourceZone = null, sourceLocal = null }) {
  run(
    'INSERT INTO interview_events (application_id, scheduled_at, has_time, source, note, source_zone, source_local) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [applicationId, scheduledAt, hasTime ? 1 : 0, source, note || '', sourceZone, sourceLocal]
  )
  return { success: true }
}

// Only one auto-detected event per application: a recruiter thread produces
// several matching emails, and each inbox pass would otherwise add a duplicate.
// A manually entered time always wins and is never overwritten.
function upsertDetectedInterview({ applicationId, scheduledAt, hasTime = true, note = '', sourceZone = null, sourceLocal = null }) {
  const manual = queryOne(
    "SELECT id FROM interview_events WHERE application_id = ? AND source = 'manual' LIMIT 1",
    [applicationId]
  )
  if (manual) return { success: true, skipped: 'manual-entry-exists' }

  const existing = queryOne(
    "SELECT id, scheduled_at FROM interview_events WHERE application_id = ? AND source = 'inbox' LIMIT 1",
    [applicationId]
  )
  if (existing) {
    if (existing.scheduled_at === scheduledAt) return { success: true, skipped: 'unchanged' }
    run('UPDATE interview_events SET scheduled_at = ?, has_time = ?, note = ?, source_zone = ?, source_local = ? WHERE id = ?',
      [scheduledAt, hasTime ? 1 : 0, note || '', sourceZone, sourceLocal, existing.id])
    return { success: true, updated: true }
  }
  return addInterviewEvent({ applicationId, scheduledAt, hasTime, source: 'inbox', note, sourceZone, sourceLocal })
}

function getInterviewEvents(applicationId) {
  return query('SELECT * FROM interview_events WHERE application_id = ? ORDER BY scheduled_at ASC', [applicationId])
}

// Upcoming interviews across all applications, joined to the job they belong
// to. Includes anything from the start of today so an interview later today
// doesn't vanish from the list at midnight-plus-one-second.
function getUpcomingInterviews(limit = 25) {
  return query(`
    SELECT e.id, e.application_id, e.scheduled_at, e.has_time, e.source, e.note, e.source_zone, e.source_local,
           a.job_title, a.company, a.platform, a.status, a.job_url
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.scheduled_at >= date('now','localtime')
    ORDER BY e.scheduled_at ASC
    LIMIT ?
  `, [limit])
}

function deleteInterviewEvent(id) {
  run('DELETE FROM interview_events WHERE id = ?', [id])
  return { success: true }
}

// ─── Pipeline: next actions ──────────────────────────────────────
// `status` records where an application GOT TO. It cannot record what the user
// still owes it — chase the recruiter on Thursday, send the take-home by Friday
// — which is why applications quietly died of neglect while the board looked
// healthy. next_action_at/note is that missing half.
//
// Dates are local "YYYY-MM-DD": a follow-up is a day, not an instant, and
// storing it as UTC would move it across midnight for half the world.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function setNextAction(id, { date, note }) {
  const clean = date && DATE_ONLY.test(String(date).trim()) ? String(date).trim() : null
  if (date && !clean) return { success: false, reason: 'Date must be YYYY-MM-DD.' }
  run(
    `UPDATE applications
     SET next_action_at = ?, next_action_note = ?, next_action_done_at = NULL,
         updated_at = datetime('now'), cloud_dirty = 1
     WHERE id = ?`,
    [clean, note || '', id]
  )
  return { success: true }
}

// Completing an action is not the same as never having had one: the date is
// cleared so it stops being due, but next_action_done_at records that it was
// dealt with, which is what stops the pipeline nudge re-flagging the row
// immediately.
function completeNextAction(id) {
  run(
    `UPDATE applications
     SET next_action_at = NULL, next_action_done_at = datetime('now'),
         updated_at = datetime('now'), cloud_dirty = 1
     WHERE id = ?`,
    [id]
  )
  return { success: true }
}

// Actions due today or overdue. Drives the pipeline's "Overdue" column and the
// follow-up push notification.
function getDueNextActions() {
  return query(`
    SELECT id, job_title, company, status, next_action_at, next_action_note
    FROM applications
    WHERE next_action_at IS NOT NULL
      AND next_action_at <= date('now','localtime')
      AND ${SENT_ONLY}
    ORDER BY next_action_at ASC
  `)
}

// Which pipeline column a row belongs to. Derived from status rather than stored
// so an existing database needs no backfill and the board can never disagree
// with the status shown everywhere else.
const PIPELINE_STAGES = [
  { id: 'applied', label: 'Applied', statuses: ['applied'] },
  { id: 'waiting', label: 'No reply yet', statuses: ['no_response', 'pending'] },
  { id: 'interview', label: 'Interviewing', statuses: ['interview'] },
  { id: 'offer', label: 'Offer', statuses: ['offer'] },
  // Withdrawn sits with rejected because both are over — the board answers
  // "what do I owe and when", and neither of these owes anything.
  { id: 'closed', label: 'Closed', statuses: ['rejected', 'withdrawn'] },
]

// Everything the pipeline board needs in one read: the rows, their stage, and
// how overdue each one is. Held and skipped rows are excluded — they were never
// sent, so there is nothing to chase.
function getPipeline() {
  const rows = query(`
    SELECT id, job_title, company, platform, status, match_score, salary,
           applied_at, updated_at, next_action_at, next_action_note, next_action_done_at,
           recruiter_email, closing_date, job_url
    FROM applications
    WHERE ${SENT_ONLY}
    ORDER BY
      CASE WHEN next_action_at IS NULL THEN 1 ELSE 0 END,
      next_action_at ASC,
      applied_at DESC
  `)

  const today = queryOne("SELECT date('now','localtime') as d")?.d || ''
  const stageOf = (status) => PIPELINE_STAGES.find(s => s.statuses.includes(status))?.id || 'applied'

  // A row nobody has looked at in this long, with no action booked, is the thing
  // that actually goes missing — no status change, no reply, no reminder.
  const nudgeDays = Number(configService.load().pipelineNudgeDays) || 0
  const staleBefore = nudgeDays > 0
    ? queryOne("SELECT date('now','localtime','-' || ? || ' days') as d", [nudgeDays])?.d
    : null

  const upcomingByApp = new Map()
  for (const ev of getUpcomingInterviews(200)) {
    if (!upcomingByApp.has(ev.application_id)) upcomingByApp.set(ev.application_id, ev)
  }

  return {
    stages: PIPELINE_STAGES.map(({ id, label }) => ({ id, label })),
    today,
    items: rows.map(r => {
      const due = r.next_action_at || null
      const lastTouched = (r.updated_at || r.applied_at || '').slice(0, 10)
      return {
        ...r,
        stage: stageOf(r.status),
        overdue: !!(due && due < today),
        dueToday: !!(due && due === today),
        // Only for rows that are still live: a rejection needs no nudge.
        needsAction: !due
          && !!staleBefore
          && lastTouched !== '' && lastTouched < staleBefore
          && !['rejected', 'offer'].includes(r.status),
        nextInterview: upcomingByApp.get(r.id)
          ? {
            scheduled_at: upcomingByApp.get(r.id).scheduled_at,
            has_time: upcomingByApp.get(r.id).has_time,
          }
          : null,
      }
    }),
  }
}

// Applications and Needs Attention jobs whose listing closes within `days` and
// which have NOT been submitted — the only ones where the deadline still means
// something. `source` tells the caller which table a row came from, since the
// two have separate id spaces.
function getClosingSoon(days) {
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0) return []
  const bound = "date('now','localtime','+' || ? || ' days')"
  const held = query(`
    SELECT id, job_title, company, closing_date, 'application' as source
    FROM applications
    WHERE status = 'held' AND closing_date IS NOT NULL AND closing_date != ''
      AND closing_date >= date('now','localtime') AND closing_date <= ${bound}
  `, [n])
  const attention = query(`
    SELECT id, job_title, company, closing_date, 'attention' as source
    FROM attention_jobs
    WHERE dismissed = 0 AND closing_date IS NOT NULL AND closing_date != ''
      AND closing_date >= date('now','localtime') AND closing_date <= ${bound}
  `, [n])
  return [...held, ...attention].sort((a, b) => a.closing_date.localeCompare(b.closing_date))
}

// ─── Push notification ledger ────────────────────────────────────
// Claim a dedupe key. Returns false when this event has already been notified —
// the INSERT is the claim, so two callers racing cannot both win.
function claimPushKey(dedupeKey, kind, title, body) {
  try {
    run('INSERT INTO push_log (dedupe_key, kind, title, body) VALUES (?, ?, ?, ?)',
      [dedupeKey, kind, title || '', body || ''])
    return true
  } catch {
    // PRIMARY KEY violation: already claimed.
    return false
  }
}

function getPushLog(limit = 50) {
  return query('SELECT * FROM push_log ORDER BY sent_at DESC LIMIT ?', [limit])
}

// The ledger is a dedupe mechanism, not history — nothing needs a reminder key
// from six months ago, and interview keys embed a date that can never recur.
function prunePushLog(days = 90) {
  run("DELETE FROM push_log WHERE sent_at < datetime('now', '-' || ? || ' days')", [days])
  return { success: true }
}

// ─── Calendar links ──────────────────────────────────────────────
// See the calendar_links CREATE TABLE for why two-way sync needs its own table.

function getCalendarLink({ interviewId, provider, externalId }) {
  if (externalId) {
    return queryOne('SELECT * FROM calendar_links WHERE provider = ? AND external_id = ?', [provider, externalId])
  }
  return queryOne('SELECT * FROM calendar_links WHERE provider = ? AND interview_id = ?', [provider, interviewId])
}

function saveCalendarLink({ interviewId, provider, externalId, origin = 'hiro', localHash = null, remoteUpdatedAt = null }) {
  const existing = getCalendarLink({ provider, externalId })
  if (existing) {
    run(
      `UPDATE calendar_links
       SET interview_id = ?, local_hash = ?, remote_updated_at = ?, synced_at = datetime('now')
       WHERE id = ?`,
      [interviewId ?? null, localHash, remoteUpdatedAt, existing.id]
    )
    return { success: true, id: existing.id }
  }
  run(
    `INSERT INTO calendar_links (interview_id, provider, external_id, origin, local_hash, remote_updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [interviewId ?? null, provider, externalId, origin, localHash, remoteUpdatedAt]
  )
  return { success: true }
}

function getCalendarLinks(provider) {
  return query('SELECT * FROM calendar_links WHERE provider = ?', [provider])
}

function deleteCalendarLink(id) {
  run('DELETE FROM calendar_links WHERE id = ?', [id])
  return { success: true }
}

// Links whose interview no longer exists locally. The calendar event they point
// at has to be removed too, but only when Hiro created it — an event the user
// made in their own calendar is theirs.
function getOrphanedCalendarLinks(provider) {
  return query(`
    SELECT c.* FROM calendar_links c
    LEFT JOIN interview_events e ON e.id = c.interview_id
    WHERE c.provider = ? AND (c.interview_id IS NULL OR e.id IS NULL)
  `, [provider])
}

// A single interview joined to its application, for one-off calendar export.
function getInterviewEvent(id) {
  return queryOne(`
    SELECT e.id, e.application_id, e.scheduled_at, e.has_time, e.source, e.note, e.source_zone, e.source_local,
           a.job_title, a.company, a.platform, a.status, a.job_url
    FROM interview_events e
    JOIN applications a ON a.id = e.application_id
    WHERE e.id = ?
  `, [id])
}

// ─── Closing dates ───────────────────────────────────────────────

function updateClosingDate(id, closingDate) {
  run("UPDATE applications SET closing_date = ?, updated_at = datetime('now'), cloud_dirty = 1 WHERE id = ?",
    [closingDate || null, id])
  return { success: true }
}

// ─── Score-band conversion ───────────────────────────────────────
// Which match-score bands actually convert to interviews. The histogram on the
// Analytics page shows how many jobs landed in each band; this shows whether
// that band was worth applying to, which is what the threshold should really
// be tuned against. Skipped rows are excluded — they were never submitted, so
// they can't have converted.
// ─── Recruiter replies ───────────────────────────────────────────
// The inbox check downloads a reply body to classify it. Keeping that body is
// what lets interview prep speak to the conversation that actually happened
// rather than to the job ad alone.

// Bodies are for prompting, not archiving. Quoted threads balloon fast, and
// sql.js rewrites the entire database file on every save.
const REPLY_BODY_LIMIT = 8000

function saveRecruiterReply({ applicationId, uid, from, subject, body, classifiedAs, receivedAt }) {
  if (!applicationId) return { success: false, reason: 'applicationId is required' }
  // INSERT OR REPLACE on (application_id, uid): the inbox may re-read the same
  // message across passes, and a second copy of one email would weight the
  // prep prompt towards whichever reply happened to be fetched twice.
  run(`
    INSERT OR REPLACE INTO recruiter_replies
      (application_id, uid, from_address, subject, body, classified_as, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    applicationId, uid ?? null,
    String(from || '').slice(0, 320), String(subject || '').slice(0, 500),
    String(body || '').slice(0, REPLY_BODY_LIMIT),
    String(classifiedAs || ''), receivedAt || null,
  ])
  return { success: true }
}

function getRecruiterReplies(applicationId, limit = 10) {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 10
  return query(
    `SELECT * FROM recruiter_replies WHERE application_id = ?
     ORDER BY COALESCE(received_at, created_at) DESC, id DESC LIMIT ${n}`,
    [applicationId]
  )
}

// The correspondence as one block of prompt context, oldest first so the model
// reads the thread in the order it happened. Returns '' when there is nothing,
// so callers can fall back to job-description-only prep without branching on
// a null.
function getReplyContext(applicationId, { maxChars = 6000 } = {}) {
  const replies = getRecruiterReplies(applicationId, 6).reverse()
  if (replies.length === 0) return ''
  const parts = []
  let used = 0
  for (const r of replies) {
    const when = r.received_at || r.created_at || ''
    const block = `--- Reply${when ? ` (${when})` : ''}${r.from_address ? ` from ${r.from_address}` : ''}\nSubject: ${r.subject || '(none)'}\n${r.body || ''}`.trim()
    // Budget the whole context rather than each reply: one long email must not
    // be able to crowd out the five short ones around it, but neither should
    // truncation cut a thread off mid-sentence at an arbitrary reply.
    if (used + block.length > maxChars) break
    parts.push(block)
    used += block.length
  }
  return parts.join('\n\n')
}

function deleteRecruiterReplies(applicationId) {
  run('DELETE FROM recruiter_replies WHERE application_id = ?', [applicationId])
  return { success: true }
}

// ─── Rejection analysis ──────────────────────────────────────────
//
// "How many rejections" is a number nobody can act on. The actionable question
// is WHERE applications die, because the two answers point at completely
// different problems:
//
//   rejected without ever reaching an interview  → the application is the
//                                                  problem (resume, targeting)
//   rejected after interviewing                  → the application is working
//                                                  and the interview is not
//
// The stage is recovered from status_history rather than stored, for the same
// reason the Pipeline board derives its columns: a stored stage can disagree
// with the status shown everywhere else, and this one would be wrong for every
// application that predates the feature.

function rejectionStageFor(history) {
  // Reaching 'interview' or 'offer' at ANY point counts, even if the row later
  // moved back — a rejection after an interview is a late-stage rejection
  // regardless of what the status timeline did afterwards.
  return history.some(h => h.status === 'interview' || h.status === 'offer')
    ? 'post-interview'
    : 'pre-interview'
}

function getRejectionAnalysis() {
  const rejected = query(`
    SELECT id, company, platform, match_score, resume_id, resume_name,
           salary_min, salary_max, applied_at
    FROM applications WHERE status = 'rejected'
  `)
  const sent = queryOne(`SELECT COUNT(*) as c FROM applications WHERE ${SENT_ONLY}`)?.c || 0
  const interviewed = queryOne("SELECT COUNT(*) as c FROM applications WHERE status IN ('interview', 'offer')")?.c || 0

  if (rejected.length === 0) {
    return {
      total: 0, sent, interviewed,
      preInterview: 0, postInterview: 0,
      byBand: [], byResume: [], byPlatform: [],
      medianDaysToRejection: null,
      insights: [],
    }
  }

  // One query for every rejected application's history, rather than one query
  // per row — this runs on every Analytics load and the per-row version was
  // O(rejections) round trips into sql.js.
  const ids = rejected.map(r => r.id)
  const histories = new Map(ids.map(id => [id, []]))
  for (const chunk of chunked(ids, 400)) {
    const rows = query(
      `SELECT application_id, status, changed_at FROM status_history
       WHERE application_id IN (${chunk.map(() => '?').join(', ')})
       ORDER BY changed_at ASC, id ASC`,
      chunk
    )
    for (const row of rows) histories.get(row.application_id)?.push(row)
  }

  const segment = () => ({ total: 0, preInterview: 0, postInterview: 0 })
  const byBand = new Map()
  const byResume = new Map()
  const byPlatform = new Map()
  const daysToRejection = []
  let preInterview = 0
  let postInterview = 0

  for (const app of rejected) {
    const history = histories.get(app.id) || []
    const stage = rejectionStageFor(history)
    if (stage === 'post-interview') postInterview++
    else preInterview++

    const bandLo = app.match_score == null ? null : Math.min(90, Math.floor(Math.max(0, app.match_score) / 10) * 10)
    const bandKey = bandLo == null ? 'unscored' : String(bandLo)
    const resumeKey = app.resume_name || app.resume_id || 'Unlabelled resume'
    const platformKey = app.platform || 'Unknown'

    for (const [map, key] of [[byBand, bandKey], [byResume, resumeKey], [byPlatform, platformKey]]) {
      if (!map.has(key)) map.set(key, segment())
      const bucket = map.get(key)
      bucket.total++
      bucket[stage === 'post-interview' ? 'postInterview' : 'preInterview']++
    }

    // How long the employer took to say no. A pipeline where rejections arrive
    // in three days behaves very differently from one where they take a month,
    // and it changes how long "no reply yet" should be left alone.
    const rejectedAt = [...history].reverse().find(h => h.status === 'rejected')?.changed_at
    const days = daysBetween(app.applied_at, rejectedAt)
    if (days != null) daysToRejection.push(days)
  }

  const toSorted = (map, labelKey) => [...map.entries()]
    .map(([key, v]) => ({ [labelKey]: key, ...v }))
    .sort((a, b) => b.total - a.total)

  const result = {
    total: rejected.length,
    sent,
    interviewed,
    preInterview,
    postInterview,
    byBand: [...byBand.entries()]
      .map(([key, v]) => ({
        band: key === 'unscored' ? 'Unscored' : `${key}–${Number(key) + 9}%`,
        sortKey: key === 'unscored' ? -1 : Number(key),
        ...v,
      }))
      .sort((a, b) => b.sortKey - a.sortKey),
    byResume: toSorted(byResume, 'resume'),
    byPlatform: toSorted(byPlatform, 'platform'),
    medianDaysToRejection: median(daysToRejection),
  }
  result.insights = rejectionInsights(result)
  return result
}

// Turn the counts into the one or two sentences worth reading. Each has to name
// a next action — a diagnosis with no treatment is just discouragement.
function rejectionInsights(a) {
  const out = []
  const staged = a.preInterview + a.postInterview
  if (staged < 5) {
    out.push({
      kind: 'sample',
      title: 'Not enough rejections to read a pattern yet',
      detail: `${staged} recorded. Hiro needs a handful before the split between screening and interview rejections means anything.`,
    })
    return out
  }

  const postShare = Math.round((a.postInterview / staged) * 100)
  if (postShare >= 60) {
    out.push({
      kind: 'stage',
      title: 'Rejections are happening after the interview, not before it',
      detail: `${postShare}% of rejections came after reaching interview stage. The applications are working — ${a.postInterview} employers wanted to meet you. Preparation is where the return is now, not the resume.`,
    })
  } else if (postShare <= 15) {
    out.push({
      kind: 'stage',
      title: 'Applications are being screened out before anyone speaks to you',
      detail: `${100 - postShare}% of rejections came without an interview. That points at the resume and the targeting rather than at how you interview.`,
    })
  } else {
    out.push({
      kind: 'stage',
      title: `${postShare}% of rejections come after an interview`,
      detail: `${a.preInterview} screened out, ${a.postInterview} after meeting. Both stages are costing you roles.`,
    })
  }

  // A resume that is rejected disproportionately at the screening stage is the
  // clearest actionable signal in here.
  const provenResumes = a.byResume.filter(r => r.total >= 5)
  if (provenResumes.length >= 2) {
    const worst = [...provenResumes].sort((x, y) =>
      (y.preInterview / y.total) - (x.preInterview / x.total))[0]
    const share = Math.round((worst.preInterview / worst.total) * 100)
    if (share >= 70) {
      out.push({
        kind: 'resume',
        title: `"${worst.resume}" is being screened out most`,
        detail: `${share}% of its ${worst.total} rejections came before any interview. Compare it against the resume with your best interview rate.`,
      })
    }
  }

  // Rejections concentrated in a high score band mean the scorer disagrees with
  // the employers, which makes the threshold itself suspect.
  const highBand = a.byBand.filter(b => b.sortKey >= 80).reduce((n, b) => n + b.total, 0)
  if (highBand >= 5 && highBand / a.total >= 0.5) {
    out.push({
      kind: 'threshold',
      title: 'Most rejections are high-scoring matches',
      detail: `${highBand} of ${a.total} rejections scored 80% or above. The match score is not predicting these outcomes — worth a test scan to re-tune the threshold.`,
    })
  }

  if (a.medianDaysToRejection != null) {
    out.push({
      kind: 'timing',
      title: `Rejections arrive after about ${a.medianDaysToRejection} day${a.medianDaysToRejection === 1 ? '' : 's'}`,
      detail: `Median from submission to rejection. Chasing before then is usually early; silence well past it is worth a follow-up.`,
    })
  }
  return out
}

// ─── Version outcomes ────────────────────────────────────────────
//
// The snapshot trail already answers "what changed between v1 and v3". It could
// not answer the question that decides whether any of it was worth doing —
// which version got the interview — because a snapshot knew what wrote it and
// nothing about how it landed.
//
// Joining each application's snapshots to its final outcome gives that, grouped
// by the model that produced them, so two providers can be judged on results
// rather than on how the diff reads.

function getVersionOutcomes() {
  const rows = query(`
    SELECT s.provider, s.model, s.application_id, s.reason,
           a.status, a.match_score
    FROM application_snapshots s
    JOIN applications a ON a.id = s.application_id
    WHERE s.reason IN ('submitted', 'drafted')
      AND a.${SENT_ONLY}
      AND s.provider IS NOT NULL AND s.provider != ''
  `)

  const groups = new Map()
  // One application must count once per model, not once per snapshot: a job
  // re-drafted four times by the same model would otherwise quadruple its own
  // outcome and swamp everything else in the comparison.
  const counted = new Set()
  for (const r of rows) {
    const key = `${r.provider}${r.model ? ` · ${r.model}` : ''}`
    const dedupe = `${key}\0${r.application_id}`
    if (counted.has(dedupe)) continue
    counted.add(dedupe)
    if (!groups.has(key)) {
      groups.set(key, { label: key, provider: r.provider, model: r.model || '', sent: 0, interviews: 0, offers: 0, rejected: 0, scoreTotal: 0, scored: 0 })
    }
    const g = groups.get(key)
    g.sent++
    if (r.status === 'interview') g.interviews++
    else if (r.status === 'offer') g.offers++
    else if (r.status === 'rejected') g.rejected++
    if (r.match_score != null) { g.scoreTotal += r.match_score; g.scored++ }
  }

  return [...groups.values()]
    .map(g => ({
      ...g,
      converted: g.interviews + g.offers,
      // Null rather than 0 below the sample floor. A single application at 100%
      // is not a better model, and rendering it as one invites exactly the
      // wrong conclusion.
      interviewRate: g.sent >= 5 ? Math.round(((g.interviews + g.offers) / g.sent) * 100) : null,
      averageScore: g.scored > 0 ? Math.round(g.scoreTotal / g.scored) : null,
    }))
    .sort((a, b) => b.sent - a.sent)
}

// The same question for one application: which of its saved versions was live
// when the outcome landed. Ordered oldest first so the panel reads as a story.
function getApplicationVersionOutcome(applicationId) {
  const app = queryOne('SELECT id, status, job_title, company FROM applications WHERE id = ?', [applicationId])
  if (!app) return null
  const snapshots = query(`
    SELECT id, reason, taken_at, provider, model, match_score,
           LENGTH(tailored_resume) as tailored_length,
           LENGTH(cover_letter) as cover_letter_length
    FROM application_snapshots WHERE application_id = ?
    ORDER BY taken_at ASC, id ASC
  `, [applicationId])
  const history = query(
    'SELECT status, changed_at FROM status_history WHERE application_id = ? ORDER BY changed_at ASC, id ASC',
    [applicationId]
  )
  const reached = history.find(h => h.status === 'interview' || h.status === 'offer')

  return {
    ...app,
    outcome: app.status,
    reachedInterviewAt: reached?.changed_at || null,
    // The version that was live when the interview was won — the last one taken
    // at or before that moment. Null when the application never got there, which
    // is itself the answer to "did this version work".
    decisiveSnapshotId: reached
      ? ([...snapshots].reverse().find(s => s.taken_at <= reached.changed_at)?.id ?? null)
      : null,
    snapshots,
  }
}

// ─── Offers ──────────────────────────────────────────────────────

const OFFER_DECISIONS = ['considering', 'accepted', 'declined', 'expired']

function saveOffer(applicationId, data = {}) {
  if (!applicationId) return { success: false, reason: 'applicationId is required' }
  const app = queryOne('SELECT id, status FROM applications WHERE id = ?', [applicationId])
  if (!app) return { success: false, reason: 'That application no longer exists' }

  const int = (v, max = 100000000) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : null
  }
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null)
  const decision = OFFER_DECISIONS.includes(data.decision) ? data.decision : 'considering'
  const excitement = data.excitement == null ? null : Math.max(0, Math.min(5, Math.round(Number(data.excitement) || 0)))

  run(`
    INSERT INTO offers
      (application_id, base_salary, bonus, equity, currency, start_date, respond_by,
       location, remote, pros, cons, notes, excitement, decision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET
      base_salary = excluded.base_salary, bonus = excluded.bonus, equity = excluded.equity,
      currency = excluded.currency, start_date = excluded.start_date, respond_by = excluded.respond_by,
      location = excluded.location, remote = excluded.remote, pros = excluded.pros,
      cons = excluded.cons, notes = excluded.notes, excitement = excluded.excitement,
      decision = excluded.decision, updated_at = datetime('now')
  `, [
    applicationId, int(data.baseSalary), int(data.bonus, 10000000),
    String(data.equity || '').slice(0, 200), String(data.currency || '').slice(0, 8),
    date(data.startDate), date(data.respondBy),
    String(data.location || '').slice(0, 160), String(data.remote || '').slice(0, 40),
    String(data.pros || '').slice(0, 4000), String(data.cons || '').slice(0, 4000),
    String(data.notes || '').slice(0, 4000), excitement, decision,
  ])

  // Recording an offer against a row that is not yet marked as one is almost
  // certainly the user telling us it IS one. Promote it rather than leaving the
  // dashboard disagreeing with the offers board.
  //
  // This deliberately does NOT depend on the decision. It used to also require
  // `decision === 'considering'`, which meant recording an offer you had
  // already accepted — the single most important outcome this app tracks — left
  // the row at 'interview'. The Pipeline board then filed it under Interview,
  // and every analytic that counts offers by status (which resume converts,
  // which model version won, campaign conversion) never saw it. Reaching the
  // offer stage is a fact about the application; what you then decided about
  // the offer is a separate field, and it is already stored as one.
  if (app.status !== 'offer') updateApplicationStatus(applicationId, 'offer')
  return { success: true }
}

function deleteOffer(applicationId) {
  run('DELETE FROM offers WHERE application_id = ?', [applicationId])
  return { success: true }
}

// Every offer worth comparing, with the numbers made comparable.
//
// Total compensation is base + bonus when a base is known. Where the user has
// not entered one, the advertised range from the application is shown instead
// and flagged as advertised — an offer compared against an advert is a
// comparison worth making, but not one to present as if both were firm.
function getOffers() {
  const rows = query(`
    SELECT o.*, a.job_title, a.company, a.platform, a.job_url, a.salary,
           a.salary_min, a.salary_max, a.status, a.applied_at, a.comment
    FROM offers o
    JOIN applications a ON a.id = o.application_id
    ORDER BY
      CASE o.decision WHEN 'considering' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
      CASE WHEN o.respond_by IS NULL OR o.respond_by = '' THEN 1 ELSE 0 END,
      o.respond_by ASC,
      o.updated_at DESC
  `)

  const today = localDateString()
  const offers = rows.map(r => {
    const total = r.base_salary == null ? null : r.base_salary + (r.bonus || 0)
    return {
      ...r,
      applicationId: r.application_id,
      totalComp: total,
      // Fall back to the advertised midpoint so a half-filled offer still sorts
      // and charts sensibly, but say which it is.
      comparableComp: total ?? midpoint(r.salary_min, r.salary_max),
      compIsAdvertised: total == null && (r.salary_min != null || r.salary_max != null),
      daysToRespond: r.respond_by ? daysBetween(today, r.respond_by) : null,
      expired: !!(r.respond_by && r.respond_by < today && r.decision === 'considering'),
    }
  })

  const live = offers.filter(o => o.decision === 'considering')
  const comps = live.map(o => o.comparableComp).filter(v => v != null)
  return {
    offers,
    // The summary the page leads with: how many decisions are open, what is at
    // stake, and what expires first.
    live: live.length,
    best: comps.length ? Math.max(...comps) : null,
    spread: comps.length >= 2 ? Math.max(...comps) - Math.min(...comps) : null,
    nextDeadline: live
      .filter(o => o.respond_by)
      .sort((a, b) => String(a.respond_by).localeCompare(String(b.respond_by)))[0] || null,
  }
}

function midpoint(lo, hi) {
  if (lo != null && hi != null) return Math.round((lo + hi) / 2)
  return lo ?? hi ?? null
}

function localDateString(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Whole days between two dates written in any format SQLite or the UI produces.
// Returns null rather than NaN when either side is missing or unparseable —
// a null is skipped by every caller, a NaN poisons an average.
function daysBetween(from, to) {
  if (!from || !to) return null
  const parse = (v) => {
    const text = String(v)
    const t = new Date(text.includes('T') || !text.includes(' ') ? text : text.replace(' ', 'T') + 'Z').getTime()
    return Number.isFinite(t) ? t : null
  }
  const a = parse(from), b = parse(to)
  if (a == null || b == null) return null
  return Math.round((b - a) / 86400000)
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function chunked(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function getScoreBandConversion() {
  const rows = query(`
    SELECT match_score, status FROM applications
    WHERE ${SENT_ONLY} AND match_score IS NOT NULL
  `)
  const bands = Array.from({ length: 10 }, (_, i) => ({
    lo: i * 10, hi: i === 9 ? 100 : i * 10 + 9,
    applied: 0, interviews: 0, offers: 0, rejected: 0,
  }))
  for (const r of rows) {
    const score = Math.max(0, Math.min(100, r.match_score))
    const b = bands[Math.min(9, Math.floor(score / 10))]
    b.applied++
    if (r.status === 'interview') b.interviews++
    else if (r.status === 'offer') b.offers++
    else if (r.status === 'rejected') b.rejected++
  }
  // An offer implies the interview stage was reached, so it counts as a
  // conversion — otherwise the best outcomes would depress the rate.
  for (const b of bands) {
    b.converted = b.interviews + b.offers
    b.conversionRate = b.applied > 0 ? Math.round((b.converted / b.applied) * 100) : null
  }
  return bands
}

// ─── Resume conversion ───────────────────────────────────────────
// Which resume actually converts. Routing rules send different jobs to
// different resumes, and the score-band histogram can't distinguish them —
// this does, so the rules in Settings can be judged on outcomes rather than
// on the assumption that they help. Rows saved before resume_id existed are
// grouped as "unattributed" rather than silently folded into the default.
function getResumeConversion() {
  const rows = query(`
    SELECT resume_id, resume_name, status, match_score FROM applications
    WHERE ${SENT_ONLY}
  `)
  const byResume = new Map()
  for (const r of rows) {
    const key = r.resume_id || '__unattributed__'
    if (!byResume.has(key)) {
      byResume.set(key, {
        resumeId: r.resume_id || null,
        name: r.resume_name || (r.resume_id ? 'Deleted resume' : 'Before tracking'),
        applied: 0, interviews: 0, offers: 0, rejected: 0, pending: 0, scoreSum: 0,
      })
    }
    const b = byResume.get(key)
    b.applied++
    b.scoreSum += r.match_score || 0
    if (r.status === 'interview') b.interviews++
    else if (r.status === 'offer') b.offers++
    else if (r.status === 'rejected') b.rejected++
    else if (r.status === 'pending') b.pending++
  }
  return [...byResume.values()].map(b => ({
    ...b,
    converted: b.interviews + b.offers,
    // Below this, a rate is noise rather than signal — the UI greys these out
    // instead of presenting a confident 0% or 100% off three applications.
    significant: b.applied >= 10,
    conversionRate: b.applied > 0 ? Math.round(((b.interviews + b.offers) / b.applied) * 100) : null,
    responseRate: b.applied > 0
      ? Math.round(((b.interviews + b.offers + b.rejected + b.pending) / b.applied) * 100)
      : null,
    avgMatchScore: b.applied > 0 ? Math.round(b.scoreSum / b.applied) : 0,
  })).sort((a, b) => b.applied - a.applied)
}

// Sent applications per arm of a résumé A/B test.
//
// Deliberately a separate query from getResumeConversion rather than a filter
// over it: that report groups by whatever résumé happened to be used, which
// includes rule-routed and pre-experiment applications. An experiment can only
// be read from applications that were actually randomised, so this counts rows
// sent since the experiment started and nothing earlier.
function getResumeExperimentArms(resumeAId, resumeBId, startedAt) {
  const arm = (resumeId) => {
    const row = queryOne(
      `SELECT COUNT(*) as sent,
              SUM(CASE WHEN status IN ('interview', 'offer') THEN 1 ELSE 0 END) as converted,
              SUM(CASE WHEN status IN ('interview', 'offer', 'rejected', 'pending') THEN 1 ELSE 0 END) as replied
       FROM applications
       WHERE resume_id = ? AND ${SENT_ONLY}${startedAt ? ' AND applied_at >= ?' : ''}`,
      startedAt ? [resumeId, startedAt] : [resumeId]
    )
    return {
      resumeId,
      sent: row?.sent || 0,
      converted: row?.converted || 0,
      replied: row?.replied || 0,
    }
  }
  return [arm(resumeAId), arm(resumeBId)]
}

// ─── AI usage & cost ─────────────────────────────────────────────

function recordAiUsage({ provider, model, operation, inputTokens = 0, outputTokens = 0, costUsd = 0 }) {
  run(
    'INSERT INTO ai_usage (provider, model, operation, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)',
    [provider || '', model || '', operation || '', inputTokens, outputTokens, costUsd]
  )
}

// Spend for the current calendar month (local time), used for the budget cap,
// plus a 30-day breakdown for the Analytics page.
function getAiUsageSummary() {
  const monthStart = "datetime('now','localtime','start of month','utc')"
  const dayStart = "datetime('now','localtime','start of day','utc')"
  const num = (sql) => queryOne(sql)?.v || 0
  return {
    today: {
      calls: num(`SELECT COUNT(*) as v FROM ai_usage WHERE called_at >= ${dayStart}`),
      cost: num(`SELECT COALESCE(SUM(cost_usd), 0) as v FROM ai_usage WHERE called_at >= ${dayStart}`),
    },
    month: {
      calls: num(`SELECT COUNT(*) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
      cost: num(`SELECT COALESCE(SUM(cost_usd), 0) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
      inputTokens: num(`SELECT COALESCE(SUM(input_tokens), 0) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
      outputTokens: num(`SELECT COALESCE(SUM(output_tokens), 0) as v FROM ai_usage WHERE called_at >= ${monthStart}`),
    },
    byOperation: query(`
      SELECT operation, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost
      FROM ai_usage WHERE called_at >= ${monthStart}
      GROUP BY operation ORDER BY cost DESC
    `),
    perDay: query(`
      SELECT DATE(called_at,'localtime') as date, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
      FROM ai_usage
      WHERE called_at >= datetime('now','localtime','start of day','-29 days','utc')
      GROUP BY DATE(called_at,'localtime') ORDER BY date ASC
    `),
  }
}

// Spend so far this calendar month, in USD. Read before every AI call when a
// budget cap is set, so the cap actually stops work rather than reporting the
// overrun afterwards.
function getMonthlyAiSpend() {
  return queryOne(
    "SELECT COALESCE(SUM(cost_usd), 0) as v FROM ai_usage WHERE called_at >= datetime('now','localtime','start of month','utc')"
  )?.v || 0
}

// Usage rows are diagnostic, not history worth keeping forever.
function pruneAiUsage(keepDays = 180) {
  try {
    run("DELETE FROM ai_usage WHERE called_at < datetime('now', '-' || ? || ' days')", [keepDays])
  } catch { /* best-effort */ }
}

function clearAiUsage() {
  run('DELETE FROM ai_usage')
  return { success: true }
}

// ─── Weekly Report Data ──────────────────────────────────────────
function getWeeklyReportData() {
  const now = new Date()
  const dayOfWeek = now.getDay() || 7 // Mon=1 ... Sun=7
  const mondayOffset = dayOfWeek - 1
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset)
  const sunday = new Date(monday.getTime() + 6 * 86400000)
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // applied_at is stored in UTC, so the query bounds are the LOCAL Monday
  // midnight converted to UTC (display labels below stay local).
  const utcStr = (d) => d.toISOString().slice(0, 19).replace('T', ' ')
  const dateFrom = utcStr(monday)
  const dateTo = utcStr(new Date(monday.getTime() + 7 * 86400000))

  // Every row in the window, so byStatus can report what was held or skipped.
  // Each headline number below is then derived from the SUBMITTED subset — a
  // weekly report that counts held jobs as applications is worse than no report.
  const rows = query('SELECT * FROM applications WHERE applied_at >= ? AND applied_at < ?', [dateFrom, dateTo])
  const byStatus = {}
  for (const a of rows) byStatus[a.status] = (byStatus[a.status] || 0) + 1

  const apps = rows.filter(a => !UNSENT_STATUSES.includes(a.status))
  const totalApps = apps.length
  const byPlatform = {}
  let matchSum = 0
  for (const a of apps) {
    byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1
    matchSum += a.match_score || 0
  }
  const interviews = (byStatus.interview || 0) + (byStatus.offer || 0)
  const responded = RESPONDED_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0)
  const unsent = rows.length - totalApps

  return {
    // Labels stay in local time — toISOString() is UTC and would shift the
    // displayed dates back a day in UTC+ timezones.
    dateFrom: localDate(monday),
    dateTo: localDate(sunday),
    totalApps,
    // Drafted but never sent this week, reported alongside rather than folded in.
    unsentApps: unsent,
    byPlatform,
    byStatus,
    avgMatchScore: totalApps > 0 ? Math.round(matchSum / totalApps) : 0,
    responseRate: totalApps > 0 ? Math.round((responded / totalApps) * 100) : 0,
    interviewRate: totalApps > 0 ? Math.round((interviews / totalApps) * 100) : 0,
    perDay: query(`SELECT DATE(applied_at,'localtime') as date, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} AND applied_at >= ? AND applied_at < ? GROUP BY DATE(applied_at,'localtime') ORDER BY date`, [dateFrom, dateTo]),
    topCompanies: query(`SELECT company, COUNT(*) as count FROM applications WHERE ${SENT_ONLY} AND applied_at >= ? AND applied_at < ? GROUP BY company ORDER BY count DESC LIMIT 5`, [dateFrom, dateTo]),
  }
}

// ─── Backups ─────────────────────────────────────────────────────
// Rotating daily backups of the SQLite file in ~/.hiro/backups (keep 7).

const BACKUP_DIR = path.join(CONFIG_DIR, 'backups')
const BACKUP_KEEP = 7

function backupStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function backupNow() {
  if (!db) return { success: false, error: 'Database not initialised yet' }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
  persist() // flush in-memory state to disk first
  const file = path.join(BACKUP_DIR, `autoapply-${backupStamp()}.db`)
  fs.copyFileSync(DB_PATH, file)
  pruneBackups()
  return { success: true, name: path.basename(file) }
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^autoapply-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
    while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()))
    prunePreRestoreSnapshots()
  } catch { /* pruning is best-effort */ }
}

// Pre-restore snapshots are stamped per restore and kept alongside the daily
// rotation. They used to be a single fixed filename, so each restore silently
// destroyed the previous escape hatch, and the date-only prune regex never
// removed them. Keep the most recent few and drop the rest.
const PRE_RESTORE_KEEP = 3
const PRE_RESTORE_RE = /^autoapply-pre-restore-[\dT-]+\.db$/

function prunePreRestoreSnapshots() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => PRE_RESTORE_RE.test(f)).sort()
    while (files.length > PRE_RESTORE_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()))
    // Remove the legacy fixed-name snapshot left by older versions.
    const legacy = path.join(BACKUP_DIR, 'autoapply-pre-restore.db')
    if (fs.existsSync(legacy) && files.length > 0) fs.unlinkSync(legacy)
  } catch { /* best-effort */ }
}

// At most one backup per local day — called on launch and on a periodic timer.
function maybeBackup() {
  try {
    if (fs.existsSync(path.join(BACKUP_DIR, `autoapply-${backupStamp()}.db`))) return { success: true, skipped: true }
    return backupNow()
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function backupFileNames() {
  if (!fs.existsSync(BACKUP_DIR)) return []
  return fs.readdirSync(BACKUP_DIR).filter(f => /^autoapply-[\w.-]+\.db$/.test(f))
}

function listBackups() {
  try {
    return backupFileNames()
      .sort().reverse()
      .map(name => {
        const file = path.join(BACKUP_DIR, name)
        const st = fs.statSync(file)
        let encrypted = false
        try {
          // Only the header is needed to classify a file; reading a 40 MB backup
          // to answer "is this encrypted" would make opening Settings slow.
          const fd = fs.openSync(file, 'r')
          try {
            const head = Buffer.alloc(dbCrypto.HEADER_BYTES)
            fs.readSync(fd, head, 0, head.length, 0)
            encrypted = dbCrypto.isEncrypted(head)
          } finally { fs.closeSync(fd) }
        } catch { /* report it as plaintext rather than failing the list */ }
        return { name, size: st.size, mtime: st.mtime.toISOString(), encrypted }
      })
  } catch {
    return []
  }
}

function restoreBackup(name) {
  // Only accept plain filenames that exist inside the backups directory.
  if (!/^autoapply-[\w.-]+\.db$/.test(name)) return { success: false, error: 'Invalid backup name' }
  const file = path.join(BACKUP_DIR, name)
  if (!fs.existsSync(file)) return { success: false, error: 'Backup not found' }
  // Keep an escape hatch: snapshot the current database before replacing it.
  // Timestamped, so restoring twice doesn't destroy the first snapshot.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let snapshot = null
  try {
    snapshot = `autoapply-pre-restore-${stamp}.db`
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, snapshot))
  } catch { snapshot = null }
  // A backup made before encryption was turned on is plaintext, and one made
  // after is not — readFile accepts either, so a restore never depends on which
  // era the file came from. It can still fail (a backup from a profile whose key
  // is gone), and that has to be reported rather than leaving an empty database.
  let data
  try {
    ({ data } = dbCrypto.readFile(file))
  } catch (err) {
    return { success: false, error: err.message, snapshot }
  }
  db = new SQL.Database(data)
  createTables()
  migrate()
  persist()
  prunePreRestoreSnapshots()
  return { success: true, snapshot }
}

// ─── Encryption at rest ──────────────────────────────────────────
// See services/dbCrypto.js for the scheme and its one unavoidable cost.

// Every file whose contents are the database: the live one and every backup.
// Turning encryption on has to cover all of them — an encrypted database beside
// seven plaintext daily backups protects nothing.
function encryptedFileSet() {
  return [DB_PATH, ...backupFileNames().map(n => path.join(BACKUP_DIR, n))]
}

function setEncryption(enabled) {
  const want = !!enabled
  if (want === !!configService.load().encryptDatabase) {
    return { success: true, unchanged: true }
  }
  // Flush first: the in-memory database is the truth, and converting a stale file
  // would lose whatever has not been written yet.
  persist()

  let result
  try {
    result = dbCrypto.convertAll(encryptedFileSet(), want)
  } catch (err) {
    return { success: false, error: err.message }
  }
  // The setting flips only after the files are already in the target state, so an
  // interrupted switch leaves files the CURRENT setting can still read.
  configService.update({ encryptDatabase: want })
  logger().append(
    `Database encryption ${want ? 'enabled' : 'disabled'} — converted ${result.converted.length} file(s)`
    + (result.failed.length ? `, ${result.failed.length} could not be converted` : '')
  )
  return { success: true, ...result, enabled: want }
}

// Lazy: logger requires config, and requiring it at the top of database.js would
// add a second edge to a module graph that is already circular through config.
function logger() {
  return require('./logger')
}

function getEncryptionStatus() {
  const status = dbCrypto.getStatus()
  const backups = listBackups()
  return {
    ...status,
    // "Enabled" is not the same as "everything is actually encrypted": a backup
    // that could not be converted is still readable plaintext, and the UI has to
    // be able to say so.
    databaseEncrypted: (() => {
      try {
        if (!fs.existsSync(DB_PATH)) return false
        const fd = fs.openSync(DB_PATH, 'r')
        try {
          const head = Buffer.alloc(dbCrypto.HEADER_BYTES)
          fs.readSync(fd, head, 0, head.length, 0)
          return dbCrypto.isEncrypted(head)
        } finally { fs.closeSync(fd) }
      } catch { return false }
    })(),
    backupCount: backups.length,
    plaintextBackups: backups.filter(b => !b.encrypted).map(b => b.name),
  }
}

function getStorageInfo() {
  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0
  const counts = {
    applications: queryOne('SELECT COUNT(*) as c FROM applications')?.c || 0,
    attentionJobs: queryOne('SELECT COUNT(*) as c FROM attention_jobs WHERE dismissed = 0')?.c || 0,
    cachedAnswers: queryOne('SELECT COUNT(*) as c FROM screening_cache')?.c || 0,
    interviewPreps: queryOne('SELECT COUNT(*) as c FROM interview_prep')?.c || 0,
    interviewEvents: queryOne('SELECT COUNT(*) as c FROM interview_events')?.c || 0,
  }
  return { dbSize, counts, encryption: getEncryptionStatus() }
}

// Prove that backups can be decrypted and opened without touching the live
// database. A byte-for-byte copy is not a recovery plan until SQLite has
// accepted it and its integrity check passes.
function drillBackups() {
  if (!SQL) return { success: false, error: 'Database not initialised yet' }
  const backups = listBackups().filter(b => /^autoapply-\d{4}-\d{2}-\d{2}\.db$/.test(b.name))
  const results = []
  for (const backup of backups) {
    const file = path.join(BACKUP_DIR, backup.name)
    let testDb = null
    try {
      const { data } = dbCrypto.readFile(file)
      testDb = new SQL.Database(data)
      const integrity = toRows(testDb.exec('PRAGMA integrity_check'))[0]
      if (!integrity || String(Object.values(integrity)[0]).toLowerCase() !== 'ok') throw new Error('SQLite integrity check failed')
      const applications = toRows(testDb.exec('SELECT COUNT(*) AS count FROM applications'))[0]?.count || 0
      results.push({ name: backup.name, success: true, applications })
    } catch (err) {
      results.push({ name: backup.name, success: false, error: err.message || String(err) })
    } finally {
      try { testDb?.close() } catch {}
    }
  }
  const report = {
    success: results.length > 0 && results.every(r => r.success),
    checkedAt: new Date().toISOString(), checked: results.length,
    failed: results.filter(r => !r.success).length, results,
  }
  if (!results.length) report.error = 'No daily backups exist yet.'
  configService.update({ lastBackupDrill: report })
  return report
}

function getBackupDrillStatus() { return configService.load().lastBackupDrill || null }

// Contacts/referrals are intentionally separate from applications: one person
// can span several roles, and a relationship should survive deleting a listing.
function getContacts() {
  return query(`SELECT * FROM contacts ORDER BY
    CASE WHEN next_action_at IS NULL OR next_action_at = '' THEN 1 ELSE 0 END,
    next_action_at ASC, updated_at DESC`)
}

function getDueContacts(date) {
  if (!date) {
    const now = new Date()
    date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  return query(`SELECT * FROM contacts WHERE next_action_at IS NOT NULL
    AND next_action_at != '' AND next_action_at <= ? ORDER BY next_action_at ASC, updated_at ASC`, [date])
}

function saveContact(input = {}) {
  const email = String(input.email || '').trim().toLowerCase().slice(0, 320)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, reason: 'Enter a valid email address.' }
  const values = [
    String(input.name || '').trim().slice(0, 160), email,
    String(input.company || '').trim().slice(0, 200), String(input.role || '').trim().slice(0, 160),
    String(input.relationship || 'recruiter').trim().slice(0, 40), String(input.notes || '').trim().slice(0, 5000),
    /^\d{4}-\d{2}-\d{2}$/.test(input.next_action_at || '') ? input.next_action_at : null,
  ]
  run(`INSERT INTO contacts (name,email,company,role,relationship,notes,next_action_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(email,company) DO UPDATE SET
    name=excluded.name, role=excluded.role, relationship=excluded.relationship,
    notes=excluded.notes, next_action_at=excluded.next_action_at, updated_at=datetime('now')`, values)
  return { success: true }
}

function deleteContact(id) { run('DELETE FROM contacts WHERE id = ?', [Number(id)]); return { success: true } }

function completeContactReminder(id) {
  run("UPDATE contacts SET next_action_at = NULL, updated_at = datetime('now') WHERE id = ?", [Number(id)])
  return { success: true }
}

function snoozeContactReminder(id, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { success: false, reason: 'Date must be YYYY-MM-DD.' }
  run("UPDATE contacts SET next_action_at = ?, updated_at = datetime('now') WHERE id = ?", [date, Number(id)])
  return { success: true }
}

function recordCampaignRun(input = {}) {
  run(`INSERT INTO campaign_runs
    (campaign_id,campaign_name,started_at,finished_at,found,applied,held,scoring_failures,ok,error)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    String(input.campaignId || ''), String(input.campaignName || ''), input.startedAt || new Date().toISOString(),
    input.finishedAt || new Date().toISOString(), Number(input.found) || 0, Number(input.applied) || 0,
    Number(input.held) || 0, Number(input.scoringFailures) || 0, input.ok === false ? 0 : 1,
    String(input.error || '').slice(0, 2000),
  ])
  return { success: true }
}

function getCampaignAnalytics() {
  const runs = query(`SELECT campaign_id,
    (SELECT newer.campaign_name FROM campaign_runs newer
      WHERE newer.campaign_id = campaign_runs.campaign_id
      ORDER BY newer.finished_at DESC, newer.id DESC LIMIT 1) AS campaign_name,
    COUNT(*) AS runs, SUM(found) AS found, SUM(applied) AS applied, SUM(held) AS held,
    SUM(scoring_failures) AS scoring_failures, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed_runs,
    MAX(finished_at) AS last_run_at FROM campaign_runs GROUP BY campaign_id`)
  const outcomes = query(`SELECT campaign_id, MAX(campaign_name) AS campaign_name,
    COUNT(*) AS applications,
    SUM(CASE WHEN status NOT IN ('held','skipped') THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN status IN ('interview','offer') THEN 1 ELSE 0 END) AS converted,
    ROUND(AVG(match_score), 1) AS avg_score
    FROM applications WHERE campaign_id IS NOT NULL AND campaign_id != '' GROUP BY campaign_id`)
  const byId = new Map(runs.map(r => [r.campaign_id, r]))
  for (const row of outcomes) {
    if (!byId.has(row.campaign_id)) {
      byId.set(row.campaign_id, {
        campaign_id: row.campaign_id, campaign_name: row.campaign_name,
        runs: 0, found: 0, applied: 0, held: 0,
        scoring_failures: 0, failed_runs: 0, last_run_at: null,
      })
    }
    const target = byId.get(row.campaign_id)
    const { campaign_name: outcomeName, ...metrics } = row
    Object.assign(target, metrics)
    if (!target.campaign_name) target.campaign_name = outcomeName
  }
  return [...byId.values()].map(row => ({
    ...row,
    conversion_rate: Number(row.sent) > 0 ? Math.round((Number(row.converted) / Number(row.sent)) * 100) : null,
  })).sort((a, b) => String(b.last_run_at || '').localeCompare(String(a.last_run_at || '')))
}

function getOptimisationInsights() {
  const stats = getStats()
  const bands = getScoreBandConversion()
  const resumes = getResumeConversion()
  const usage = getAiUsageSummary()
  const suggestions = []
  const meaningful = bands.filter(b => Number(b.applied) >= 10)
  if (meaningful.length >= 2) {
    const best = [...meaningful].sort((a, b) => Number(b.conversionRate) - Number(a.conversionRate))[0]
    suggestions.push({ kind: 'threshold', title: `Prioritise ${best.label} matches`, detail: `${best.conversionRate}% reached interview or offer across ${best.applied} applications.` })
  }
  const provenResumes = resumes.filter(r => Number(r.sent) >= 10)
  if (provenResumes.length) {
    const best = [...provenResumes].sort((a, b) => Number(b.interviewRate) - Number(a.interviewRate))[0]
    suggestions.push({ kind: 'resume', title: `${best.resume_name || 'One resume'} is converting best`, detail: `${best.interviewRate}% interview rate from ${best.sent} sent applications.` })
  }
  if (Number(usage?.month?.cost || 0) > 0 && Number(stats.totalThisWeek || 0) === 0) {
    suggestions.push({ kind: 'spend', title: 'AI spend without recent submissions', detail: 'Review blocked platforms, held drafts, and your match threshold before the next scan.' })
  }

  // Where applications die is the single most directive signal available, so it
  // belongs in the headline advice rather than only on its own panel.
  try {
    const rejection = getRejectionAnalysis()
    for (const insight of rejection.insights || []) {
      if (insight.kind === 'stage' || insight.kind === 'threshold') suggestions.push(insight)
    }
  } catch { /* insights are advisory — never let one break the page */ }

  // Which model is actually producing interviews. Only once a provider has
  // enough sent applications to mean something.
  try {
    const versions = getVersionOutcomes().filter(v => v.interviewRate != null)
    if (versions.length >= 2) {
      const best = [...versions].sort((a, b) => b.interviewRate - a.interviewRate)[0]
      const worst = [...versions].sort((a, b) => a.interviewRate - b.interviewRate)[0]
      if (best.interviewRate > worst.interviewRate) {
        suggestions.push({
          kind: 'model',
          title: `${best.label} documents are converting best`,
          detail: `${best.interviewRate}% reached interview across ${best.sent} applications, against ${worst.interviewRate}% for ${worst.label}.`,
        })
      }
    }
  } catch { /* as above */ }

  if (!suggestions.length) suggestions.push({ kind: 'sample', title: 'Keep collecting outcomes', detail: 'Hiro will recommend thresholds and resume routing once a segment has at least 10 sent applications.' })
  return suggestions
}

// ─── Whole-database export / import ──────────────────────────────
//
// The rotating backups copy the SQLite file, which on an encrypted profile is
// unreadable without this machine's keychain entry — correct for a backup, and
// useless as the escape hatch for the case where the keychain is what was lost.
// These two read the job search out as plain data and merge one back in. The
// schema knowledge lives in dataExport.js; this is just the wiring, so the
// helpers stay testable without a database.
function exportAll() {
  return dataExport.build({ query })
}

function importAll(data) {
  return dataExport.merge({ query, queryOne, run, batch }, data)
}

module.exports = {
  init, batch, pruneOrphanedRows, backfillSalaryColumns,
  getApplications, getApplicationsList, getApplication, hasJobUrl, hasAttentionJobUrl, hasSeenJobUrl,
  findRecentApplicationToCompany, insertApplication, updateApplicationStatus,
  getHeldApplications, markHeldApplied, rejectHeldApplication, holdApplicationDraft,
  recordSnapshot, getSnapshots, getSnapshot, getSnapshotDiff, compareSnapshots, restoreSnapshot,
  recordAutomationEvent, getAutomationEvents, clearAutomationEvents,
  recordSyncConflict, getSyncConflicts, countSyncConflicts, clearSyncConflicts, applyConflictResolution,
  getResumeConversion, getResumeExperimentArms, getGhostJobs,
  suppressRole, unsuppressRole, listSuppressedRoles, isRoleSuppressed,
  findJobByContent, isContentSuppressed, getSalaryBenchmark, percentileFor, recordAiUsage, getAiUsageSummary, getMonthlyAiSpend, pruneAiUsage, clearAiUsage,
  UNSENT_STATUSES,
  updateApplicationAfterApply, updateApplicationComment, updateRecruiterEmail, deleteApplication, clearAllApplications,
  getDirtyApplications, getAllApplicationIds, markCloudSynced, markCloudSeen, applyCloudEdit,
  countApplications, markAllDirty, getTombstones, clearTombstones, restoreApplicationFromCloud,
  getAttentionJobs, getAttentionJob, insertAttentionJob, dismissAttentionJob, deleteAttentionJob, clearAllAttentionJobs,
  getAllInterviewEventsForSync,
  getCachedAnswer, getCachedAnswerRecord, saveCachedAnswer, getAllCachedAnswers, deleteCachedAnswer, clearAllCachedAnswers,
  confirmCachedAnswer,
  getStats, getTodayCountByPlatform, getTodayAttentionCountByPlatform, getTodayHeldCountByPlatform, getSalaryStats,
  findDuplicateAcrossPlatforms, getApplicationsByDate, getApplicationsPerDay,
  getApplicationsForFollowUp, markFollowUpSent,
  saveFollowUpDraft, getFollowUpDrafts, getFollowUpDraft, resolveFollowUpDraft,
  stopFollowUps, resumeFollowUps,
  getApplicationsAwaitingReply, setLastReplyUid, markStaleApplications, OPEN_STATUSES,
  saveInterviewPrep, getInterviewPrep, deleteInterviewPrep,
  addInterviewEvent, upsertDetectedInterview, getInterviewEvents, getUpcomingInterviews, getInterviewEvent, deleteInterviewEvent,
  updateInterviewEventTime,
  updateClosingDate, getScoreBandConversion,
  setNextAction, completeNextAction, getDueNextActions, getPipeline, getClosingSoon, PIPELINE_STAGES,
  claimPushKey, getPushLog, prunePushLog,
  getCalendarLink, getCalendarLinks, saveCalendarLink, deleteCalendarLink, getOrphanedCalendarLinks,
  getWeeklyReportData, getStorageInfo,
  getContacts, getDueContacts, saveContact, deleteContact, completeContactReminder, snoozeContactReminder,
  recordCampaignRun, getCampaignAnalytics, getOptimisationInsights,
  saveRecruiterReply, getRecruiterReplies, getReplyContext, deleteRecruiterReplies,
  getRejectionAnalysis, rejectionStageFor,
  getVersionOutcomes, getApplicationVersionOutcome,
  saveOffer, deleteOffer, getOffers, OFFER_DECISIONS,
  getStatusHistory,
  exportAll, importAll,
  backupNow, maybeBackup, listBackups, restoreBackup, drillBackups, getBackupDrillStatus,
  setEncryption, getEncryptionStatus,
  exportRecoveryKey: () => dbCrypto.exportRecoveryKey(),
  importRecoveryKey: (text) => dbCrypto.importRecoveryKey(text),
}
