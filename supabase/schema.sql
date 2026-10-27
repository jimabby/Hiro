begin;

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

-- ─── Offers ──────────────────────────────────────────────────────────────────
--
-- Mirrored for one reason above all the others: `respond_by` is the only
-- externally-imposed deadline anywhere in Hiro. Every other date the apps track
-- is one Hiro chose (a scheduled scan, a follow-up you booked) or one that is
-- advisory (a job ad's closing date, which mostly means "we will stop reading
-- applications"). Miss a respond_by and the offer is gone. Until this table
-- existed, the page built entirely around hoisting whichever deadline expires
-- first could only be read on the machine at home.
--
-- Desktop-owned, like interview_events and attention_jobs: the phone reads and
-- never writes. Accepting, declining and the negotiation draft stay on the
-- desktop — those are not decisions to take one-handed on a train.
--
-- Keyed by the application's local id, because the desktop's `offers` table is
-- itself keyed by application_id rather than carrying an id of its own. That
-- also lets a notification naming an application resolve straight to its offer.
create table if not exists public.offers (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  local_id            integer not null,   -- = the desktop's applications.id
  application_local_id integer not null,
  job_title           text,
  company             text,
  platform            text,
  -- Money. Written NULL whenever encrypted_meta is present — see the note
  -- below on why these are treated as more sensitive than an advertised band.
  currency            text,
  base_salary         integer,
  bonus               integer,
  comparable_comp     integer,
  -- Whether comparable_comp came from the offer or from the job advert. Never
  -- encrypted, even when the figure is: presenting an advertised range as
  -- though it were an offer is the one failure on this page that would actively
  -- mislead, so the flag has to survive when the number does not.
  comp_is_advertised  boolean default false,
  -- Left in the clear on purpose. The phone has to sort and colour by the
  -- deadline before it can decrypt anything, and a bare date, a decision word
  -- and a 0–5 rating say neither who the offer is from nor what it is worth.
  respond_by          text,
  start_date          text,
  decision            text default 'considering',
  excitement          integer,
  encrypted_meta      text,
  updated_at          timestamptz default now(),
  unique (user_id, local_id)
);

alter table public.offers enable row level security;

drop policy if exists "own offers" on public.offers;
create policy "own offers" on public.offers
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The phone's only ordering: soonest deadline first among live offers.
create index if not exists idx_offers_user_respond_by
  on public.offers (user_id, respond_by);

-- The base, the bonus and the user's own pros/cons/notes travel inside the same
-- envelope as everything else identifying — and they are a step more sensitive
-- than an application's salary band. That band is what an employer advertised
-- publicly; these are what somebody is privately willing to pay THIS person,
-- alongside candid writing about an employer that was never meant to leave the
-- machine.
alter table public.offers add column if not exists encrypted_meta text;

-- Companion reconciliation v2. Run this migration before updating clients.
-- Applications already have UUID primary keys; new clients no longer publish
-- installation-local integers as shared identity. Old numeric links remain for
-- historical rows until those rows are upgraded by their desktop.
alter table public.applications add column if not exists encrypted_comment text;
alter table public.applications add column if not exists encrypted_checklist text;
alter table public.applications add column if not exists next_action_done_at text;

alter table public.review_requests alter column application_local_id drop not null;
alter table public.review_requests add column if not exists application_cloud_id uuid references public.applications(id) on delete cascade;
update public.review_requests r set application_cloud_id = a.id
  from public.applications a
  where r.application_cloud_id is null and r.user_id = a.user_id
    and r.application_local_id = a.local_id;
-- The one-command-per-application index that used to be created here is now
-- partial (idx_review_requests_cloud_active, below, once the status column
-- exists). It must not be recreated here: once finished commands are kept as
-- history, a full unique index would fail on every re-run of this file.
drop index if exists public.idx_review_requests_cloud_pending;

-- Mirrors belong to an installation. A second desktop must never delete the
-- first desktop's interviews, offers, or attention queue during its own sync.
alter table public.interview_events add column if not exists source_device text not null default 'legacy';
alter table public.attention_jobs add column if not exists source_device text not null default 'legacy';
alter table public.offers add column if not exists source_device text not null default 'legacy';
alter table public.interview_events add column if not exists application_cloud_id uuid references public.applications(id) on delete cascade;
alter table public.offers add column if not exists application_cloud_id uuid references public.applications(id) on delete cascade;
alter table public.interview_events drop constraint if exists interview_events_user_id_local_id_key;
alter table public.attention_jobs drop constraint if exists attention_jobs_user_id_local_id_key;
alter table public.offers drop constraint if exists offers_user_id_local_id_key;
create unique index if not exists idx_interviews_device_local on public.interview_events(user_id, source_device, local_id);
create unique index if not exists idx_attention_device_local on public.attention_jobs(user_id, source_device, local_id);
create unique index if not exists idx_offers_device_local on public.offers(user_id, source_device, local_id);

-- Preserve old mirrors and attach their existing cloud parent before an
-- upgraded desktop stops publishing numeric application IDs. Matching legacy
-- mirrors are retired only after a replacement has been uploaded successfully.
update public.interview_events e set application_cloud_id = a.id
  from public.applications a where e.application_cloud_id is null
    and e.source_device = 'legacy' and e.user_id = a.user_id and e.application_local_id = a.local_id;
update public.offers o set application_cloud_id = a.id
  from public.applications a where o.application_cloud_id is null
    and o.source_device = 'legacy' and o.user_id = a.user_id and o.application_local_id = a.local_id;

-- A follow-up is a calendar day, never an instant in the desktop's timezone.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'applications' and column_name = 'next_action_at' and data_type = 'timestamp with time zone') then
    alter table public.applications alter column next_action_at type date
      using (next_action_at at time zone 'UTC')::date;
  end if;
end $$;

-- ─── Schema version 2: incremental pull ───────────────────────────
-- The desktop used to download every application in full on every two-minute
-- sync to find the few the phone had changed. It now asks only for rows whose
-- `synced_at` is past the last one it saw.
--
-- synced_at is stamped HERE, by a trigger, on every insert and update, never by
-- a client. updated_at cannot do this job: the phone and the desktop both write
-- it from their own clocks, so a phone running a few minutes slow would write a
-- change that sorts before the desktop's cursor and is never fetched.
--
-- Backfill: adding the column stamps every existing row with the time this
-- script ran. Nothing has to be done by hand. Each desktop's first sync after
-- the upgrade has no cursor yet, so it downloads everything once, as before,
-- and is incremental from then on.
--
-- Row identity needs no change here: `id` is already a uuid primary key that
-- both desktops and the phone use, so (user_id, id) is unique across devices.
alter table public.applications add column if not exists synced_at timestamptz not null default now();

create or replace function public.hiro_touch_synced_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

drop trigger if exists applications_touch_synced_at on public.applications;
create trigger applications_touch_synced_at
  before insert or update on public.applications
  for each row execute function public.hiro_touch_synced_at();

create index if not exists idx_apps_user_synced
  on public.applications (user_id, synced_at);

-- ─── Desktop-only mirrors: the phone reads, it does not write ─────
-- offers, interview_events, attention_jobs and push_log are written by the
-- desktop alone; the phone only ever selects from them. Their policies were
-- `for all`, so anything holding the phone's session could rewrite them — plant
-- a fake offer deadline, delete an interview, forge the push ledger so a real
-- reminder is never sent.
--
-- The limit, stated plainly: the desktop and the phone sign in as the SAME
-- Supabase user with the same anon key, so their JWTs carry the same role and
-- the same auth.uid(). Nothing in a policy can tell "the desktop" from "the
-- phone" by identity. What does differ is the session: every sign-in gets its
-- own `session_id` claim, which survives token refreshes. So:
--
--   1. The phone's devices row (kind = 'mobile') is stamped by the SERVER with
--      the session_id of the JWT that wrote it — whatever the client sends is
--      overwritten — on insert, and again whenever the phone itself heartbeats
--      (last_seen_at changes; the desktop never writes that column on a phone's
--      row, only revoked_at/push_token).
--   2. A session stamped that way may read these four tables but not write
--      them, and may not delete device rows (which would remove its own stamp).
--      A phone row cannot be re-labelled as another kind.
--
-- What this does stop: the phone app, or a stolen phone refresh token, writing
-- to these tables. What it does not: a session that never registered a phone
-- row (a phone build older than device registration, or a token used before
-- its first heartbeat), the gap after the desktop's "Remove from list" deletes
-- a phone row and before the phone re-registers, and anyone with the account
-- password, who can mint an unstamped session. Applications, scan_requests and
-- review_requests are written by the phone by design and are unchanged here.
-- Real separation would need the desktop to hold a different credential (its
-- own Supabase user, or a service-side writer), which this design deliberately
-- has no server for.
alter table public.devices add column if not exists session_id text;

create or replace function public.hiro_stamp_device_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.kind = 'mobile' and new.kind is distinct from 'mobile' then
    raise exception 'A phone''s device row cannot be re-labelled as another kind.';
  end if;
  if new.kind is distinct from 'mobile' then
    new.session_id := null;
  elsif tg_op = 'INSERT' or new.last_seen_at is distinct from old.last_seen_at then
    new.session_id := nullif(auth.jwt() ->> 'session_id', '');
  else
    -- Someone else's update (the desktop revoking the phone): keep the stamp.
    new.session_id := old.session_id;
  end if;
  return new;
end;
$$;

drop trigger if exists devices_stamp_session on public.devices;
create trigger devices_stamp_session
  before insert or update on public.devices
  for each row execute function public.hiro_stamp_device_session();

-- Security definer so a policy can consult devices without going through
-- devices' own policies; it only ever looks at the caller's rows.
create or replace function public.hiro_is_phone_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.devices d
    where d.user_id = auth.uid()
      and d.kind = 'mobile'
      and d.session_id is not null
      and d.session_id = (auth.jwt() ->> 'session_id')
  )
