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
