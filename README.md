# Hiro

**Hiro** is an AI-powered desktop app that automatically finds and applies to jobs for you. It scrapes Seek, Indeed, and LinkedIn on a schedule, uses AI to score each job against your resume, tailors your application, and submits — all while you sleep.

---

## Features

### Automation
- **Multi-platform scraping** — Seek, Indeed, LinkedIn (with stealth session login)
- **AI match scoring** — rates each job against your resume (0–100%) with a one-sentence explanation of the score
- **Resume tailoring** — AI rewrites your resume to match each job description (without changing facts)
- **Cover letter generation** — AI writes a tailored cover letter with configurable tone (Professional / Casual / Confident) and optional custom template
- **Screening Q&A** — AI answers common application questions; answers are cached and reused
- **Auto-apply** — submits Seek Quick Apply, LinkedIn Easy Apply, and Indeed applications automatically
- **Resume routing** — keyword rules pick a different base resume per job type (e.g. send "data, analytics, sql" roles to your data resume); anything unmatched uses your default
- **Cross-platform duplicate detection** — skips jobs already applied to via another platform
- **Company cooldown** — after applying to a company, other roles there are skipped for a configurable window (default 30 days, 0 to disable) rather than being blocked permanently
- **Closing-date detection** — parses the application deadline out of the job ad so you can act on what expires first
- **Tech stack auto-selection** — automatically checks Seek skill/tech checkboxes matching your resume
- **Salary expectation** — fills salary fields from your configured minimum

### Scheduling
- **Configurable scan time** — set a daily scan time (Mon–Fri) in Settings
- **Auto follow-up emails** — after a configurable number of days, AI drafts and sends a follow-up for unanswered applications
- **Daily email report** — summary of applications sent to your Gmail at a configurable time
- **Inbox reply detection** — periodically scans your inbox for recruiter replies and updates each application's status (Interview / Offer / Rejected / Pending), using AI to read the email body when an AI provider is configured. Scans resume from the last check rather than re-reading the whole mailbox each time
- **Interview scheduling** — when a reply proposes a time, the date is extracted and added to an Upcoming Interviews panel on the dashboard, so you don't have to go find the email again. Always correctable, and times can be entered by hand

### Dashboard
- **Stats** — applications today, this week, all time, interviews, and response rate
- **Search** — live search by job title or company (`/` to focus)
- **Keyboard navigation** — `↑`/`↓` to move between rows, `Escape` to close detail panel
- **Export CSV** — download all applications (respects active filters)
- **Inline comments** — add notes to any application directly in the table
- **Filterable table** — filter by status and platform
- **Test Scan (dry run)** — scores and tailors every found job but never submits or saves anything, so you can tune the match threshold safely
- **Persistent activity log** — scan and apply activity is written to a log file (`~/.hiro/logs/hiro.log`) that survives restarts; view recent entries, open the full file, or clear it from the dashboard
- **Status history** — every status change is recorded and shown as a timeline in the job detail panel, so you can see how long each company took to respond
- **Desktop notifications** — OS notifications for scan completion, jobs needing attention, and recruiter replies while Hiro runs in the background (toggle in Settings)
- **Automatic backups** — the database is backed up daily (last 7 kept) to `~/.hiro/backups`, with one-click restore in Settings → Data. Each restore keeps a timestamped pre-restore snapshot (last 3)
- **Settings transfer** — export resumes, job criteria, blacklist, routing rules, and templates to a passphrase-encrypted file and restore them on another machine (Settings → Data). Credentials are excluded unless you opt in; runtime state never travels

### Job Detail Panel
- **Match explanation** — one-sentence AI summary of why the job scored the way it did
- **Interview Questions** — generate 8 likely interview questions for jobs in "Interview" status
- **Keyword Gap** — see which skills from the job posting are missing from or present in your resume
- **Blacklist Company** — instantly exclude a company from all future scans
- **Full tailored resume and screening Q&A** — download resume as DOCX

### Analytics & Timeline
- **Analytics page** — SVG bar chart of applications over the last 7 days, platform donut chart, by-status breakdown, response rate, and a match-score histogram with your apply threshold marked (for tuning it alongside Test Scan)
- **Interview rate by match score** — what share of each score band actually reached interview or offer. The histogram shows where your threshold sits; this shows whether it belongs there. Bands with too few applications to be meaningful are greyed out rather than shown as a confident 0% or 100%
- **Timeline page** — collapsible day-by-day history of all applications grouped by platform

### Settings
- **Cover letter tone** — Professional, Casual & Warm, or Confident & Direct
- **Cover letter template** — optional structural base for AI to fill in
- **Daily scan time picker** — choose exactly when the automated scan runs
- **Auto follow-up** — toggle on/off with configurable day threshold
- **Company cooldown** — how long to wait before applying to another role at the same company
- **Resume routing rules** — keyword → resume mapping, checked top to bottom

