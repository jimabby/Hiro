# Hiro

**Hiro** is an AI-powered desktop app that automatically finds and applies to jobs for you. It scrapes Seek, Indeed, and LinkedIn on a schedule, uses AI to score each job against your resume, tailors your application, and submits — all while you sleep.

---

## Features

- **Multi-platform scraping** — Seek, Indeed, LinkedIn (with session login)
- **AI match scoring** — rates each job against your resume (0–100%). Skips jobs below your threshold
- **Resume tailoring** — AI rewrites your resume to match each job description (without changing facts)
- **Screening Q&A** — AI answers common application questions
- **Auto-apply** — submits LinkedIn Easy Apply applications automatically
- **Email notifications** — Gmail alerts for jobs needing attention and daily summary reports
- **Scheduled runs** — scans hourly 9am–5pm, daily report at 6pm
- **Full job history** — every application (including skipped ones) stored locally with status tracking
- **LinkedIn session** — log in once via a real browser; cookies are saved for future scraping
- **Stop scan** — cancel a running scan at any time from the dashboard

---

## Tech Stack

| Layer | Tech |
|---|---|
| Desktop shell | Electron |
| Frontend | React + Vite |
| Database | sql.js (WebAssembly SQLite, no native build required) |
| Scraping | Playwright (Chromium) |
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
cd hiro

# 2. Install dependencies
npm install

# 3. Install Playwright browsers
npx playwright install chromium

# 4. Start in development mode
npm run dev
```

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
npm run build
```

Output is placed in `dist-electron/`. Supports Windows (NSIS installer), macOS (DMG), and Linux (AppImage).

---

## LinkedIn Login

To enable LinkedIn scraping and Easy Apply:

1. Go to **Settings** in the app
2. Click **Login to LinkedIn**
3. A browser window opens — log in normally
4. The window closes automatically and your session is saved

Session cookies are stored at `~/.hiro/linkedin-cookies.json` and reused for all subsequent scrapes.

---

## AI Providers

| Provider | Notes |
|---|---|
| Claude (Anthropic) | Recommended. Best at resume tailoring |
| ChatGPT (OpenAI) | GPT-4o or GPT-4-turbo work well |
| DeepSeek | Cost-effective option |
| Gemini (Google) | Enter your model name (e.g. `gemini-2.5-flash`) — check [aistudio.google.com](https://aistudio.google.com) for available models |

---

## Dashboard

- **Stats** — applications today, this week, all time, and interviews
- **Jobs table** — filterable by status and platform; click any row for full details including tailored resume and screening Q&A
- **Activity log** — real-time log of the current scan
- **Run Scan Now** / **Stop Scan** — manual control

---

## Data & Privacy

All data (config, database, cookies) is stored **locally** on your machine under `~/.hiro/`. Nothing is sent to any server except the AI API you configure.
