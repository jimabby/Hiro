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

-- Devices attached to this account, so the user can see what is syncing and
-- revoke anything they no longer control — a laptop that was sold, a phone that
-- was lost. Without a registry, a leaked refresh token is invisible and there is
-- nothing to revoke it from.
--
-- Keyed by (user_id, device_id) where device_id is generated once on the device
-- and never regenerated. Deleting a row here does not by itself invalidate that
-- device's Supabase session; it removes the device's standing on the account and
-- is what the desktop's trusted-device list reads. Rotate the account password
-- to force every session to re-authenticate.
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

create policy "own devices" on public.devices
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_devices_user_seen
  on public.devices (user_id, last_seen_at desc);