$$;

revoke execute on function public.hiro_is_phone_session() from public;
grant execute on function public.hiro_is_phone_session() to authenticated;

-- Who last set an application's status. The desktop refuses 'held'/'skipped'
-- from a phone (approving a sent application again would submit it twice), but
-- the same values arriving from ANOTHER desktop are legitimate — an Undo on one
-- desktop must not be pushed back over by the next. Set by the server from the
-- session, never by the client, so a phone cannot label its own edit as a
-- desktop's. A phone build that never registered a devices row is not
-- recognised as a phone; see the limits above.
alter table public.applications add column if not exists status_set_by text;

-- An application's advertised closing date, for the phone's Today screen.
alter table public.applications add column if not exists closing_date text;

create or replace function public.hiro_stamp_status_setter()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_set_by := case when public.hiro_is_phone_session() then 'phone' else 'desktop' end;
  else
    new.status_set_by := old.status_set_by;
  end if;
  return new;
end;
$$;

drop trigger if exists applications_stamp_status_setter on public.applications;
create trigger applications_stamp_status_setter
  before insert or update on public.applications
  for each row execute function public.hiro_stamp_status_setter();

drop policy if exists "own devices" on public.devices;
drop policy if exists "read own devices" on public.devices;
drop policy if exists "add own devices" on public.devices;
drop policy if exists "update own devices" on public.devices;
drop policy if exists "remove own devices from a non-phone session" on public.devices;
create policy "read own devices" on public.devices
  for select using (auth.uid() = user_id);
