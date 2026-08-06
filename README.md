# Hiro

**Hiro** is an AI-powered desktop app that automatically finds and applies to jobs for you. It scrapes Seek, Indeed, and LinkedIn on a schedule, uses AI to score each job against your resume, tailors your application, and submits — all while you sleep.

---

## Features

### Automation
- **Multi-platform scraping** — Seek, Indeed, LinkedIn (with stealth session login), walking a configurable number of result pages per scan (default 3) so repeat scans keep finding new listings instead of re-reading the same first page
- **Company career boards** — watch specific employers directly on Greenhouse, Lever or Ashby. These publish structured JSON, need no login, and have no bot defenses, so they're far steadier than the aggregators. Their application forms are custom per company and can't be automated, so matches land in Needs Attention with the tailored resume and cover letter already written. Boards are validated when you add them, so a typo in the slug is caught immediately rather than as an empty scan three days later
- **Review before submit** *(optional)* — draft everything, send nothing. Jobs clearing the match threshold are fully prepared and held on the Review page until you approve them. Approving submits the documents already written, so it costs no extra AI calls. Rejecting files the job as skipped so it isn't re-drafted
- **Runs in the background** — closing the window minimises to the tray instead of quitting, so scheduled scans, inbox checks, follow-ups and the stale sweep keep running. Optional launch-on-login and start-minimised
- **Reliable AI calls** — model calls are retried with exponential backoff (honouring `Retry-After`), and a permanent failure such as a bad API key is not retried. A job that still can't be scored is **left unsaved and retried next scan** rather than recorded with a fabricated score
- **Spend cap and cost meter** — per-call token usage and estimated cost are recorded and broken down by operation on the Analytics page. An optional monthly cap is checked *before* each call, so it stops work rather than reporting the overrun afterwards
- **Block detection** — a CAPTCHA, rate-limit page, or expired login is reported as *blocked* rather than as "found 0 jobs", so a silently throttled scan is visible instead of looking like an empty market
- **AI match scoring** — rates each job against your resume (0–100%) with a one-sentence explanation of the score
- **Resume tailoring** — AI rewrites your resume to match each job description (without changing facts)
- **Cover letter generation** — AI writes a tailored cover letter with configurable tone (Professional / Casual / Confident) and optional custom template
- **Screening Q&A** — AI answers common application questions; answers are cached and reused
- **Auto-apply** — submits Seek Quick Apply, LinkedIn Easy Apply, and Indeed applications automatically
- **Resume routing** — keyword rules pick a different base resume per job type (e.g. send "data, analytics, sql" roles to your data resume); anything unmatched uses your default
- **Cross-platform duplicate detection** — skips jobs already applied to via another platform, and recognises jobs already sitting in Needs Attention so a failed apply isn't re-scored, re-tailored and re-queued on every subsequent scan
- **Daily limits count what was actually sent** — jobs scored below the threshold, or held for review, don't consume the per-platform daily allowance
- **Recruiter contact extraction** — pulls a follow-up address out of the job ad, and out of any recruiter reply. Platform, no-reply and placeholder addresses are ignored, and an ambiguous ad yields nothing rather than a guess. Without this, auto follow-up skipped every application because nothing ever filled the field in
- **Company cooldown** — after applying to a company, other roles there are skipped for a configurable window (default 30 days, 0 to disable) rather than being blocked permanently
- **Closing-date detection** — parses the application deadline out of the job ad so you can act on what expires first, and it's editable in the job detail panel when the ad didn't state one (or stated it oddly)
- **Screening Q&A recorded** — the answers submitted on your behalf are saved against the application, labelled by whether the AI wrote them, you did, or they were reused from the cache
- **Salary normalisation** — the advertised salary is parsed into an annual range, so an hourly rate and a package are comparable, and pay becomes filterable and sortable
- **Tech stack auto-selection** — automatically checks Seek skill/tech checkboxes matching your resume
- **Salary expectation** — fills salary fields from your configured minimum

