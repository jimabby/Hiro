-- Hiro cloud sync schema (Supabase / Postgres)
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
--
-- The desktop app mirrors its local SQLite `applications` into this table, and
-- the phone reads/writes here directly, so both devices share one dataset over
-- the cloud. Row Level Security scopes every row to the signed-in user, so a
-- user only ever sees their own applications.

create table if not exists public.applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  local_id      integer,            -- the desktop's local SQLite row id (per user)
  job_title     text not null,
  company       text not null,
  platform      text not null,
  salary        text,
  job_url       text,
  job_description text,
  match_score   integer,
  match_explanation text,
  tailored_resume text,
  cover_letter  text,
  screening_qa  text,
  comment       text default '',
  recruiter_email text default '',
  status        text default 'applied',
  applied_at    timestamptz,
  updated_at    timestamptz default now(),
  unique (user_id, local_id)
);

alter table public.applications enable row level security;

-- A user can read and write only their own rows.
drop policy if exists "own applications" on public.applications;
create policy "own applications" on public.applications
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_apps_user_updated
  on public.applications (user_id, updated_at desc);

-- Scan requests queued from the phone while away from the home LAN. The phone
-- inserts a row; the desktop picks pending rows up during its periodic cloud
-- sync (every ~2 minutes), queues the scan locally, and deletes the row.
create table if not exists public.scan_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  keywords      text default '',
  location      text default '',
  created_at    timestamptz default now()
);

alter table public.scan_requests enable row level security;

drop policy if exists "own scan requests" on public.scan_requests;
create policy "own scan requests" on public.scan_requests
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_scan_requests_user
  on public.scan_requests (user_id, created_at);

-- Live scan indicator. The desktop upserts its row when a scan starts/finishes
-- so the phone can show "scanning now…" from anywhere (one row per user).
create table if not exists public.scan_status (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  running       boolean not null default false,
  updated_at    timestamptz default now()
);

alter table public.scan_status enable row level security;

drop policy if exists "own scan status" on public.scan_status;
create policy "own scan status" on public.scan_status
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Upcoming interviews, mirrored so the phone can show the same "Upcoming
-- Interviews" panel the desktop does. The desktop is the only writer; the phone
-- reads. Keyed by the desktop's local interview_events row id per user.
create table if not exists public.interview_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  local_id      integer not null,   -- the desktop's local interview_events row id
  application_local_id integer,     -- the applications.local_id it belongs to
  scheduled_at  text not null,      -- local "YYYY-MM-DD HH:MM:SS", as stored on the desktop
  has_time      boolean default true,
  source        text default 'manual',
  note          text default '',
  job_title     text,
  company       text,
  platform      text,
  updated_at    timestamptz default now(),
  unique (user_id, local_id)
);

alter table public.interview_events enable row level security;

drop policy if exists "own interview events" on public.interview_events;
create policy "own interview events" on public.interview_events
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_interviews_user_when
  on public.interview_events (user_id, scheduled_at);

-- Jobs that need a manual application. Mirrored read-only so the phone can show
-- the same queue (and its count) instead of hiding the tile.
create table if not exists public.attention_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  local_id      integer not null,   -- the desktop's local attention_jobs row id
  job_title     text not null,
  company       text not null,
  platform      text not null,
  salary        text,
  salary_min    integer,
  salary_max    integer,
  job_url       text,
  match_score   integer,
  talking_points text,
  reason        text,
  closing_date  text,
  found_at      timestamptz,
  updated_at    timestamptz default now(),
  unique (user_id, local_id)
);

alter table public.attention_jobs enable row level security;

drop policy if exists "own attention jobs" on public.attention_jobs;
create policy "own attention jobs" on public.attention_jobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_attention_user_found
  on public.attention_jobs (user_id, found_at desc);

-- Normalised salary range, mirrored alongside the free-text `salary` so the
-- phone can sort and filter on it the same way the desktop does.
alter table public.applications add column if not exists salary_min integer;
alter table public.applications add column if not exists salary_max integer;

-- Which resume was actually sent, so the phone can show it and the desktop's
-- "which resume converts" analysis survives a restore from the cloud.
alter table public.applications add column if not exists resume_id text;
alter table public.applications add column if not exists resume_name text;

