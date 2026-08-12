# Hiro Job Importer

This Manifest V3 extension imports the active job listing into Hiro's **Needs Attention** queue.

## Install locally

1. In Chrome or Edge, open the extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select this `extension/` directory.
3. In Hiro desktop, enable the Mobile API and choose **Pair a phone/device**.
4. Open a job listing, open the Hiro extension, and enter the desktop address and one-time code.

The extension requests access only to the desktop address you enter. It pairs as a distinct revocable device, signs and encrypts every import, and keeps its secret in `chrome.storage.session`; closing the browser requires pairing again rather than leaving a long-lived credential on disk.