### Scheduling
- **Configurable scan time** — set a daily scan time (Mon–Fri) in Settings
- **Auto follow-up emails** — after a configurable number of days, AI drafts and sends a follow-up for unanswered applications
- **Daily email report** — summary of applications sent to your Gmail at a configurable time
- **Inbox reply detection** — scans your inbox for recruiter replies on a configurable cadence (every 2 hours, every day of the week by default) and updates each application's status (Interview / Offer / Rejected / Pending), using AI to read the email body when an AI provider is configured. Scans resume from the last check rather than re-reading the whole mailbox each time, and applications marked Pending or No Response stay in scope — a later email that finally schedules an interview is still picked up. The newest matching email wins, and each one is only classified once
- **Stale application sweep** — after a configurable number of days with no reply (default 45), an application moves to **No Response** so it stops dragging down your response rate. Nothing is deleted, and the inbox keeps watching it in case a late reply arrives
- **Interview scheduling** — when a reply proposes a time, the date is extracted and added to an Upcoming Interviews panel on the dashboard, so you don't have to go find the email again. Always correctable, and times can be entered by hand
- **Calendar export** — export upcoming interviews (all of them, or one) as a standard `.ics` file that Calendar, Outlook, and Google all import. Auto-detected times are marked tentative so an unverified parse doesn't look like a confirmed commitment

### Dashboard
- **Stats** — applications today, this week, all time, interviews, response rate (any reply at all) and interview rate (reached interview or offer)
- **Salary filter and sort** — filter the table by annual pay range and sort on it, using the normalised figures rather than the raw text
- **Search** — live search by job title or company (`/` to focus)
- **Keyboard navigation** — `↑`/`↓` to move between rows, `Escape` to close detail panel
- **Export CSV** — download all applications (respects active filters), including the normalised salary range and closing date, with spreadsheet formula injection neutralised
- **Inline comments** — add notes to any application directly in the table
- **Filterable table** — filter by status and platform
- **Test Scan (dry run)** — scores and tailors every found job but never submits or saves anything, so you can tune the match threshold safely
- **Persistent activity log** — scan and apply activity is written to a log file (`~/.hiro/logs/hiro.log`) that survives restarts; view recent entries, open the full file, or clear it from the dashboard
- **Status history** — every status change is recorded and shown as a timeline in the job detail panel, so you can see how long each company took to respond
- **Desktop notifications** — OS notifications for scan completion, jobs needing attention, and recruiter replies while Hiro runs in the background (toggle in Settings)
- **Automatic backups** — the database is backed up daily (last 7 kept) to `~/.hiro/backups`, with one-click restore in Settings → Data. Each restore keeps a timestamped pre-restore snapshot (last 3)
- **Settings transfer** — export resumes, job criteria, blacklist, routing rules, and templates to a passphrase-encrypted file and restore them on another machine (Settings → Data). Credentials are excluded unless you opt in; runtime state never travels

### Pipeline
The rest of the app answers "what happened". This page answers the question that
actually loses people offers: **what do I owe, and when?**

- **Follow-up dates** — book a next action on any submitted application, with a note. One click for "tomorrow", "in 3 days", "next week"
- **Overdue and due-today are hoisted out of the columns** — a board where the urgent thing is buried in column three is a board nobody acts on
- **Columns derived from status** — Applied / No reply yet / Interviewing / Offer / Closed, derived rather than stored, so the board can never disagree with the status shown everywhere else
- **Gone-quiet nudge** — a row nobody has touched in a while with nothing booked is flagged. Silence is exactly what this exists to catch (configurable; 0 disables)
- **Upcoming interviews ride along** on the card they belong to
- **Held and skipped drafts are excluded** — nothing was ever sent, so there is nothing to chase
- Follow-ups are editable **from the phone** too, and an overdue one can push a notification

