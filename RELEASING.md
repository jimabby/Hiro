# Releasing Hiro

```
1. bump web/package.json version
2. git tag vX.Y.Z && git push --tags
3. CI builds, signs, verifies and smoke-tests three installers
4. promote the draft GitHub release
```

`.github/workflows/release.yml` does steps 3 and 4's prerequisites. It refuses to
proceed if the tag disagrees with `web/package.json`, if the tests or lint fail,
if a Windows/macOS installer is unsigned, or if the packaged smoke test fails.
electron-builder publishes as a **draft**, so nothing reaches users until the
draft is promoted by hand.

---

## Code signing

Unsigned installers are not a cosmetic problem:

* **Windows** — SmartScreen shows "Windows protected your PC" and hides the Run
  button behind *More info*. Users are trained to click through the exact dialog
  that protects them.
* **macOS** — Gatekeeper refuses to open an unsigned, un-notarized app at all
  from a normal double-click; the workaround is right-click → Open, or a trip to
  System Settings.
* **Auto-update** — electron-updater verifies the publisher of a downloaded
  Windows update against the installed application. A mix of signed and unsigned
  releases can break updating outright, which is worse than never signing.

The release workflow signs whenever the corresponding secrets exist, and builds
unsigned (with a loud log line) when they do not. A **tagged** release with
unsigned Windows or macOS artifacts fails the job.

Escape hatch: set the repository **variable** `ALLOW_UNSIGNED_RELEASE` to `1` to
ship unsigned deliberately. Prefer removing it again once certificates exist.

### Windows: Authenticode

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE_BASE64` | The code-signing certificate as a base64 PFX |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its export password |

Get an **OV** or **EV** code-signing certificate from a CA (DigiCert, Sectigo,
SSL.com…). OV certificates are cheaper but build SmartScreen reputation slowly;
EV certificates are trusted immediately and are usually issued on a hardware
token, which cannot be exported to a PFX — for EV, use a cloud signing service
and `win.azureSignOptions` or a custom `sign` hook instead of `CSC_LINK`.

Encode the PFX:

```bash
base64 -w0 hiro-codesign.pfx        # Linux
base64 -i hiro-codesign.pfx         # macOS
certutil -encode hiro.pfx out.txt   # Windows, then strip the header/footer lines
```

Signatures are countersigned against `timestamp.digicert.com`
(`win.signtoolOptions.rfc3161TimeStampServer` in `web/package.json`). Without a
timestamp, every already-shipped installer stops validating the day the
certificate expires.

### macOS: Developer ID + notarization

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_BASE64` | "Developer ID Application" certificate + private key as a base64 `.p12` |
| `MAC_CERTIFICATE_PASSWORD` | Its export password |
| `APPLE_TEAM_ID` | Ten-character Apple Developer team ID |
| `APPLE_API_KEY_P8` | App Store Connect API key (`AuthKey_XXX.p8`), base64-encoded |
| `APPLE_API_KEY_ID` | The key's ID |
| `APPLE_API_ISSUER` | The issuer UUID from App Store Connect |

Requires a $99/year Apple Developer membership. Export the certificate from
Keychain Access → *My Certificates* → right-click → Export as `.p12`, then base64
it.

An **App Store Connect API key** is used rather than `APPLE_ID` +
app-specific password: it is scoped, revocable, and does not carry an Apple ID's
full privileges. Create it under App Store Connect → Users and Access → Keys with
the *Developer* role. The `.p8` can only be downloaded once.

Signing and notarization are separate steps, and only *notarized* builds open
without a warning:

* No certificate → unsigned. Gatekeeper blocks it.
* Certificate, no API key → signed but un-notarized. Gatekeeper warns on first
  open. The workflow logs this state explicitly.
* Certificate + API key → signed and notarized, with the ticket stapled into the
  DMG. Opens cleanly.

Notarization is what makes `web/build/entitlements.mac.plist` necessary: it
requires Hardened Runtime, which blocks the JIT and library loading the bundled
Playwright Chromium needs. Every entitlement in that file is justified in a
comment; the camera, microphone and location entitlements are deliberately
absent.

### Linux

AppImages have no OS-level signature. Integrity comes from the checksum on the
GitHub release. `verify-signature.js` reports Linux artifacts as *not
applicable* and never fails on them.

---

## Checking a build by hand

```bash
cd web
npm run build:dry          # build without publishing
npm run verify:signature   # report the signing state of what was built
npm run smoke              # install it, launch it, drive it
```

`npm run verify:signature -- --require-signed` exits non-zero when something is
unsigned, which is what CI runs on a tagged release.

## The smoke test

`web/test/smoke/` installs the artifact the way a user's machine would (silent
NSIS install, AppImage self-extract, DMG copy), launches it, and drives the real
renderer: startup, entry-point navigation, reload, database open, and one scan
with the job source and the model replaced at runtime. See
`web/test/smoke/README.md` for what each check protects.
