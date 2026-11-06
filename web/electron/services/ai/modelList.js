// The models a key can actually use, asked of the provider itself.
//
// Model names were free text the user had to find elsewhere — Setup's advice
// for Gemini was to run a curl command — and a typo only surfaced on the first
// scan. This fetches the real list so Settings can offer it as a menu.
//
// Each entry is { id, label }. Read-only; nothing is billed for listing.

const TIMEOUT_MS = 15000

async function getJson(url, headers = {}, fetchImpl = fetch) {
  let res
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('The provider did not answer in time.')
    throw new Error(`Could not reach the provider: ${err.message}`)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = body?.error?.message || body?.message || `HTTP ${res.status}`
    throw new Error(res.status === 401 || res.status === 403 ? `The key was refused: ${detail}` : detail)
  }
  return body
}

// Models that write text. Embedding, image, audio and moderation models are
// listed by the same endpoints and would only fail if picked.
const NOT_TEXT = /(embed|image|imagen|tts|audio|whisper|dall-e|moderation|transcribe|realtime|search|veo|aqa|vision-exp)/i

const byId = (a, b) => a.id.localeCompare(b.id)

const LISTERS = {
  async gemini(apiKey, _cfg, fetchImpl) {
    const body = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': apiKey }, fetchImpl)
    return (body.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
      .filter(m => m.id && !NOT_TEXT.test(m.id))
  },
  async openrouter(_apiKey, _cfg, fetchImpl) {
    // Public: the list does not need the key.
    const body = await getJson('https://openrouter.ai/api/v1/models', {}, fetchImpl)
    return (body.data || [])
      .filter(m => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'))
      .filter(m => !/:batch$/.test(m.id))
      .map(m => ({ id: m.id, label: m.name || m.id }))
  },
  async claude(apiKey, _cfg, fetchImpl) {
    const body = await getJson('https://api.anthropic.com/v1/models?limit=1000', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, fetchImpl)
    return (body.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }))
  },
  async chatgpt(apiKey, _cfg, fetchImpl) {
    const body = await getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` }, fetchImpl)
    return (body.data || []).map(m => ({ id: m.id, label: m.id }))
      .filter(m => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !NOT_TEXT.test(m.id)).sort(byId)
  },
  async deepseek(apiKey, _cfg, fetchImpl) {
    const body = await getJson('https://api.deepseek.com/models', { Authorization: `Bearer ${apiKey}` }, fetchImpl)
    return (body.data || []).map(m => ({ id: m.id, label: m.id })).sort(byId)
  },
  async local(_apiKey, cfg, fetchImpl) {
    const { DEFAULT_BASE_URL } = require('./local')
    const base = String(cfg?.localAiBaseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
    const body = await getJson(`${base}/models`, {}, fetchImpl)
    return (body.data || body.models || []).map(m => ({ id: m.id || m.name, label: m.id || m.name })).filter(m => m.id).sort(byId)
  },
}

async function listModels(provider, apiKey, cfg = {}, { fetchImpl } = {}) {
  const lister = LISTERS[provider]
  if (!lister) throw new Error(`Listing models is not supported for ${provider || 'this provider'}.`)
  if (provider !== 'local' && provider !== 'openrouter' && !String(apiKey || '').trim()) {
    throw new Error('Enter the API key first.')
  }
  return lister(String(apiKey || '').trim(), cfg, fetchImpl || fetch)
}

// The model a blank Gemini setting means: the newest stable Flash model the
// key can use. "Flash" is Google's cost/speed tier — the right default for a
// scan that makes several calls per job. Previews, -lite and dated variants
// are passed over for the plain release name.
function pickGeminiDefault(models) {
  const version = id => (id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1]
  const stable = models.map(m => m.id).filter(id => /^gemini-\d+(\.\d+)?-flash$/.test(id))
  const pool = stable.length ? stable : models.map(m => m.id).filter(id => /flash/.test(id) && !/(lite|preview|exp|thinking|live)/.test(id))
  if (!pool.length) return models[0]?.id || ''
  return pool.sort((a, b) => Number(version(b) || 0) - Number(version(a) || 0))[0]
}

module.exports = { listModels, pickGeminiDefault, NOT_TEXT }
