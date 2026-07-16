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
- **Live scan progress** — while a scan runs on the desktop, the Dashboard shows "scanning now…" and (over Wi-Fi) a live feed of the desktop's activity log, updating every few seconds; a **Cancel scan** button stops it remotely. Over the cloud the running indicator works from anywhere via the `scan_status` table.
- **Applications** — searchable, filterable list of every application
- **Detail view** — match score and explanation, status updates (applied / interview / offer / rejected / skipped), notes, cover letter, screening Q&A, full job description, link to the posting
- **Settings** — connection test, re-pairing, and (cloud mode) permanent account deletion

## Tech

Expo (React Native) with minimal dependencies — no navigation library, just React state. Theme mirrors the desktop app's dark palette.

## Publishing to the Apple App Store

The app is App Store-ready: unique bundle ID (`com.cessleigh.hiro`), full-bleed
1024×1024 icon, in-app account deletion (guideline 5.1.1(v)), a privacy policy
([PRIVACY.md](./PRIVACY.md)), and an [eas.json](./eas.json) build config.

### One-time setup

1. **Apple Developer Program** — enroll at <https://developer.apple.com/programs/enroll/> (US$99/year).
2. **Expo account** — free at <https://expo.dev>, then `npm install -g eas-cli` and `eas login`.
3. **Privacy policy URL** — already hosted on GitHub Pages (card-assets repo):
   <https://jimabby.github.io/card-assets/legal/hiro/privacy-policy.html>
   (support: `…/legal/hiro/support.html`, deletion: `…/legal/hiro/account-deletion.html`).
   Use these in the App Store Connect listing; the app's Settings screen links to them too.
4. **Cloud credentials for store builds** — `.env` is gitignored, so EAS builds
   won't include it. Set the values as EAS environment variables instead:
   ```bash
   eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://xxxx.supabase.co --environment production
   eas env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value your-anon-key --environment production
   ```
   (The anon key is safe to ship — Row Level Security protects the data.)
5. **Re-run [../supabase/schema.sql](../supabase/schema.sql)** in your Supabase
   project so the `delete_account()` function and `scan_status` table exist.

### Build and submit

```bash
cd app
eas build --platform ios --profile production   # builds in Expo's cloud — no Mac needed
eas submit --platform ios                       # uploads to App Store Connect
```

Then in [App Store Connect](https://appstoreconnect.apple.com): create the
listing (name, description, category, screenshots, privacy policy URL), fill in
the App Privacy questionnaire (no data collected by the developer; account info
stored in the user's own Supabase project), and submit for review.

### Review notes — important

Reviewers can't run the Hiro desktop app, so an empty companion app risks a
"minimum functionality" rejection. In **App Review Information**, provide a
**demo cloud account** signed into a Supabase project pre-filled with sample
applications, plus a note like: "Hiro Mobile is a companion to the Hiro desktop
app. Sign in with the demo account via 'Cloud account' to see synced data."

Each new submission needs `version` (user-facing) bumped in
[app.json](./app.json); the build number auto-increments via EAS.
