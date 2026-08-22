// Reading replies from the desktop.
//
// The bug this exists for: `await res.json()` on every response, with only
// AbortError handled around it. On any network where something other than the
// desktop answers — the captive portals on café, hotel and airport Wi-Fi, which
// are exactly the networks a phone companion app lives on — that threw a raw
// parser error. The user saw "JSON Parse error: Unexpected character: <" and had
// no way to know the problem was the Wi-Fi sign-in page rather than Hiro.

const { createChecker } = require('./helpers')
const { readJson, looksLikeHtml } = require('../src/httpJson')

const { check, done } = createChecker()

// Just enough of a fetch Response for this function: it reads .text(), .ok
// and .status and nothing else.
const reply = (body, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
})

const message = async (res) => {
  try {
    await readJson(res)
    return null
  } catch (err) {
    return err.message
  }
}

async function main() {
  // ── The ordinary path ────────────────────────────────────────────
  check('a JSON body is parsed',
    await readJson(reply('{"total":3}')), { total: 3 })
  check('a JSON array is parsed',
    await readJson(reply('[1,2]')), [1, 2])
  check('an error body is still parsed, so the caller can read its message',
    await readJson(reply('{"error":"locked out"}', { status: 429 })), { error: 'locked out' })

  // ── Captive portals ──────────────────────────────────────────────
  const portal = await message(reply('<!DOCTYPE html><html><body>Sign in</body></html>'))
  check('an HTML reply names the network, not Hiro', /Wi-Fi sign-in page/.test(portal), true)
  check('an HTML reply says what to do', /Sign in to the network/.test(portal), true)
  check('an HTML reply never shows a parser error', /JSON|token|Unexpected character/i.test(portal), false)

  // Portals are not consistent about what they send.
  for (const [label, body] of [
    ['a bare <html>', '<html><body>hi</body></html>'],
    ['a leading newline', '\n\n<!doctype html><html></html>'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://portal">'],
    ['an uppercase doctype', '<!DOCTYPE HTML PUBLIC>'],
  ]) {
    check(`${label} is recognised as a portal`, looksLikeHtml(body), true)
  }
  check('JSON is not mistaken for HTML', looksLikeHtml('{"a":1}'), false)
  check('a leading angle bracket alone is not HTML', looksLikeHtml('<<<'), false)

  // ── Anything else that is not JSON ───────────────────────────────
  const junk = await message(reply('upstream connect error', { status: 502 }))
  check('a non-HTML, non-JSON reply reports the status', /HTTP 502/.test(junk), true)
  check('a non-HTML, non-JSON reply points at the desktop', /Hiro is running/.test(junk), true)

  // ── Empty bodies ─────────────────────────────────────────────────
  // Not a parse failure and not a portal: nothing came back at all, and the
  // caller's own status handling is what should decide what that means.
  check('an empty 204 is null rather than an error', await readJson(reply('', { status: 204 })), null)
  check('an empty error reply reports its status',
    /HTTP 500/.test(await message(reply('', { status: 500 }))), true)
  check('a whitespace-only body counts as empty',
    await readJson(reply('   \n ', { status: 200 })), null)

  done()
}

main()
