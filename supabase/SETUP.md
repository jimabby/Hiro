# Cloud Sync Setup (Supabase)

Hiro can sync your applications to the cloud so the **desktop** and the **mobile app**
share one dataset — and the phone works from anywhere, not just your home Wi-Fi.

Your local SQLite database stays the desktop's source of truth. The cloud is a
mirror: the desktop pushes applications up, the phone reads/writes them, and
status/comment changes flow back to the desktop. Conflicts resolve by
last-write-wins on `updated_at`.

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
- `applications.salary_min` / `salary_max` — normalised salary, so the phone
  sorts and filters on pay the same way the desktop does

Until you re-run it, the desktop skips whatever is missing rather than failing
the whole sync — the phone simply shows nothing for those sections. The two
mirror tables are written by the desktop and read by the phone; nothing on the
phone edits them, so there is no conflict to resolve.