create policy "add own devices" on public.devices
  for insert with check (auth.uid() = user_id);
create policy "update own devices" on public.devices
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "remove own devices from a non-phone session" on public.devices
  for delete using (auth.uid() = user_id and not public.hiro_is_phone_session());

do $$
declare
  t text;
  old_policy text;
begin
  foreach t in array array['offers', 'interview_events', 'attention_jobs', 'push_log'] loop
    old_policy := case t
      when 'offers' then 'own offers'
      when 'interview_events' then 'own interview events'
      when 'attention_jobs' then 'own attention jobs'
      when 'push_log' then 'own push log'
    end;
    execute format('drop policy if exists %I on public.%I', old_policy, t);
    execute format('drop policy if exists %I on public.%I', 'read own ' || t, t);
    execute format('drop policy if exists %I on public.%I', 'desktop inserts ' || t, t);
    execute format('drop policy if exists %I on public.%I', 'desktop updates ' || t, t);
    execute format('drop policy if exists %I on public.%I', 'desktop deletes ' || t, t);
    execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', 'read own ' || t, t);
    execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id and not public.hiro_is_phone_session())', 'desktop inserts ' || t, t);
    execute format('create policy %I on public.%I for update using (auth.uid() = user_id and not public.hiro_is_phone_session()) with check (auth.uid() = user_id and not public.hiro_is_phone_session())', 'desktop updates ' || t, t);
    execute format('create policy %I on public.%I for delete using (auth.uid() = user_id and not public.hiro_is_phone_session())', 'desktop deletes ' || t, t);
  end loop;
