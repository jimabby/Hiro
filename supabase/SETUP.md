# Cloud Sync Setup (Supabase)

Hiro can sync your applications to the cloud so the **desktop** and the **mobile app**
share one dataset — and the phone works from anywhere, not just your home Wi-Fi.

Your local SQLite database stays the desktop's source of truth. The cloud is a
mirror: the desktop pushes applications up, the phone reads/writes them, and
status/comment changes flow back to the desktop. Conflicts resolve by
last-write-wins on `updated_at`.

Sensitive application text (job descriptions, tailored resumes, cover letters,
screening answers, and recruiter email) is encrypted on the desktop before it
reaches Supabase and decrypted on signed-in Hiro clients. The initial key is
derived locally from the shared account credentials and is never uploaded.

## 1. Create a Supabase project

1. Go to <https://supabase.com> → **New project** (the free tier is plenty).
2. Once it's ready, open **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://xxxx.supabase.co`)
   - **anon / public** key

## 2. Create the database tables

1. Open **SQL Editor → New query**.
2. Paste the contents of [`schema.sql`](./schema.sql) and click **Run**.

## 3. Create your account

You log into the **same account** on both the desktop and the phone.

- In Supabase: **Authentication → Users → Add user** (email + password), or
- Sign up from the app's Cloud Sync screen if email sign-ups are enabled
  (**Authentication → Providers → Email**).

## 4. Connect the apps

**Desktop:** Settings → Cloud Sync → paste the Project URL + anon key → sign in.

**Mobile:** Cloud Sync screen → (the URL + anon key are bundled via env, see below)
→ sign in with the same account.

### Mobile env

Set the project URL and anon key for the Expo app in `app/.env`:

