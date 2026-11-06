// One key per provider, the backup provider, model lists, Gemini's automatic
// model, OpenRouter's sign-in exchange and its pricing.

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
// Before any service loads: the backup-provider path writes to the activity log.
process.env.HIRO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiro-ai-providers-'))
const { service, createChecker } = require('./helpers')
const guard = require('../electron/ipc/configGuard')
const { providerKeys, keyFor, canUse } = service('ai/configured')
const { listModels, pickGeminiDefault } = service('ai/modelList')
const { priceFor } = service('ai/usage')
const ai = service('ai/index')
const openrouterAuth = service('openrouterAuth')

const { check, done } = createChecker()
const P = guard.SECRET_PLACEHOLDER

;(async () => {
  // ── One key per provider ──────────────────────────────────────
  check('a key saved before the map existed is filed under its provider',
    providerKeys({ aiProvider: 'claude', aiApiKey: 'sk-ant-1' }), { claude: 'sk-ant-1' })
  check('the active key wins over a stale map entry',
    keyFor({ aiProvider: 'claude', aiApiKey: 'sk-ant-new', aiApiKeys: { claude: 'sk-ant-old' } }, 'claude'), 'sk-ant-new')
  check('a local model is usable without a key', canUse({}, 'local'), true)
  check('a hosted provider without a saved key is not', canUse({ aiApiKeys: { claude: 'k' } }, 'gemini'), false)

  const stored = { aiProvider: 'claude', aiApiKey: 'sk-ant-1', aiApiKeys: { gemini: 'AIza-1' } }
  const served = guard.redactForRenderer(stored)
  check('the renderer learns which providers have keys, not the keys', served.aiApiKeys, { gemini: P, claude: P })
  check('no key reaches the renderer', JSON.stringify(served).includes('sk-ant-1') || JSON.stringify(served).includes('AIza-1'), false)

  let merged = guard.mergeRendererSave(stored, { ...served, aiProvider: 'gemini', aiApiKey: P }, served)
  check('switching provider makes that provider\'s saved key active', merged.aiApiKey, 'AIza-1')
  check('and keeps the last provider\'s key', merged.aiApiKeys.claude, 'sk-ant-1')

  merged = guard.mergeRendererSave(stored, { ...served, aiProvider: 'chatgpt', aiApiKey: 'sk-proj-2' }, served)
  check('a key typed for a new provider is saved under it', [merged.aiApiKey, merged.aiApiKeys.chatgpt], ['sk-proj-2', 'sk-proj-2'])
  check('without losing the others', [merged.aiApiKeys.claude, merged.aiApiKeys.gemini], ['sk-ant-1', 'AIza-1'])

  merged = guard.mergeRendererSave(stored, { ...served, aiProvider: 'deepseek', aiApiKey: '' }, served)
  check('a provider with no saved key has no active key', merged.aiApiKey, '')
  check('and the others survive', Object.keys(merged.aiApiKeys).sort(), ['claude', 'gemini'])

  merged = guard.mergeRendererSave(stored, { ...served, aiApiKey: '' }, served)
  check('clearing the key removes it for that provider only', [merged.aiApiKey, merged.aiApiKeys.claude, merged.aiApiKeys.gemini], ['', undefined, 'AIza-1'])

  merged = guard.mergeRendererSave(stored, { ...served, aiApiKeys: { claude: 'forged' } }, served)
  check('the key map cannot be written from the renderer', merged.aiApiKeys.claude, 'sk-ant-1')
  check('no placeholder reaches disk', JSON.stringify(merged).includes(P), false)

  // ── Backup provider ───────────────────────────────────────────
  const cfg = { aiProvider: 'claude', aiApiKey: 'ka', aiApiKeys: { gemini: 'kg' }, aiFallbackProvider: 'gemini', geminiModel: 'gemini-x' }
  let clock = 1000
  const calls = []
  const fakeAdapterCall = (failFor) => async (adapter, key, model) => {
    const who = adapter === service('ai/claude') ? 'claude' : adapter === service('ai/gemini') ? 'gemini' : 'other'
    calls.push([who, key, model])
    if (failFor.includes(who)) { const e = new Error(`${who} down`); e.status = 402; throw e }
    return `from ${who}`
  }
  const opts = { loadCfg: () => cfg, now: () => clock }

  ai._resetBackupState()
  check('a working primary is used', await ai._call('claude', 'ka', '', fakeAdapterCall([]), opts), 'from claude')

  calls.length = 0
  check('a failing primary falls back', await ai._call('claude', 'ka', '', fakeAdapterCall(['claude']), opts), 'from gemini')
  check('using the backup\'s own key and model', calls[1], ['gemini', 'kg', 'gemini-x'])

  calls.length = 0
  await ai._call('claude', 'ka', '', fakeAdapterCall([]), opts)
  check('the primary is skipped for a while after failing', calls.map(c => c[0]), ['gemini'])

  check('while the backup serves, it is the provider on record', ai.servingProvider(cfg, () => clock), 'gemini')

  clock += 11 * 60 * 1000
  check('and the main provider is again once the cool-down ends', ai.servingProvider(cfg, () => clock), 'claude')
  calls.length = 0
  await ai._call('claude', 'ka', '', fakeAdapterCall([]), opts)
  check('and tried again after the cool-down', calls.map(c => c[0]), ['claude'])

  ai._resetBackupState()
  let err = null
  try { await ai._call('claude', 'ka', '', fakeAdapterCall(['claude', 'gemini']), opts) } catch (e) { err = e }
  check('when both fail, both errors are reported', /claude down.*gemini.*gemini down/.test(err?.message), true)

  ai._resetBackupState()
  err = null
  const budget = async () => { const e = new Error('budget'); e.name = 'BudgetExceededError'; throw e }
  try { await ai._call('claude', 'ka', '', budget, opts) } catch (e) { err = e }
  check('the spend cap is never routed round', err?.name, 'BudgetExceededError')

  ai._resetBackupState()
  calls.length = 0
  await ai._call('claude', 'ka', '', fakeAdapterCall(['claude']), { ...opts, loadCfg: () => ({ ...cfg, aiApiKeys: {} }) }).catch(() => {})
  check('a backup with no saved key is not used', calls.map(c => c[0]), ['claude'])

  // What an application records as its writer, against the real clock.
  const models = service('ai/models')
  ai._resetBackupState()
  check('normally the main provider and its writing model are recorded',
    [models.writingProvider(cfg), models.writingModel(cfg)], ['claude', models.smartModel('claude', cfg)])
  await ai._call('claude', 'ka', '', fakeAdapterCall(['claude']), { loadCfg: () => cfg })
  check('a document the backup wrote is recorded under the backup and its model',
    [models.writingProvider(cfg), models.writingModel(cfg)], ['gemini', 'gemini-x'])
  ai._resetBackupState()
  check('an automatic Gemini model not yet looked up is recorded as blank, not guessed',
    models.writingModel({ aiProvider: 'gemini', aiApiKey: 'never-looked-up', geminiModel: '' }), '')

  // ── Model lists ───────────────────────────────────────────────
  const fakeFetch = (body, status = 200) => async (url, init) => ({ ok: status < 400, status, json: async () => body, url, init })
  const gemini = await listModels('gemini', 'AIza', {}, { fetchImpl: fakeFetch({ models: [
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
  ] }) })
  check('Gemini lists text models only', gemini.map(m => m.id), ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite'])
  check('a blank Gemini model means the newest stable Flash', pickGeminiDefault(gemini), 'gemini-3.8-flash')
  check('previews are passed over when a release exists',
    pickGeminiDefault([{ id: 'gemini-9-flash-preview' }, { id: 'gemini-4-flash' }]), 'gemini-4-flash')

  let sentHeaders = null
  await listModels('gemini', 'AIza', {}, { fetchImpl: async (url, init) => { sentHeaders = init.headers; return { ok: true, json: async () => ({ models: [] }) } } })
  check('the Gemini key goes in a header, not the URL', sentHeaders['x-goog-api-key'], 'AIza')

  const or = await listModels('openrouter', '', {}, { fetchImpl: fakeFetch({ data: [
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', architecture: { output_modalities: ['text'] } },
    { id: 'anthropic/claude-sonnet-5.5:batch', name: 'batch' },
    { id: 'google/image-gen', name: 'img', architecture: { output_modalities: ['image'] } },
  ] }) })
  check('OpenRouter lists text models, without batch variants, and needs no key', or.map(m => m.id), ['anthropic/claude-sonnet-5.5'])

  err = null
  try { await listModels('claude', 'bad', {}, { fetchImpl: fakeFetch({ error: { message: 'invalid x-api-key' } }, 401) }) } catch (e) { err = e }
  check('a refused key says so', err?.message, 'The key was refused: invalid x-api-key')
  err = null
  try { await listModels('chatgpt', '', {}, { fetchImpl: fakeFetch({}) }) } catch (e) { err = e }
  check('a hosted provider needs the key first', err?.message, 'Enter the API key first.')

  // ── OpenRouter sign-in ────────────────────────────────────────
  const { verifier, challenge } = openrouterAuth.makePkce()
  const expected = crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  check('the PKCE challenge is the S256 of the verifier', challenge, expected)
  let exchanged = null
  const key = await openrouterAuth.exchange('code-1', verifier, { fetchImpl: async (url, init) => { exchanged = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ key: 'sk-or-v1-x' }) } } })
  check('the code is exchanged for a key', key, 'sk-or-v1-x')
  check('at OpenRouter\'s key endpoint, with the verifier', [exchanged.url, exchanged.body], [openrouterAuth.EXCHANGE_URL, { code: 'code-1', code_verifier: verifier, code_challenge_method: 'S256' }])
  err = null
  try { await openrouterAuth.exchange('c', 'v', { fetchImpl: fakeFetch({ error: { message: 'Authorization code expired' } }, 403) }) } catch (e) { err = e }
  check('an expired code is explained', err?.message, 'OpenRouter did not issue a key: Authorization code expired')

  // ── OpenRouter pricing ────────────────────────────────────────
  check('an OpenRouter Claude id is priced as the Claude model', priceFor('anthropic/claude-sonnet-5.5'), priceFor('claude-sonnet-5-5'))
  check('an OpenRouter OpenAI id is priced as the OpenAI model', priceFor('openai/gpt-4o-mini'), priceFor('gpt-4o-mini'))
  check('Gemini\'s dotted versions are left alone', priceFor('gemini-2.5-flash'), { input: 0.3, output: 2.5 })

  done()
})().catch(e => { console.error(e); process.exitCode = 1 })