### Job Detail Panel
- **Match explanation** — one-sentence AI summary of why the job scored the way it did
- **Interview Questions** — generate 8 likely interview questions for jobs in "Interview" status
- **Keyword Gap** — see which skills from the job posting are missing from or present in your resume
- **Blacklist Company** — instantly exclude a company from all future scans
- **Full tailored resume and screening Q&A** — download resume as DOCX

### Analytics & Timeline
- **Analytics page** — SVG bar chart of applications over the last 7 days, platform donut chart, by-status breakdown, response and interview rates, advertised-salary spread (median / average / range, annualised), and a match-score histogram with your apply threshold marked (for tuning it alongside Test Scan)
- **Interview rate by match score** — what share of each score band actually reached interview or offer. The histogram shows where your threshold sits; this shows whether it belongs there. Bands with too few applications to be meaningful are greyed out rather than shown as a confident 0% or 100%
- **Which resume converts** — interview rate, response rate and average match score per resume actually sent. Routing rules send different jobs to different resumes; this is the evidence for keeping or dropping each rule instead of assuming it helps. Rates from fewer than 10 applications are marked as not yet meaningful
- **AI usage and cost** — spend today and this month, token counts, and a breakdown by operation (scoring, tailoring, cover letters), so an expensive scan is visible before the bill is
- **Timeline page** — collapsible day-by-day history of all applications grouped by platform

### Settings
- **Cover letter tone** — Professional, Casual & Warm, or Confident & Direct
- **Cover letter template** — optional structural base for AI to fill in
- **Daily scan time picker** — choose exactly when the automated scan runs
- **Auto follow-up** — toggle on/off with configurable day threshold
- **Company cooldown** — how long to wait before applying to another role at the same company
- **Resume routing rules** — keyword → resume mapping, checked top to bottom
- **Pages per scan** — how deep to page through each platform's results (1–10)
- **Inbox cadence** — how often to check for replies, and whether to skip weekends
- **No Response threshold** — days without a reply before an application is retired, with a Run Now button
- **Review before submit** — hold applications for approval instead of submitting automatically
- **AI budget and retries** — monthly spend cap (0 for none) and how many times a failed model call is retried
- **Company career boards** — add Greenhouse / Lever / Ashby boards by slug, each checked before it's saved
- **Background operation** — keep running in the tray on window close, launch on login, start minimised
- **Updates** — automatic daily check; downloading and installing are always explicit, and a restart is refused while a scan or apply is running
- **Phone notifications** — push recruiter replies, interview reminders, due follow-ups, closing dates, review-queue items, failed scans and new sign-ins to your phone, each switchable on its own. Sent straight from your desktop through Expo's push service; there is no Hiro server in the path
- **Calendar sync** — two-way sync of interviews with Google Calendar or Outlook. Reschedule in either place and the other follows; events you created yourself are never touched. You register your own OAuth client, because a client secret inside a downloadable app is not a secret
- **Encrypt local data** — AES-256-GCM over the database *and every backup*, keyed by your OS keychain, with a recovery key you save once (Settings → Data)
- **Devices on your account** — see every desktop and phone signed in, with session age and last contact. Three actions with honestly different reach: sign a device out (cooperative), remove it from the list (bookkeeping), or **sign out everywhere**, which invalidates every saved session server-side — the one to use for a lost phone

---

