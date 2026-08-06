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
- `devices` — the device list, so every desktop and phone signed in to the
  account is visible and can be signed out
- `devices.revoked_at` — per-device sign-out
- `devices.push_token` — push notifications to your phone
- `devices.app_version` / `session_started_at` — session age in the device list
- `applications.next_action_at` / `next_action_note` — the Pipeline board's
  follow-up dates, editable from the phone
- `push_log` — the notification history the desktop writes

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