-- Review mode: when this is set, the row was drafted but NOT submitted. The
-- phone shows these as "Held for review" and must keep them out of response
-- and interview rates, exactly as the desktop does.
alter table public.applications add column if not exists held_at timestamptz;
alter table public.applications add column if not exists encrypted_payload text;
alter table public.applications add column if not exists campaign_id text;
alter table public.applications add column if not exists campaign_name text;

-- In-app account deletion (required by Apple App Store guideline 5.1.1(v)).
-- Runs as the function owner (security definer) so a signed-in user can delete
-- their OWN auth record; the on-delete-cascade foreign keys above then remove
-- all of their applications, scan requests, and scan status automatically.
create or replace function public.delete_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- Devices attached to this account, so the user can see what is syncing and cut
-- off anything they no longer control — a laptop that was sold, a phone that was
-- lost. Every device registers itself here on sign-in: the desktop from
-- cloudSync.registerDevice, the phone from src/deviceRegistry.js.
--
-- Keyed by (user_id, device_id) where device_id is generated once on the device
-- and never regenerated.
--
-- How revocation actually works. Supabase gives a signed-in client no way to
-- invalidate ANOTHER client's refresh token — that needs the service-role admin
-- API, which must never ship inside a desktop or mobile app. So there are two
-- mechanisms, and the UI is explicit about which one it is offering:
--
--   1. Revoke one device (cooperative). `revoked_at` is stamped here. Every
--      client checks its own row on each sync and, when it finds the stamp,
--      signs itself out and wipes its stored session. Effective for a device
--      that is still running and online; it does nothing for one that is
--      switched off or has been wiped of network access.
--   2. Sign out everywhere (authoritative). The signed-in client calls
--      auth.signOut({ scope: 'global' }), which Supabase honours server-side by
--      invalidating every refresh token on the account, including its own. This
--      is the one to use for a lost phone, and it is what the desktop offers
--      alongside per-device revocation.
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  device_id     text not null,
  name          text,
  platform      text,
  kind          text default 'desktop',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (user_id, device_id)
);

alter table public.devices enable row level security;

-- Every other policy in this file is dropped before being created so the script
-- can be re-run against an existing project. This one was not, so re-running the
-- documented upgrade failed with "policy already exists" and stopped before the
-- statements below it.
drop policy if exists "own devices" on public.devices;
create policy "own devices" on public.devices
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_devices_user_seen
  on public.devices (user_id, last_seen_at desc);

-- Cooperative revocation (mechanism 1 above). Set by whichever device the user
-- clicked "Revoke" on; cleared by the revoked device as it signs itself out.
alter table public.devices add column if not exists revoked_at timestamptz;

-- App version and the client's own idea of when it signed in, so the device list
-- can show session age and spot a client that stopped checking in.
alter table public.devices add column if not exists app_version text;
alter table public.devices add column if not exists session_started_at timestamptz;

-- Expo push token, registered by the phone. The desktop reads these to send
-- notifications directly through Expo's push service — there is no Hiro server
-- in the path. A token is device-scoped, so revoking a device removes its
-- ability to receive notifications along with everything else.
alter table public.devices add column if not exists push_token text;
alter table public.devices add column if not exists push_enabled boolean default true;

-- ─── Follow-up pipeline ───────────────────────────────────────────
-- The next thing the user has to DO about an application, and when. Mirrored so
-- the phone's pipeline and the desktop's board agree, and so an overdue
-- follow-up can be pushed to the phone.
alter table public.applications add column if not exists next_action_at timestamptz;
alter table public.applications add column if not exists next_action_note text;

-- ─── Push notification ledger ─────────────────────────────────────
-- One row per notification actually delivered, so a reminder is sent once rather
-- than on every sync cycle, and so the phone can show a history. The desktop is
-- the only writer.
create table if not exists public.push_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          text not null,      -- 'reply' | 'interview' | 'expiring' | 'scan-failed' | 'review' | 'new-device'
  dedupe_key    text not null,      -- e.g. 'interview:41:2026-08-09' — unique per user
  title         text,
  body          text,
  sent_at       timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

alter table public.push_log enable row level security;

drop policy if exists "own push log" on public.push_log;
create policy "own push log" on public.push_log
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_push_log_user_sent
  on public.push_log (user_id, sent_at desc);