---

### Mobile Companion
- **Hiro Mobile** ([app/](app/)) — Expo React Native app, connects either over your local network **or** via the cloud
- **On-the-go dashboard** — stats, 7-day chart, status and platform breakdowns
- **Manage applications** — search, filter, update statuses, and add notes from your phone
- **Trigger a scan from your phone** — queue a scan (with optional keyword override); over LAN it runs on the desktop immediately (or the moment the desktop is next turned on), and over the cloud the desktop picks it up on its next sync cycle (~2 minutes) — so you can kick off a scan from anywhere. Requests are saved on the phone if neither is reachable and delivered automatically later
- **Watch scans live** — while the desktop scans, the phone shows a live "scanning now…" indicator (works over the cloud too) and, over Wi-Fi, a real-time feed of the desktop's activity log with a remote **Cancel scan** button
- **App Store-ready** — in-app account deletion, privacy policy, EAS build config (see [app/README.md](app/README.md))
- **Two ways to connect:**
  - **Local network (default)** — the phone talks directly to the desktop via a token-protected LAN API; no cloud involved
  - **Cloud sync (optional)** — sign in to a Supabase account on both desktop and phone to mirror applications to the cloud, so the phone works from anywhere. Your local database stays the source of truth. See [supabase/SETUP.md](supabase/SETUP.md)

---

## Repository Layout

```
Hiro/
├── web/   Desktop app — Electron + React + Vite (scraping, AI, scheduling, database)
└── app/   Mobile companion — Expo React Native (pairs with the desktop over LAN)
```

---

## Tech Stack

| Layer | Tech |
|---|---|
| Desktop shell | Electron |
| Frontend | React + Vite |
| Mobile | Expo (React Native) |
| Database | sql.js (WebAssembly SQLite, no native build required) |
| Scraping | Playwright + playwright-extra + stealth plugin (Chromium) |
| Scheduling | node-cron |
| Email | Nodemailer (Gmail SMTP) |
| AI | Claude / ChatGPT / DeepSeek / Gemini (user's choice) |

---

## Prerequisites

- **Node.js** v18+
- A supported AI provider API key (Claude, OpenAI, DeepSeek, or Gemini)
- A **Gmail App Password** for notifications (myaccount.google.com → Security → App Passwords)

---

## Setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd hiro/web

# 2. Install dependencies
npm install

# 3. Install Playwright browsers
npx playwright install chromium

# 4. Start in development mode
npm run dev
```

To set up the mobile companion app, see [app/README.md](app/README.md).

On first launch, the Setup Wizard will guide you through:
1. Choosing an AI provider and entering your API key
2. Connecting your Gmail for notifications
3. Setting job search keywords, location, salary floor, and daily limits
4. Pasting your master resume
5. Reviewing and launching

Config is stored at `~/.hiro/config.json`.

---

## Building for Distribution

```bash
cd web
npm run build
```

Output is placed in `web/dist-electron/`. Supports Windows (NSIS installer), macOS (DMG), and Linux (AppImage).

---

## Platform Login

Hiro uses full browser session storage (cookies + localStorage) for all platforms. Log in once and the session is reused for all future scrapes and applications.

### LinkedIn
1. Go to **Settings** → **LinkedIn Account** → **Login**
2. A browser window opens — log in normally
3. The window closes automatically and your session is saved

### Seek
1. Go to **Settings** → **Seek Account** → **Login**
2. Log in via the browser window that opens

### Indeed
1. Go to **Settings** → **Indeed Account** → **Login**
2. Log in via the browser window that opens (stealth mode is used to avoid bot detection)

Sessions are stored at `~/.hiro/` and reused automatically.

---

## AI Providers

| Provider | Notes |
|---|---|
| Claude (Anthropic) | Recommended. Best at resume tailoring and cover letters |
| ChatGPT (OpenAI) | GPT-4o or GPT-4-turbo work well |
| DeepSeek | Cost-effective option |
| Gemini (Google) | Enter your model name (e.g. `gemini-2.5-flash`) — check [aistudio.google.com](https://aistudio.google.com) for available models |

All AI features (match scoring, resume tailoring, cover letter, interview questions, keyword gap, follow-up email) work with any supported provider.

---

## Data & Privacy

All data (config, database, session files) is stored **locally** on your machine under `~/.hiro/`. Nothing is sent to any server except the AI API you configure and the job platforms you log into.

If you opt in to **Cloud Sync**, your applications are also mirrored to **your own** Supabase project (which you create and control). Row Level Security restricts the data to your account. Cloud sync is off until you sign in.
