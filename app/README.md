# Hiro Mobile

Companion app for the [Hiro desktop app](../web) — check your automated job application stats, browse applications, update statuses, and add notes from your phone.

The app talks directly to the desktop app over your local Wi-Fi network. **No cloud, no accounts — all data stays on your computer.**

## How it works

```
┌──────────────┐         LAN (HTTP + token)        ┌──────────────┐
│  Hiro mobile │  ───────────────────────────────▶ │ Hiro desktop │
│  (this app)  │   GET /api/stats, /applications…  │  (Electron)  │
└──────────────┘                                   └──────────────┘
```

The desktop app runs a small token-protected HTTP server ([web/electron/services/mobileApi.js](../web/electron/services/mobileApi.js)) on port `4823`.

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
4. On the Connect screen, enter the server IP, port, and pairing token from step 1.

Your phone and computer must be on the same network.

## Features

- **Dashboard** — today / this week / all time counts, interviews, response rate, 7-day chart, breakdowns by status and platform (pull to refresh)
- **Applications** — searchable, filterable list of every application
- **Detail view** — match score and explanation, status updates (applied / interview / offer / rejected / skipped), notes, cover letter, screening Q&A, full job description, link to the posting
- **Settings** — connection test and re-pairing

## Tech

Expo (React Native) with minimal dependencies — no navigation library, just React state. Theme mirrors the desktop app's dark palette.
