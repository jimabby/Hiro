// Reading a JSON reply from the desktop, and saying something useful when it
// is not one.
//
// Every route on the desktop companion API answers with JSON. Anything else
// means the reply did not come from the desktop at all, and the case that
// matters is the one this app meets most: a captive portal on café, hotel or
// airport Wi-Fi answering the request with its own sign-in page. `res.json()`
// then throws a raw parser error — "Unexpected token '<'" or "JSON Parse error"
// — which tells the user nothing, and points the blame at Hiro rather than at
// the network they need to sign in to.
//
// CommonJS and free of any react-native or expo import, on purpose: the same
// reason src/stats.js and src/dates.js are. It keeps this reachable from the
// plain-Node test suite. See test/run.js.

// Matches an HTML document however it starts — a leading BOM or blank lines, a
// doctype, a bare <html>, or the <meta http-equiv="refresh"> that some portals
// send instead. Portals are not consistent, so this errs toward recognising one.
const HTML_START = /^[\s﻿]*<(?:!doctype|html|head|meta|title)\b/i

function looksLikeHtml(text) {
  return HTML_START.test(text)
}

// `res` is a fetch Response. Returns the parsed body, or throws an Error whose
// message is worth showing to a person.
async function readJson(res) {
  const text = await res.text()
  // A body-less reply (204, or a HEAD) is not an error and not a portal — it is
  // simply nothing, and the caller's status handling should decide what it means.
  if (!text.trim()) {
    if (res.ok) return null
    throw new Error(`The desktop replied with HTTP ${res.status} and no details.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    if (looksLikeHtml(text)) {
      throw new Error(
        'Something on this network answered instead of Hiro — usually a Wi-Fi sign-in page. '
        + 'Sign in to the network, or switch to one you have already joined, then try again.'
      )
    }
    throw new Error(
      `Unexpected reply from the desktop (HTTP ${res.status}). `
      + 'Check that Hiro is running on that machine and that the address is right.'
    )
  }
}

module.exports = { readJson, looksLikeHtml }