```
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

> The anon key is safe to ship in the client — Row Level Security is what
> protects the data, and the schema above restricts every row to its owner.

## Upgrading from an earlier schema

`schema.sql` is idempotent — just re-run the whole file in the SQL Editor
whenever it gains something new. Existing data is untouched; new objects are
added alongside. Re-running is needed if your project predates:

- `scan_requests` — triggering scans from your phone over the cloud
- `scan_status` — the phone's live "scanning now…" indicator away from home
- `delete_account()` — in-app account deletion (required for App Store release)
- `interview_events` — the phone's Upcoming Interviews panel
- `attention_jobs` — the phone's Needs Attention list and its count tile
- `offers` — the phone's Offers board, and the deadline notifications that go
  with it
- `applications.salary_min` / `salary_max` — normalised salary, so the phone
  sorts and filters on pay the same way the desktop does
- `devices` — the device list, so every desktop and phone signed in to the
  account is visible and can be signed out
- `devices.revoked_at` — per-device sign-out
- `devices.push_token` — push notifications to your phone
- `devices.app_version` / `session_started_at` — session age in the device list
- `applications.next_action_at` / `next_action_note` — the Pipeline board's
  follow-up dates, editable from the phone
- `push_log` — the notification history the desktop writes
- `applications.encrypted_payload` — end-to-end encrypted sensitive fields
- `applications.campaign_id` / `campaign_name` — campaign attribution retained during recovery sync
- `review_requests` — approve or reject held applications remotely
- validation constraints — reject unknown statuses, impossible scores, and
  oversized remote request fields

> **If you set up cloud sync before August 2026**, the `devices` policy was created
> without a preceding `drop policy if exists`, so re-running this file used to fail
> with *"policy already exists"* and stop before everything after it. That is fixed;
> the file is now re-runnable from top to bottom.

Until you re-run it, the desktop skips whatever is missing rather than failing
the whole sync — the phone simply shows nothing for those sections. The two
mirror tables are written by the desktop and read by the phone; nothing on the
phone edits them, so there is no conflict to resolve.

## Device revocation: what it actually does

Worth being precise about, because the difference matters when a phone is lost.

Supabase gives a signed-in client **no way to invalidate another client's refresh
token** — that needs the service-role admin API, which must never ship inside a
desktop or mobile app. So there are two mechanisms:

| Action | Mechanism | Reach |
|---|---|---|
| **Sign out** (one device) | Sets `devices.revoked_at` and clears that row's `push_token` | Notifications stop **immediately**. The device signs itself out the next time it connects. It cannot reach a device that is switched off |
| **Remove from list** | Deletes the row | Bookkeeping only — a device still signed in re-registers itself |
| **Sign out everywhere** | `auth.signOut({ scope: 'global' })` | **Authoritative.** Supabase invalidates every refresh token on the account server-side, including this desktop's. Use this for a lost phone |

Each client checks its own row on every sync (the desktop) or every foreground (the
phone) and honours the flag by signing itself out and wiping its stored session.

## Notifications

`devices.push_token` holds an Expo push token registered by the phone. The desktop
reads it and posts directly to Expo's push service — there is no Hiro server in the
path, and no service key is needed anywhere.

Keeping the token on the device row rather than in a table of its own is deliberate:
revoking a device revokes its notifications too, with no second place to remember.

`push_log` records what was actually sent, keyed by a dedupe key per event, so a
reminder recomputed on every two-minute sync arrives once rather than thirty times
an hour. The desktop keeps its own copy of this ledger in SQLite — that is the one
that guarantees send-once, since it must work with no network.

## Re-run `schema.sql` after updating

`schema.sql` is written to be re-runnable — every table is `create table if not
exists`, every column is `add column if not exists`, and every policy is dropped
before it is created. Running it again against an existing project is safe and is
how new columns arrive.

Three additions need it, and all of them degrade gracefully until you do:

**`encrypted_meta`** (on `applications`, `interview_events`, `attention_jobs`).
The documents were always encrypted before upload; the fields that *identify* an
application — job title, company, listing URL, match explanation, your own
comments — were not. Against the party this encryption exists for, that list is
the secret. They now travel in a second small envelope, kept apart from the
documents so the phone's list screen still loads cheaply over cellular.

A desktop on the new build writing to a project without this column will fail its
push; the phone tries the widest column set first and falls back, so an older
project keeps working read-side. Run the migration.

**`interview_events.source_zone` / `source_local`.** What timezone the recruiter
actually wrote, and their wall-clock time in it. `scheduled_at` stays the
interview in *your* local time — everything that reads it assumes that — and
these let both apps show "they wrote 14:00 AEDT" beside it, so a conversion can
be checked rather than trusted.

**`applications.status`** also gains `withdrawn`. The check constraint is dropped
and recreated, so re-running is what allows the phone and desktop to write it.

**`offers`.** The Offers board, mirrored so the phone can read it. It is here for
one reason above the others: `respond_by` is the only externally-imposed deadline
anywhere in Hiro. Every other date the apps track is one Hiro chose (a scheduled
scan, a follow-up you booked) or one that is advisory (a job ad's closing date).
Miss a respond_by and the offer is gone — and until this table existed, the page
built entirely around hoisting whichever deadline expires first could only be read
on the machine at home.

Desktop-owned and read-only on the phone, like `interview_events` and
`attention_jobs`. The deadline, the decision and the excitement rating are stored
in the clear, because the phone has to sort and colour by the deadline before it
can decrypt anything, and none of the three says who the offer is from or what it
is worth. Everything else — the base, the bonus, the employer, and your own pros,
cons and notes — goes inside `encrypted_meta`. That is a deliberate step up from
how an application's salary band is treated: a band is what an employer published,
whereas a base and bonus are what somebody is privately willing to pay *you*.

Without this table the desktop skips the mirror quietly and the phone's Offers tab
shows an empty board. Nothing else is affected.


## Companion reconciliation upgrade

Run the complete updated `schema.sql` in the Supabase SQL Editor before updating
all connected desktop and mobile clients. The script is transactional and can be
run repeatedly. This repository change does not execute it against your hosted
project.

- Applications use the cloud UUID primary key across devices. Desktop SQLite IDs
  remain local; an existing cloud row is adopted only when its job URL, company
  and title agree. Colliding local IDs restore as separate rows, preserving local
  child records. Existing review requests and mirror links migrate to cloud UUIDs.
- Each desktop owns its own interview, attention and offer mirrors. Legacy mirrors
  remain until a matching replacement is successfully uploaded; unrelated or
  unreadable legacy records are preserved.
- Comments and checklists use separate encrypted envelopes. A phone comment update
  never writes plaintext or overwrites the desktop metadata envelope. Existing
  comments in that metadata remain readable until rewritten. Follow-up dates,
  notes and completion state sync both ways; dates are stored as calendar dates.
- Upgraded clients require the new columns/indexes for writes. Older desktops
  cannot use the new mirror uniqueness constraints, so update all clients together.
  Settings → Cloud Sync → Sync health shows failures and pending uploads; retry
  after the schema upgrade. Never downgrade clients against the upgraded schema.
- If desktop and phone edit the same application between syncs, desktop values win
  and the discarded remote fields appear in the existing conflict log for recovery.

The phone's offline queue is local to the phone. Signing into a different account
or pairing to another desktop does not send the previous destination's requests.
Requests from versions that did not record a destination are shown as unknown and
can be cancelled, but are never automatically reassigned.

Regression checks cover a real SQLite database and the phone CloudClient sharing
a simulated cloud server (`web/test/companion-reconciliation.test.js`), plus queue
isolation (`app/test/scan-queue.test.js`) and renderer controls. The schema has also
been exercised on a temporary PostgreSQL instance for fresh installation, repeated
execution, and upgrade from the preceding schema.


## Schema version 2: incremental sync and row-bound encryption

Re-run the complete `schema.sql` in the SQL Editor, then update the desktop and
the phone. The script is transactional and safe to run again.

- **Schema version check.** The script now installs `hiro_schema_version()`.
  The desktop calls it before every session's first sync. A project that has not
  run this version stops syncing with a message that says to re-run
  `schema.sql`. Nothing is written in either direction until it has been.
- **Incremental pull.** `applications.synced_at` is stamped by a trigger on
  every insert and update. The desktop keeps the last value it saw, in its own
  database rather than in settings, and on each sync fetches only rows changed
  since then (rewound five minutes to cover transactions that commit out of
  order), plus a list of row ids that finds rows it has never seen and settles
  deletions. *Backfill:* adding the column stamps existing rows with the time
  of the upgrade. Each desktop's first sync afterwards downloads everything once
  and is incremental from then on. Nothing needs doing by hand.
- **Mirrors upload only what changed.** Interviews, Needs Attention and offers
  are hashed locally, and only rows whose content changed are uploaded. If the
  cloud holds a different number of rows than the desktop (for example after
  "seed the account from this device" cascaded them away), everything is
  uploaded again.
- **Encrypted envelopes are bound to their row.** Each application envelope
  (`encrypted_meta`, `encrypted_payload`, `encrypted_comment`,
  `encrypted_checklist`) now carries a context naming the table, the row's id and
  the column, authenticated as AES-GCM additional data. An envelope copied onto a
  different row or column is refused instead of shown. Envelopes written before
  this are still read, and the desktop re-uploads them in the bound form on its
  next sync. **Update the phone app together with the desktop.** An older phone
  cannot open bound envelopes and shows those rows as pending until it is
  updated. The mirror tables' envelopes are not bound yet.


## Durable command history upgrade

Stop all connected desktops, run the complete updated `schema.sql` in the SQL editor,
then install updated desktop and mobile clients before restarting sync. No service-role
key is required. This adds status, owner, error and timestamp columns to scan/review
requests, plus a unique scan request key for offline retries. Existing queued rows
receive the `queued` default. Existing application encryption remains compatible.

Requests are retained with their outcome. A desktop claims a queued row with a conditional
update and persists scan acceptance before acknowledging it. Submission receipts are
persisted before reporting completion. An interrupted submission without a receipt is
reported as uncertain and requires manual checking, never automatic resubmission.
Failed commands can be retried from Settings > Cloud Sync or the phone Dashboard.
A retry gets a new command ID. Accepted commands belong to the claiming desktop;
bring that desktop back online to continue them. Older clients must not share the queue:
they use the retired delete-on-claim protocol and would erase status history.
