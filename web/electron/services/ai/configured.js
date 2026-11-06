// Is there a model to ask?
//
// "A provider and a key" was the test everywhere, and it is wrong for exactly
// one provider: a local server (Ollama, LM Studio) authenticates nothing, and
// Setup deliberately lets it be configured without a key. Every site that
// checked for the key therefore treated the most private configuration the app
// offers as "no AI at all" — screening questions on every auto-apply flow were
// skipped outright, replies went unclassified, and the drafting features said
// to configure a provider that was already configured.
//
// Gemini needs no model name either: a blank one means the newest Flash model
// the key can use (see gemini.js).
//
// Kept in its own module, free of dependencies, so the scrapers and services
// that need it do not have to pull in the adapter layer to ask.
function isAiConfigured(cfg) {
  if (!cfg || !cfg.aiProvider) return false
  if (cfg.aiProvider === 'local') return true
  return !!String(cfg.aiApiKey || '').trim()
}

// ─── One key per provider ────────────────────────────────────────
// Every saved key by provider. `aiApiKey` is authoritative for the active
// provider — services and a settings import write it directly, without the map
// — and a key saved before the map existed is picked up the same way.
function providerKeys(cfg) {
  const raw = cfg?.aiApiKeys
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  const active = cfg?.aiProvider
  const activeKey = cfg?.aiApiKey
  if (active && activeKey) map[active] = activeKey
  for (const k of Object.keys(map)) if (!map[k]) delete map[k]
  return map
}

function keyFor(cfg, provider) {
  return providerKeys(cfg)[provider] || ''
}

// Can `provider` be called with what is saved? Used for the backup provider.
function canUse(cfg, provider) {
  if (!provider) return false
  return provider === 'local' || !!keyFor(cfg, provider)
}

module.exports = { isAiConfigured, providerKeys, keyFor, canUse }
