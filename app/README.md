# Hiro Mobile

Companion app for the [Hiro desktop app](../web) — check your automated job application stats, browse applications, update statuses, add notes, and trigger scans from your phone.

Connect one of two ways:

- **Local network** — the app talks directly to the desktop over your Wi-Fi. No cloud, no accounts; all data stays on your computer.
- **Cloud account** — sign in with the same Supabase account on the desktop and phone to sync your applications to the cloud, so the phone works from anywhere.

## How it works

```
Local network (LAN):
┌──────────────┐         LAN (HTTP + token)        ┌──────────────┐
│  Hiro mobile │  ───────────────────────────────▶ │ Hiro desktop │
│  (this app)  │   GET /api/stats, /applications…  │  (Electron)  │
└──────────────┘   POST /api/scan (trigger a run)  └──────────────┘

Cloud account:
┌──────────────┐                ┌──────────┐                ┌──────────────┐
│  Hiro mobile │ ◀────read────▶ │ Supabase │ ◀───mirror───▶ │ Hiro desktop │
└──────────────┘                └──────────┘                └──────────────┘
```

In LAN mode the desktop runs a small token-protected HTTP server ([web/electron/services/mobileApi.js](../web/electron/services/mobileApi.js)) on port `4823`. In cloud mode both apps sign into your Supabase project and share the `applications` table.

## Setup

1. **On the desktop app:** Settings → Notifications → **Mobile App** → enable the mobile companion server. Note the server address and pairing token shown.
2. **Install dependencies:**
   ```bash
   cd app
   npm install
   ```
3. **Run the app:**
   ```bash
   npm start          # then scan the QR code with Expo Go
   npm run ios        # iOS simulator
   npm run android    # Android emulator
   ```
4. On the Connect screen, choose **Desktop (Wi-Fi)** and enter the server IP, port, and pairing token from step 1.

Your phone and computer must be on the same network.

### Cloud account (works anywhere)

1. Follow [../supabase/SETUP.md](../supabase/SETUP.md) to create your Supabase project, table, and account.
2. Copy `.env.example` to `.env` and fill in your project's URL and anon key:
   ```bash
   cp .env.example .env
   ```
3. `npm start` (restart Expo if it was running so it picks up `.env`).
4. On the Connect screen, choose **Cloud account** and sign in with the account from step 1 — the same one you sign into on the desktop (Settings → Notifications → Cloud Sync).

## Features

- **Dashboard** — today / this week / all time counts, interviews, response rate, 7-day chart, breakdowns by status and platform (pull to refresh)
- **Applications** — searchable, filterable list of every application
- **Detail view** — match score and explanation, status updates (applied / interview / offer / rejected / skipped), notes, cover letter, screening Q&A, full job description, link to the posting
- **Settings** — connection test and re-pairing

## Tech

Expo (React Native) with minimal dependencies — no navigation library, just React state. Theme mirrors the desktop app's dark palette.