### Mobile Companion
- **Hiro Mobile** ([app/](app/)) — Expo React Native app, connects either over your local network **or** via the cloud
- **On-the-go dashboard** — stats, 7-day chart, status and platform breakdowns, upcoming interviews, and the Needs Attention queue (all available over the cloud as well as LAN)
- **Manage applications** — search, filter, update statuses, and add notes from your phone
- **Trigger a scan from your phone** — queue a scan (with optional keyword override); over LAN it runs on the desktop immediately (or the moment the desktop is next turned on), and over the cloud the desktop picks it up on its next sync cycle (~2 minutes) — so you can kick off a scan from anywhere. Requests are saved on the phone if neither is reachable and delivered automatically later
- **Watch scans live** — while the desktop scans, the phone shows a live "scanning now…" indicator (works over the cloud too) and, over Wi-Fi, a real-time feed of the desktop's activity log with a remote **Cancel scan** button
- **Push notifications** — recruiter replies, interview reminders, follow-ups coming due, closing dates, review-queue items and failed scans, sent by your desktop while you are away from it. Tapping one opens the application it was about
- **Follow-ups from your phone** — book or clear a next action on any application; due and overdue ones lead the dashboard
- **Registered on your account** — the phone appears in the desktop's device list with its session age, so it can be seen and signed out. It checks its own standing on every foreground and signs itself out if revoked
- **App Store-ready** — in-app account deletion, privacy policy, EAS build config (see [app/README.md](app/README.md))
- **Two ways to connect:**
  - **Local network (default)** — the phone talks directly to the desktop via a token-protected LAN API; no cloud involved
  - **Cloud sync (optional)** — sign in to a Supabase account on both desktop and phone to mirror applications, interviews, and attention jobs to the cloud, so the phone works from anywhere. Your local database stays the source of truth. See [supabase/SETUP.md](supabase/SETUP.md)

---

## Repository Layout

```
Hiro/
├── web/        Desktop app — Electron + React + Vite (scraping, AI, scheduling, database)
│   ├── test/           hermetic service suites
│   ├── test/smoke/     drives the packaged installer end to end
│   └── test/contract/  real calls to the job boards, Expo and the AI providers
├── app/        Mobile companion — Expo React Native (LAN or cloud)
├── supabase/   schema.sql for optional cloud sync — re-runnable
└── RELEASING.md  signing, notarization, and the release gates
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

# 2. Install dependencies. This also downloads Chromium into web/browsers
#    (~150 MB, one-off) so that packaged builds can ship it.
npm install

# 3. Start in development mode
npm run dev
```

Set `HIRO_SKIP_BROWSER_INSTALL=1` to skip the Chromium download (CI running unit
tests only). Scraping won't work until it has run — re-run it with
`npm run --prefix web postinstall`.

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

