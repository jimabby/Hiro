# Hiro Job Importer

This Manifest V3 extension imports the active job listing into Hiro's **Needs Attention** queue.

## Install locally

1. In Chrome or Edge, open the extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select this `extension/` directory.
3. In Hiro desktop, enable the Mobile API and choose **Pair a phone/device**.
4. Open a job listing, open the Hiro extension, and enter the desktop address and one-time code.

Firefox 128 or later: run `node extension/scripts/package.js`, then load
`extension/dist/hiro-importer-firefox-<version>.zip` from `about:debugging` →
This Firefox → Load Temporary Add-on.

## Publishing

`node extension/scripts/package.js` builds the Chrome/Edge and Firefox uploads.
[STORE.md](STORE.md) has the listing text, permission justifications and data
use answers the stores ask for; [PRIVACY.md](PRIVACY.md) is the privacy notice.

The extension requests access only to the desktop address you enter (IPv4, a hostname, or IPv6 such as `fd00::5`). It pairs as a distinct revocable device, signs and encrypts every import, and by default keeps its secret in `chrome.storage.session`, so closing the browser requires pairing again. Tick **Remember pairing on this device** to keep it in `chrome.storage.local` instead, which avoids minting a new device token every time the browser restarts. **Forget pairing** revokes the token on the desktop as well as deleting it locally.
