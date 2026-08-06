# Packaged release smoke test

`npm run build:dry && npm run smoke`

Installs the artifact from `dist-electron` the way a user's machine would, launches
it, and drives the real renderer through Playwright's Electron support.

## Why this exists

The unit suites in `web/test/` cover the main-process services well, and they
still could not see the bug that broke reload in packaged Windows builds: the
navigation guard compared a `file:` URL's pathname (`/C:/Program Files/…`)
against a resolved filesystem path, producing `C:\C:\Program Files\…`. Nothing
that check touched was reachable from a unit test, because nothing a unit test
runs is packaged and nothing it runs is a renderer.

This suite covers exactly that gap, and nothing else. It is the last gate before
a release publishes — see `.github/workflows/release.yml`.

## What it asserts

| Area | Check |
| --- | --- |
| Install | The real installer (NSIS `/S`, AppImage self-extract, DMG copy) produces a runnable binary |
| Startup | A window opens and its URL is the packaged `dist/index.html` |
| Renderer | The app shell renders and the nav appears, which proves the preload bridge answered `getConfig()` |
| Navigation | A renderer-initiated navigation naming the entry file is **allowed** (the Windows regression) |
| Navigation | A navigation to any other local file is still **refused** |
| Database | `getStats()` returns a renderable shape and a real SQLite file lands in the profile directory |
| Scan | One end-to-end scan: scrape → score → tailor → cover letter → persisted Needs Attention rows |
| Stability | No uncaught errors in the main process |

## Isolation

Nothing here touches the network or the user's own data.

* `HIRO_CONFIG_DIR` points config, the database, backups and logs at a throwaway
  directory, which is deleted afterwards.
* The job source and the AI adapter are replaced **at runtime in the main
  process**, via `require.cache`, by `mockExternals()` in `run.js`. The
  applicator looks both up as properties at call time (`scraper.scrape(cfg)`,
  `aiAdapter.tailorResume(…)`), so reassigning those properties is enough.
  There is deliberately **no test-only branch in shipped code** for this.
* Only the ATS job source is enabled, because it is the one scraper that needs
  neither a browser nor a login — so a full scan runs without Chromium.

## Local requirements

* A build in `dist-electron` (`npm run build:dry`).
* Linux: `xvfb`. The script re-execs itself under `xvfb-run` when `DISPLAY` is
  unset, rather than failing inside Chromium.
* Windows: the NSIS installer runs silently into a temp directory, so no
  elevation prompt and no interference with an installed copy of Hiro.
