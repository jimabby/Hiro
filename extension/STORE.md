# Publishing the extension

Everything the Chrome Web Store, Edge Add-ons and addons.mozilla.org (AMO) ask
for, ready to paste. Publishing itself needs your own developer accounts:
Chrome charges a one-off US$5 registration, Edge and AMO are free.

## Build the uploads

```
node extension/scripts/package.js
```

Writes `extension/dist/hiro-importer-chrome-<version>.zip` (Chrome and Edge)
and `extension/dist/hiro-importer-firefox-<version>.zip` (AMO). Bump `version`
in `manifest.json` before each new upload; the stores refuse a version they
already have.

## Listing

**Name:** Hiro Job Importer

**Summary (132 characters max):**
Send the job listing you are reading to Hiro on your own computer, signed and encrypted, ready to apply from.

**Description:**
Hiro Job Importer adds the job listing in your current tab to Hiro, the desktop
job-search app, so you can score it, tailor your résumé and cover letter, and
track the application from one place.

- One click reads the role, company, salary, closing date and description from
  the page (from the listing's own structured data where it has it). You can
  correct any field before sending.
- The listing goes straight to Hiro on your own computer over your local
  network. Nothing is sent to us or to anyone else, and the extension has no
  servers of its own.
- Pairing uses a one-time code shown in Hiro. Every import is signed and
  encrypted, and the pairing can be revoked from either side.
- The extension only reads a page when you open it on that page, and can only
  reach the one desktop address you enter.

Requires the Hiro desktop app with the Mobile API turned on.

**Category:** Productivity (Chrome) / Productivity (Edge) / Other (AMO)

## Single purpose (Chrome)

Import the job listing in the active tab into the user's own Hiro desktop app.

## Permission justifications

- **activeTab:** read the listing in the tab the user is on, only when they
  open the extension there.
- **scripting:** run the one function that reads the listing's title, company,
  salary, closing date and description from that tab.
- **storage:** keep the pairing with the user's desktop (session storage by
  default, so it is forgotten when the browser closes; local storage only if
  the user ticks "Remember pairing on this device").
- **Optional host permission `http://*/*`:** requested at pairing time for the
  single desktop address the user types in (for example `192.168.1.10`), so the
  extension can reach Hiro on the local network. No other site is requested.
  Hiro serves plain HTTP on the LAN; every request is signed and its body
  encrypted end to end with the pairing key.
- **Remote code:** none. All code ships in the package.

## Data use

- **Collected:** the content of the job listing page the user chooses to
  import (website content), sent only to the user's own Hiro desktop app.
- **Not collected:** personal information, browsing history, location,
  authentication information, financial or health data.
- No data is sold, transferred to third parties, or used for anything other
  than the import.

For the Chrome Web Store data-use form, tick "Website content" and certify the
three limited-use statements. For AMO, the Firefox package already declares
`websiteContent` in `browser_specific_settings.gecko.data_collection_permissions`.

**Privacy policy:** `extension/PRIVACY.md`. The stores want a web address, so
link that file on GitHub (or host it) and use its address.

## Screenshots and images

- Chrome: at least one 1280×800 screenshot of the popup over a job listing,
  plus a 440×280 small promo tile.
- AMO: one or more screenshots; the 128px icon comes from the package.
- Icons are in `extension/icons/`, generated from `web/public/logo.png`.

## Firefox notes

- Needs Firefox 128 or later (session storage, scripting and optional host
  permissions in Manifest V3).
- The add-on id is `job-importer@hiro.app`. Keep it: AMO ties updates to it.
- Firefox has not been tested by hand yet. Before the first upload, load the
  Firefox zip from `about:debugging` → This Firefox → Load Temporary Add-on,
  pair it with a desktop and import one listing.