end $$;

-- What this file installs, so a client can tell a project that missed an
-- upgrade from one that is broken. The desktop calls this before it syncs and,
-- when the number is behind what it needs, tells the user to re-run this file
-- rather than failing on whichever column it happens to touch first.
-- Bump the number whenever this file gains something a client depends on, and
-- REQUIRED_CLOUD_SCHEMA in web/electron/services/cloudSync.js with it.
-- Durable phone commands: retain requests and outcomes instead of deleting on claim.
-- Upgrade all clients together; older desktops use the retired delete-on-claim protocol.
alter table public.scan_requests add column if not exists status text not null default 'queued';
alter table public.scan_requests add column if not exists claimed_by text;
alter table public.scan_requests add column if not exists error text not null default '';
alter table public.scan_requests add column if not exists updated_at timestamptz not null default now();
alter table public.review_requests add column if not exists status text not null default 'queued';
alter table public.review_requests add column if not exists claimed_by text;
alter table public.review_requests add column if not exists error text not null default '';
alter table public.review_requests add column if not exists updated_at timestamptz not null default now();
create index if not exists idx_scan_commands_status on public.scan_requests(user_id, status);
create index if not exists idx_review_commands_status on public.review_requests(user_id, status);

-- One decision the desktop may still act on per application, not one row ever.
-- A full unique index kept a finished command forever and blocked every later
-- decision on the same draft (reject → desktop Undo → the phone could never
-- decide again). Finished rows stay as history; a new decision inserts a new
-- row, and changing a still-waiting decision updates that row (with a new id)
-- in place. 'cancelled' rows, set by the phone before the desktop starts one,
-- are finished too. RLS is unchanged: "own review requests" scopes every row
-- to auth.uid() = user_id for select, insert, update and delete.
create unique index if not exists idx_review_requests_cloud_active
  on public.review_requests(user_id, application_cloud_id)
  where status in ('queued', 'accepted', 'running');
do $$ begin
  alter table public.review_requests add constraint review_requests_status_valid
    check (status in ('queued', 'accepted', 'running', 'completed', 'failed', 'cancelled')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.scan_requests add constraint scan_requests_status_valid
    check (status in ('queued', 'accepted', 'running', 'completed', 'failed', 'cancelled')) not valid;
exception when duplicate_object then null; end $$;

alter table public.scan_requests add column if not exists request_key text;
create unique index if not exists idx_scan_request_key on public.scan_requests(user_id, request_key);

-- Version 4: phone commands can be changed or cancelled before the desktop starts
-- them, and finished review commands no longer block a new decision.
create or replace function public.hiro_schema_version()
returns integer
language sql
immutable
set search_path = ''
as $$ select 4 $$;

revoke execute on function public.hiro_schema_version() from public;
grant execute on function public.hiro_schema_version() to anon, authenticated;

commit;
