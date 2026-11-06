# deepmerge 4.3.1, patched

Upstream deepmerge 4.3.1 (MIT, see license.txt) — its built `dist/cjs.js`, the file npm loads — with one change: `mergeObject()`
never writes a `__proto__` key. Every release from 4.2.0 to 4.3.1 copies keys
from the *target* object without checking them, so a target with an own
`__proto__` key (as `JSON.parse` produces) replaces the prototype of the merged
result — GHSA-gcqx-w48m-w2h4. No fixed version has been published.

Hiro does not depend on deepmerge directly. It comes in through
`puppeteer-extra-plugin-stealth` → `puppeteer-extra-plugin-user-preferences`,
and `web/package.json` overrides it with the tarball built from this folder:

    cd web/vendor/deepmerge && npm pack --pack-destination ..

Remove the override, this folder and the tarball once upstream ships a fix.
