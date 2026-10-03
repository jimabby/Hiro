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
// Kept in its own module, free of dependencies, so the scrapers and services
// that need it do not have to pull in the adapter layer to ask.
function isAiConfigured(cfg) {
  if (!cfg || !cfg.aiProvider) return false
  if (cfg.aiProvider === 'local') return true
  return !!String(cfg.aiApiKey || '').trim()
}

module.exports = { isAiConfigured }