-- Phone-to-desktop approval commands. The phone cannot submit an application
-- itself because only the desktop owns the authenticated browser session. It
-- queues an explicit one-shot command; the desktop claims it by deleting the
-- row and then performs the normal guarded approval path.
create table if not exists public.review_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  application_local_id integer not null,
  action text not null check (action in ('approve', 'reject')),
  created_at timestamptz not null default now(),
  unique (user_id, application_local_id, action)
);
alter table public.review_requests enable row level security;
drop policy if exists "own review requests" on public.review_requests;
create policy "own review requests" on public.review_requests for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists idx_review_requests_user_created
  on public.review_requests (user_id, created_at);
-- One application has one pending decision. Upserting a changed decision from
-- the phone replaces the previous choice instead of executing both.
create unique index if not exists idx_review_requests_one_pending
  on public.review_requests (user_id, application_local_id);

-- Enforce the same invariants at the cloud boundary that both clients enforce
-- in their UI. Constraints are NOT VALID first so an older project can re-run
-- this migration, inspect legacy rows, and validate separately if necessary.
do $$ begin
  alter table public.applications add constraint applications_status_valid
    check (status in ('applied','interview','offer','rejected','pending','no_response','skipped','held')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.applications add constraint applications_score_valid
    check (match_score is null or match_score between 0 and 100) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.scan_requests add constraint scan_request_size_valid
    check (char_length(keywords) <= 500 and char_length(location) <= 160) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.devices add constraint device_fields_valid
    check (char_length(device_id) <= 200 and char_length(coalesce(name,'')) <= 160 and char_length(coalesce(platform,'')) <= 80) not valid;
exception when duplicate_object then null; end $$;

-- ─── Encrypted metadata ───────────────────────────────────────────
-- The documents (job description, tailored resume, cover letter, screening
-- answers, recruiter address) have always been encrypted on the device before
-- upload, in `applications.encrypted_payload`. The fields that IDENTIFY an
-- application were not: job title, company, job URL, the match explanation and
-- the user's own comment all sat here in clear, as did the denormalised title
-- and company on interview_events and attention_jobs.
--
-- Against the party this encryption exists to defend against — someone who
-- wants to know that you are job-hunting, and where — that list is the secret.
-- The documents are almost the least of it.
--
-- `encrypted_meta` closes it. It is deliberately a SECOND envelope rather than
-- an extension of encrypted_payload: the phone's list screen fetches meta for
-- every row and payload only for the row actually opened, so titles and
-- companies still arrive over cellular without dragging every cover letter
-- along. Both use the same device-derived data key; the server holds neither.
--
-- The plaintext columns are left in place and written empty. An older client
-- that does not know about encrypted_meta then shows blank rows — which reads
-- as "this client is out of date" — rather than a plausible placeholder, which
-- would read as data loss.
alter table public.applications     add column if not exists encrypted_meta text;
alter table public.interview_events add column if not exists encrypted_meta text;
alter table public.attention_jobs   add column if not exists encrypted_meta text;

-- The timezone the employer wrote, and their wall-clock time in it.
-- `scheduled_at` is the interview converted to the user's own local time, which
-- is what every reader of it assumes; these preserve what was actually written
-- so the apps can show both and the conversion can be checked rather than
-- trusted. NULL means the email named no zone.
alter table public.interview_events add column if not exists source_zone text;
alter table public.interview_events add column if not exists source_local text;

-- 'withdrawn' — the user pulled out after applying (took another offer, or
-- decided against the role). Deliberately its own status rather than 'rejected'
-- (which would misattribute the decision to the employer, and would land in the
-- rejection-stage analysis whose whole purpose is to say whether the resume or
-- the interview is the problem) or 'skipped' (which would deny it was ever
-- sent). Both clients count it as sent but exclude it from the response and
-- interview rate denominators.
--
-- The existing constraint has to be replaced rather than added to.
alter table public.applications drop constraint if exists applications_status_valid;
do $$ begin
  alter table public.applications add constraint applications_status_valid
    check (status in ('applied','interview','offer','rejected','pending','no_response','skipped','held','withdrawn')) not valid;
exception when duplicate_object then null; end $$;
