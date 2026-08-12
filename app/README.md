# Hiro Mobile

Companion app for the [Hiro desktop app](../web) — check your automated job application stats, browse applications, update statuses, add notes, and trigger scans from your phone.

Connect one of two ways:

- **Local network** — the app talks directly to the desktop over your Wi-Fi. No cloud, no accounts; all data stays on your computer.
- **Cloud account** — sign in with the same Supabase account on the desktop and phone to sync your applications to the cloud, so the phone works from anywhere.

## How it works

```
Local network (LAN):
┌──────────────┐       signed + encrypted LAN      ┌──────────────┐
│  Hiro mobile │  ───────────────────────────────▶ │ Hiro desktop │
│  (this app)  │   GET /api/stats, /applications…  │  (Electron)  │
└──────────────┘   POST /api/scan (trigger a run)  └──────────────┘

Cloud account:
┌──────────────┐                ┌──────────┐                ┌──────────────┐
│  Hiro mobile │ ◀────read────▶ │ Supabase │ ◀───mirror───▶ │ Hiro desktop │
└──────────────┘                └──────────┘                └──────────────┘
```

In LAN mode the desktop runs a small HTTP server ([web/electron/services/mobileApi.js](../web/electron/services/mobileApi.js)) on port `4823`. One-time pairing creates a per-phone secret stored through each OS keychain. Every later request is HMAC-signed with timestamp/nonce replay protection and request/response bodies are AES-256-GCM encrypted. The shared bearer-token field exists only to migrate older installations. In cloud mode both apps sign into your Supabase project and share encrypted application records.

## Setup

1. **On the desktop app:** Settings → Notifications → **Mobile App** → enable the mobile companion server and choose **Pair a phone**.
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
4. On the Connect screen, choose **Desktop (Wi-Fi)** and scan the QR code, or enter its address and one-time code.

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
- **Follow-ups** — book or clear a next action on any submitted application, with a note. One tap for "tomorrow", "3 days", "1 week", "2 weeks". Overdue ones lead the Dashboard and show in red on the list
- **Push notifications** (cloud mode) — recruiter replies, interview reminders, follow-ups coming due, closing dates, review-queue items, failed scans and new sign-ins. Tapping one opens the application it was about
- **Settings** — connection test, re-pairing, notification toggle, and (cloud mode) permanent account deletion

## Notifications

Cloud mode only, because the delivery path runs through the shared account:

```
this phone registers an Expo push token  →  devices.push_token (Supabase)
the desktop reads the tokens             →  POST exp.host/--/api/v2/push/send
Expo forwards to APNs / FCM              →  this phone
```

There is no Hiro server anywhere in that path. **Which kinds** of notification get
sent is chosen on the desktop (Settings → Notifications); this app only decides
whether this phone receives them at all.

Permission is requested lazily — when you turn notifications on, not on first
launch. iOS shows that prompt exactly once ever, and asking before the user has
seen what the app does is how apps get denied permanently.

For a standalone build, `getExpoPushTokenAsync` needs an EAS project id. Set
`EXPO_PUBLIC_EAS_PROJECT_ID`; [app.config.js](./app.config.js) maps it to
`expo.extra.eas.projectId`. In Expo Go during development it is inferred.

## This phone on your account

The phone registers itself in the shared `devices` table on sign-in, so the
desktop's device list shows it with its session age and last contact — and can act
on it. It re-checks its own standing on **every foreground**, not just at launch:
Supabase gives a client no way to invalidate another client's session, so honouring
a revocation promptly is this side's responsibility. If the desktop has marked this
phone as signed out, it signs itself out and clears its stored session.

Signing out on purpose clears the push token first — otherwise notifications would
keep arriving on a phone that is no longer signed in.

## Permissions

Hiro asks for the camera (to scan the desktop's pairing QR code) and, if you enable
them, notifications. Nothing else.

`npm run check:permissions` asserts that against the **resolved** Expo config, not
`app.json`, because config plugins add permissions of their own — `expo-camera`
adds `RECORD_AUDIO` by default, which is how this app once requested a microphone
it never touches. CI runs the same check, so a dependency bump that reintroduces
one fails the build instead of shipping.

## Testing

```bash
npm test                    # unit suites
npm run check:permissions   # resolved-config permission audit
npm run audit:production    # fail on unreviewed production advisories
npm run check:release       # validate Supabase and EAS release environment
npx expo export --platform ios --platform android   # Metro over every module
```

The unit suites cover `src/stats.js` and `src/dates.js` — the stats/chart
derivations that must agree with the desktop, and the local-date handling. Those
two modules are CommonJS on purpose: there is no mobile test framework here, and
extracting the logic that had silently drifted from the desktop was worth more than
adding one. Anything importing `react-native` or `expo-*` needs a native runtime;
`expo export` is the closest thing to coverage for it, and it does run Metro over
every module.

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
   eas env:create --name EXPO_PUBLIC_EAS_PROJECT_ID --value your-project-id --environment production
   ```
   (The anon key is safe to ship — Row Level Security protects the data.)
5. **Re-run [../supabase/schema.sql](../supabase/schema.sql)** in your Supabase
   project so encrypted payloads, remote approvals, validation constraints, and
   the latest sync tables exist.

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
