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
- **Cross-platform duplicate detection** — skips jobs already applied to via another platform
- **Tech stack auto-selection** — automatically checks Seek skill/tech checkboxes matching your resume
- **Salary expectation** — fills salary fields from your configured minimum

### Scheduling
- **Configurable scan time** — set a daily scan time (Mon–Fri) in Settings
- **Auto follow-up emails** — after a configurable number of days, AI drafts and sends a follow-up for unanswered applications
- **Daily email report** — summary of applications sent to your Gmail at 6pm

### Dashboard
- **Stats** — applications today, this week, all time, interviews, and response rate
- **Search** — live search by job title or company (`/` to focus)
- **Keyboard navigation** — `↑`/`↓` to move between rows, `Escape` to close detail panel
- **Export CSV** — download all applications (respects active filters)
- **Inline comments** — add notes to any application directly in the table
- **Filterable table** — filter by status and platform

### Job Detail Panel
- **Match explanation** — one-sentence AI summary of why the job scored the way it did
- **Interview Questions** — generate 8 likely interview questions for jobs in "Interview" status
- **Keyword Gap** — see which skills from the job posting are missing from or present in your resume
- **Blacklist Company** — instantly exclude a company from all future scans
- **Full tailored resume and screening Q&A** — download resume as DOCX

### Analytics & Timeline
- **Analytics page** — SVG bar chart of applications over the last 7 days, platform donut chart, by-status breakdown, response rate
- **Timeline page** — collapsible day-by-day history of all applications grouped by platform

### Settings
- **Cover letter tone** — Professional, Casual & Warm, or Confident & Direct
- **Cover letter template** — optional structural base for AI to fill in
- **Daily scan time picker** — choose exactly when the automated scan runs
- **Auto follow-up** — toggle on/off with configurable day threshold

---

### Mobile Companion
- **Hiro Mobile** ([app/](app/)) — Expo React Native app that pairs with the desktop over your local network
- **On-the-go dashboard** — stats, 7-day chart, status and platform breakdowns
- **Manage applications** — search, filter, update statuses, and add notes from your phone
- **Private by design** — the phone talks directly to the desktop app via a token-protected LAN API; no cloud involved

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
