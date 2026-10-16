// Webhooks: escaping scraped text for chat services, and signed, target-checked
// generic webhooks.
//
// Job titles and company names are written by strangers. A listing titled
// "<!channel> Senior Engineer" used to ping a whole Slack workspace, and
// "@everyone" a whole Discord server. Generic webhooks post wherever the user
// typed, so they are signed (the receiver can tell Hiro's request from anyone
// else's) and kept off loopback and private addresses unless asked.

const http = require('http')
const crypto = require('crypto')
const { stub, service, createChecker } = require('./helpers')

let cfg = { webhooks: [] }
stub({ './config': { load: () => cfg, CONFIG_DIR: '/tmp/hiro-webhooks-test' } })

const webhooks = service('webhooks.js')
const { check, done } = createChecker()

;(async () => {
  // ── Slack ─────────────────────────────────────────────────────
  const slack = webhooks.formatSlack('attention', {
    job_title: 'Engineer', company: '<!channel> Acme & Co', platform: '<https://evil.example|Seek>',
    match_score: 90, reason: '<@U123> look',
  })
  const section = slack.blocks[1].text.text
  check('a Slack broadcast in scraped text is escaped', section.includes('<!channel>'), false)
  check('as &lt;…&gt;', section.includes('&lt;!channel&gt; Acme &amp; Co'), true)
  check('a disguised link is escaped', section.includes('<https://evil'), false)
  check('a user mention is escaped', section.includes('<@U123>'), false)
  check('Slack\'s own formatting is untouched', section.startsWith('*'), true)
  check('only &, < and > are escaped', webhooks.slackEscape('a "b" \'c\' <d> & e'), 'a "b" \'c\' &lt;d&gt; &amp; e')

  // ── Discord ───────────────────────────────────────────────────
  const discord = webhooks.formatDiscord('attention', { job_title: '@everyone hiring', company: '@here', platform: 'Seek' })
  check('Discord mentions are disabled outright', discord.allowed_mentions, { parse: [] })

  // ── Private targets ───────────────────────────────────────────
  const priv = webhooks.isPrivateTarget
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    check(`${ip} is private`, priv(ip), true)
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888']) check(`${ip} is public`, priv(ip), false)

  const refuse = async (url, lookup) => {
    try { await webhooks.assertPublicTarget(new URL(url), { lookup }); return null } catch (err) { return err.code }
  }
  check('localhost by name is refused', await refuse('http://localhost:8080/x'), 'PRIVATE_TARGET')
  check('a loopback literal is refused', await refuse('http://127.0.0.1/x'), 'PRIVATE_TARGET')
  check('an IPv6 literal is refused', await refuse('http://[::1]/x'), 'PRIVATE_TARGET')
  // What the name RESOLVES to is what counts.
  check('a public name pointing at a private address is refused',
    await refuse('https://rebind.example/x', async () => [{ address: '192.168.0.1' }]), 'PRIVATE_TARGET')
  check('a public name pointing at a public address is fine',
    await refuse('https://hooks.example/x', async () => [{ address: '93.184.216.34' }]), null)

  // ── Signed delivery ───────────────────────────────────────────
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(204).end() })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/hook`
  const secret = webhooks.newSecret()
  check('a signing secret is 256 bits of hex', /^[0-9a-f]{64}$/.test(secret), true)

  let blocked = null
  try { await webhooks.deliver({ provider: 'generic', url, secret }, 'scan-complete', {}) } catch (err) { blocked = err.code }
  check('a generic webhook on this machine is refused by default', blocked, 'PRIVATE_TARGET')
  check('and nothing was sent', received.length, 0)

  const wh = { provider: 'generic', url, secret, allowPrivateNetwork: true }
  await webhooks.deliver(wh, 'attention', { job_title: 'Engineer' })
  check('with the opt-in it is delivered', received.length, 1)
  const { headers, body } = received[0]
  check('the body is the event as data', [JSON.parse(body).event, JSON.parse(body).data.job_title], ['attention', 'Engineer'])
  check('it carries a timestamp', /^\d+$/.test(headers['x-hiro-timestamp']), true)
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${headers['x-hiro-timestamp']}.${body}`).digest('hex')
  check('and an HMAC-SHA256 over timestamp.body', headers['x-hiro-signature'], expected)
  check('the event name is a header too', headers['x-hiro-event'], 'attention')

  // The scheduled path skips a refused webhook quietly rather than throwing.
  cfg = { webhooks: [{ provider: 'generic', url, secret, enabled: true }] }
  await webhooks.send('scan-complete', {})
  check('send() does not deliver to a private target without the opt-in', received.length, 1)
  cfg = { webhooks: [{ ...wh, enabled: true }] }
  await webhooks.send('scan-complete', { message: 'done' })
  check('send() delivers signed generic webhooks', received.length, 2)

  let testError = null
  try { await webhooks.test('generic', url, null) } catch (err) { testError = err.message }
  check('testing an unsaved generic webhook explains it needs saving first', /Save Settings/.test(testError || ''), true)
  check('testing a saved one works', await webhooks.test('generic', url, wh), true)

  server.close()
  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
