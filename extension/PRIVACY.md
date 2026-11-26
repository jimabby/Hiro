# Hiro Job Importer: privacy

The extension reads the job listing in the tab you are on, only when you open
it there, and sends what it read (role, company, salary, closing date, the
listing's address and description) to the Hiro desktop app on your own
computer, at the address you entered when pairing.

- Nothing is sent anywhere else. The extension has no servers of its own, no
  analytics and no advertising.
- Every import is signed and its contents encrypted with a key agreed during
  pairing.
- The extension stores one thing: the pairing with your desktop. By default it
  is kept in session storage and forgotten when the browser closes; if you tick
  "Remember pairing on this device" it is kept in the browser's local storage
  instead. "Forget pairing" deletes it and revokes it on the desktop.
- What happens to a listing after it reaches Hiro is covered by the desktop
  app: it stays on your computer unless you turn on cloud sync.
