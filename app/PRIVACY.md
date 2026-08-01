# Hiro Mobile — Privacy Policy

**Effective date:** 16 July 2026

> Hosted version (use this URL in App Store Connect / Google Play):
> <https://jimabby.github.io/card-assets/legal/hiro/privacy-policy.html>
> Support: <https://jimabby.github.io/card-assets/legal/hiro/support.html> ·
> Account deletion: <https://jimabby.github.io/card-assets/legal/hiro/account-deletion.html>

Hiro Mobile is a companion app for the Hiro desktop application. It displays
job-application data that the desktop app produces and lets you manage it from
your phone. This policy explains what data the app handles and where it goes.

## The short version

- We (the developer) run **no servers** and **collect nothing**. No analytics,
  no advertising, no tracking, no crash reporting.
- Your data lives in exactly two places, both controlled by you: your own
  computer, and (optionally) your own Supabase cloud project.
- You can delete your cloud account and all synced data at any time, directly
  in the app (Settings → Delete account).

## Data the app handles

**Job application data** — job titles, companies, match scores, resumes, cover
letters, application statuses, and notes. This data is created by the Hiro
desktop app on your computer. Hiro Mobile displays it and lets you edit
statuses and notes.

**Account credentials (cloud mode only)** — an email address and password used
to sign in to your Supabase project. The session token is stored securely on
your device.

**Connection settings (Wi-Fi mode only)** — the IP address, port, and pairing
token of your desktop, stored securely on your device (iOS Keychain / Android
Keystore).

## Where your data goes

**Wi-Fi (LAN) mode:** your phone communicates directly with the Hiro desktop
app on your local network. No data leaves your network and no third party is
involved.

> **Use this on networks you trust.** LAN mode speaks plain HTTP, so the
> pairing token and the application data it returns are not encrypted in
> transit. Anyone able to observe traffic on the same network — public or
> guest Wi-Fi, for instance — could capture the token and reuse it while your
> desktop is reachable. The desktop only accepts connections from private
> network addresses, but that does not protect you from others on the same
> network. On an untrusted network, prefer cloud mode or leave the mobile API
> switched off.

**Cloud mode (optional):** your application data is synced to a
[Supabase](https://supabase.com) project that **you create and own**. The
developer of Hiro has no access to it. Supabase's handling of that data is
governed by your agreement with Supabase and their privacy policy. Row Level
Security restricts every record to your own account.

The app sends no data to the developer or to any other third party.

## Data retention and deletion

- **Wi-Fi mode:** the app stores only your connection settings, removed when
  you disconnect or uninstall the app. Your application data stays on your
  computer.
- **Cloud mode:** synced data is kept in your Supabase project until you delete
  it. **Settings → Delete account** in the app permanently deletes your cloud
  account and every synced record. Uninstalling the app removes all locally
  stored data from your device.

## Children

Hiro Mobile is a productivity tool intended for adults seeking employment and
is not directed at children under 13.

## Changes

If this policy changes, the updated version will be published at the same URL
with a new effective date.

## Contact

Questions about this policy: **wksunshine@gmail.com**