Chromium is bundled into the installer from `web/browsers` (the build refuses to
proceed without it — otherwise the installed app looks fine and then fails every
scrape on the user's machine). At runtime the app points Playwright at the
bundled copy, falling back to Playwright's own cache in a development run.

Installed builds check for updates once a day. Nothing downloads or installs
without you asking, and a restart is refused while a scan or apply is running.

### Cutting a release

See **[RELEASING.md](RELEASING.md)** for the full procedure, including the
certificates and secrets code signing needs.

Every push and pull request to `main` runs `.github/workflows/ci.yml`: the desktop
test suites, mobile unit tests, a permission check against the resolved Expo
config, a Metro bundle of the mobile app, and a production-dependency audit.
Pushes to `main` additionally build the desktop app and run the **packaged smoke
test** against the real installer. To ship:

```bash
# 1. Bump the version in web/package.json, commit, and wait for CI to go green.
# 2. Tag it — the tag must match that version exactly.
git tag v1.1.0 && git push origin v1.1.0
```

`.github/workflows/release.yml` then re-runs lint and the tests, refuses the tag if it
disagrees with `web/package.json`, and builds on macOS, Windows and Linux in
parallel. Each runner downloads its own platform's Chromium so the installer ships
with one. After building, each job **verifies the installer's signature** and runs
the **packaged smoke test** — installing the artifact a user would download,
launching it, and driving the real renderer. Installers and the `latest*.yml`
update manifests go to a **draft** GitHub release, so nothing reaches a user until
those gates pass and you publish the draft.

Signing is configured by secrets and is optional to develop against, but a
**tagged** release with an unsigned Windows or macOS installer fails the build —
unsigned installers mean SmartScreen and Gatekeeper warnings, and can break
auto-update outright. `RELEASING.md` lists what to set, and the
`ALLOW_UNSIGNED_RELEASE` repository variable is the deliberate opt-out.

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

## Testing

```bash
cd web
npm test              # 32 hermetic suites, no network, no browser  (~30s)
npm run lint
npm run build:dry && npm run smoke   # install the packaged app and drive it
npm run test:contract # real calls to the job boards and Expo — see below

cd ../app
npm test              # mobile unit suites
npm run check:permissions   # assert the resolved Expo config asks for nothing extra
```

Four layers, each covering something the others cannot:

| Layer | What only it can catch |
|---|---|
| `web/test/*.test.js` | Service logic, against a real SQLite database. Hermetic — safe on every push |
| `web/test/smoke/` | The **packaged** app: installer, main process, preload bridge, renderer. Found the ATS bug below |
| `app/test/` | The stats and date logic the phone shares with the desktop, pinned so the two cannot drift again |
| `web/test/contract/` | That Greenhouse, Lever, Ashby and Expo still reply in the shape the adapters parse. Found the entity bug below |

The two integration layers have already earned their place. The smoke test found
that **every career-board match was silently dropped** — nothing set
`job_description`, sql.js refused the `undefined` binding by throwing a bare
string, and the scan reported "Scan error: undefined". The contract tests found
that **Lever and Ashby descriptions were never HTML-decoded**, so they reached the
model full of `&amp;` and `&nbsp;`. Both are fixed, with unit tests pinning them.

See [web/test/smoke/README.md](web/test/smoke/README.md) and
[web/test/contract/README.md](web/test/contract/README.md).

---

## Data & Privacy

All data (config, database, session files) is stored **locally** on your machine under `~/.hiro/`. Nothing is sent to any server except the AI API you configure and the job platforms you log into.

The config file and the database are both written via a temp file and an atomic
rename, so a crash or power loss partway through a write can't truncate them. If
the config file is ever unreadable anyway, the broken copy is kept alongside it
as `config.json.corrupt` and the app says so — rather than silently starting
from defaults, which is indistinguishable from having lost every setting.

### Encryption at rest

`~/.hiro/autoapply.db` holds every job description, tailored resume, cover letter,
screening answer and recruiter address. A job search is often the one thing a
person most wants kept from their current employer, and by default all of it is
plaintext — readable by any process running as you, and carried out of the machine
by whatever backs up your home directory.

**Settings → Data → Encrypt Local Data** encrypts the database *and every backup*
with AES-256-GCM. The key is a random 32-byte data key wrapped by your OS keychain
(Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux), so Hiro unlocks
it without ever asking you for a passphrase. GCM's authentication tag means a
truncated or tampered file is refused rather than opened as garbage.

The cost, stated plainly: **if the keychain entry is lost, the database cannot be
decrypted.** That is what encryption at rest means. Hiro shows you a recovery key
when you turn it on — save it somewhere that is not this computer. It is the only
thing that can open the profile on a machine whose keychain no longer has the key,
and it can be re-imported from the same Settings panel.

If the database will not open, Hiro says exactly why and stops, rather than
starting empty — an empty dashboard is indistinguishable from having lost
everything.

### Cloud sync and devices

If you opt in to **Cloud Sync**, your applications are also mirrored to **your own**
Supabase project (which you create and control). Row Level Security restricts the
data to your account. Cloud sync is off until you sign in.

Every device that signs in — desktop and phone — registers itself on the account, so
Settings → Cloud Sync lists what is attached, when each session started, and when it
last checked in. A device signing in for the first time raises an alert in the app
and a notification on your phone.

Supabase gives a signed-in client no way to invalidate *another* client's session —
that needs an admin key, which must never ship inside a downloadable app. So Hiro
offers two things and does not pretend they are the same:

- **Sign out** (per device) stops that device's notifications immediately and asks
  it to sign itself out and forget its saved session the next time it connects. It
  cannot reach a device that is switched off.
- **Sign out everywhere** calls Supabase's global sign-out, which invalidates every
  saved session on the account server-side, this desktop's included. **This is the
  one to use for a phone you have actually lost.**
