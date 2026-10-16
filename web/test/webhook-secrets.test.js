// Webhook URLs are credentials.
//
// A Slack or Discord webhook URL carries its token in the path: anyone holding
// it can post to the channel as the integration. They were stored in
// config.json in the clear and exported in the settings bundle without the
// "include credentials" opt-in. They are now encrypted at rest like every other
// secret, preserved when this keychain cannot unwrap them, and left out of an
// export unless credentials are included.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-webhook-secrets-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })
process.env.HIRO_CONFIG_DIR = TMP

// A keychain that works, so encryption actually happens. Values it did not
// write ("foreign") cannot be unwrapped, as on a profile copied from elsewhere.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('K:' + s, 'utf8'),
  decryptString: (b) => {
    const text = b.toString('utf8')
    if (!text.startsWith('K:')) throw new Error('not ours')
    return text.slice(2)
  },
}
stub({ electron: { safeStorage } })

const config = service('config')
const transfer = service('configTransfer')
const { check, done } = createChecker()
const CONFIG_FILE = path.join(TMP, 'config.json')
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

const SLACK = 'https://hooks.slack.com/services/T000/B000/SECRETTOKEN'
const DISCORD = 'https://discord.com/api/webhooks/1/DISCORDTOKEN'

config.update({ webhooks: [
  { provider: 'slack', url: SLACK, enabled: true },
  { provider: 'discord', url: DISCORD, enabled: true },
] })

const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
check('the Slack token is not on disk in the clear', raw.includes('SECRETTOKEN'), false)
check('nor the Discord one', raw.includes('DISCORDTOKEN'), false)
check('the stored URL is a keychain ciphertext', onDisk().webhooks[0].url.startsWith('enc:v1:'), true)
check('the rest of the entry stays readable', onDisk().webhooks[0].provider, 'slack')
config.invalidate()
check('loading gives the URL back', config.load().webhooks.map(w => w.url), [SLACK, DISCORD])

// ── A URL this keychain cannot unwrap is preserved, not erased ────
const stored = onDisk()
stored.webhooks[1].url = 'enc:v1:' + Buffer.from('foreign').toString('base64')
fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored))
config._resetSecretState()
const loaded = config.load()
check('an unreadable URL reads as empty', loaded.webhooks[1].url, '')
check('and is reported', /webhooks/.test(config.getSecretError() || ''), true)
config.update({ lastScanAt: 'now' })
check('a background save writes the ciphertext back', onDisk().webhooks[1].url, stored.webhooks[1].url)
check('and keeps the readable one', config.load().webhooks[0].url, SLACK)

// ── The settings export leaves them out without the opt-in ────────
config.update({ webhooks: [{ provider: 'slack', url: SLACK, enabled: true }] })
const plain = transfer.inspectBundle(transfer.exportBundle('passphrase!'), 'passphrase!').payload
check('without credentials, the webhook travels without its URL', plain.webhooks[0], { provider: 'slack', url: '', enabled: true })
const full = transfer.inspectBundle(transfer.exportBundle('passphrase!', { includeSecrets: true }), 'passphrase!').payload
check('with credentials, the URL is included', full.webhooks[0].url, SLACK)

// Importing a credential-free bundle onto a machine that has the URL keeps it.
transfer.applyBundle(plain)
check('importing a URL-less webhook keeps the existing URL', config.load().webhooks[0].url, SLACK)

done()
