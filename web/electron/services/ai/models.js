// Which model each provider runs, in one place.
//
// Two problems this exists to fix:
//
//   The models were hard-coded per adapter and went stale. A provider ships a
//   new generation every few months; a constant only changes when somebody
//   remembers it, and the user had no way to choose.
//
//   The model RECORDED against each application was whatever sat in
//   `geminiModel` — a field that only means something for Gemini. A Claude or
//   ChatGPT application was recorded with no model at all, so the "which model's
//   documents converted" analytics could not tell two generations apart; and
//   someone who had once tried Gemini and then switched to Claude had every
//   Claude-written document labelled "claude · gemini-2.5-flash". The local
//   adapter had the same mix-up in the other direction: a leftover Gemini name
//   took priority over the local model setting, so Ollama was asked for
//   "gemini-2.5-flash" and answered 404.
//
// So the model is chosen here, and the adapters, the cost meter and the
// application record all read the same answer.
//
// Two tiers per provider, as before:
//   fast  — short structured calls: scores, labels, classification, tests.
//   smart — the writing an employer reads: résumés, cover letters, prep.
// The user picks the WRITING model (that is the one whose output is judged);
// the fast tier stays on the provider's cheap model.

const DEFAULT_MODELS = {
  claude: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' },
  // GPT-5 mini for the short calls: OpenAI switches off gpt-4o, gpt-4o-mini
  // and gpt-4.1 on 14 January 2027 (see RETIRED_MODELS).
  chatgpt: { fast: 'gpt-5-mini', smart: 'gpt-5' },
  deepseek: { fast: 'deepseek-chat', smart: 'deepseek-chat' },
  // OpenRouter ids are vendor/model, with dots where Anthropic uses dashes.
  openrouter: { fast: 'anthropic/claude-haiku-5.5', smart: 'anthropic/claude-sonnet-5.5' },
}

// What Settings offers. Free text is accepted too — a provider's newest model
// should not have to wait for a Hiro release — so this is a menu, not a fence.
const MODEL_CHOICES = {
  claude: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — recommended' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — strongest writing, about 2× the cost' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest' },
  ],
  chatgpt: [
    { id: 'gpt-5', label: 'GPT-5 — recommended' },
    { id: 'gpt-5-mini', label: 'GPT-5 mini — cheapest' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  ],
  // Any model OpenRouter lists works; Settings can load the full list.
  openrouter: [
    { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 — recommended' },
    { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 — strongest writing' },
    { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 — cheapest' },
    { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ],
}

const LOCAL_DEFAULT_MODEL = 'qwen2.5:7b' // see ./local.js

// Models a provider has switched off, and what takes their place. A model the
// user chose in Settings stays chosen until the provider removes it; after
// that every call to it fails, so the saved choice is read as its successor
// (and config.load rewrites it, so Settings shows what actually runs).
// OpenAI retires gpt-4o, gpt-4o-mini, gpt-4.1 and gpt-4.1-mini, with their
// dated snapshots, on 14 January 2027.
const RETIRED_MODELS = {
  chatgpt: [
    [/^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/i, 'gpt-5-mini'],
    [/^gpt-4\.1-(mini|nano)(-\d{4}-\d{2}-\d{2})?$/i, 'gpt-5-mini'],
    [/^(gpt-4o|chatgpt-4o-latest|gpt-4\.1|gpt-4-turbo|gpt-4)(-\d{4}-\d{2}-\d{2})?$/i, 'gpt-5'],
  ],
  openrouter: [
    [/^openai\/gpt-4o-mini$/i, 'openai/gpt-5-mini'],
    [/^openai\/(gpt-4o|gpt-4\.1)$/i, 'openai/gpt-5'],
  ],
}

// The model to use in place of `model` for `provider`: its successor if the
// provider has retired it, otherwise the model itself.
function currentModel(provider, model) {
  const id = String(model || '').trim()
  for (const [pattern, successor] of RETIRED_MODELS[provider] || []) {
    if (pattern.test(id)) return successor
  }
  return id
}

// A saved writing-model map with every retired choice replaced. Returns the
// same object when nothing changed.
function migrateWritingModels(map) {
  if (!map || typeof map !== 'object') return map
  let changed = false
  const out = { ...map }
  for (const [provider, model] of Object.entries(map)) {
    const next = currentModel(provider, model)
    if (typeof model === 'string' && next !== model.trim()) { out[provider] = next; changed = true }
  }
  return changed ? out : map
}

function loadConfig() {
  try { return require('../config').load() } catch { return {} }
}

// The writing model for a provider that Hiro names models for. `cfg` is
// optional: adapters call this without one and get the saved settings.
function smartModel(provider, cfg = loadConfig()) {
  const chosen = currentModel(provider, cfg?.aiWritingModel?.[provider])
  return chosen || DEFAULT_MODELS[provider]?.smart || ''
}

function fastModel(provider) {
  return DEFAULT_MODELS[provider]?.fast || ''
}

// The provider writing documents right now: the backup while the main provider
// is in its cool-down after a failure (see ai/index.js), otherwise the main
// one. Every call in that window goes to the backup, so a document recorded
// straight after it was written names the provider that wrote it — and
// Analytics' "which version won" does not credit the backup's documents to the
// main provider.
function writingProvider(cfg = {}) {
  try { return require('./index').servingProvider(cfg) } catch { return cfg.aiProvider || '' }
}

// The model that wrote an application's documents, for the record kept against
// it. Every provider answers from its OWN setting — never another provider's.
function writingModel(cfg = {}) {
  const provider = writingProvider(cfg)
  if (provider === 'gemini') {
    // A blank setting means the model looked up for this key (gemini.js), so
    // record that rather than nothing.
    const chosen = String(cfg.geminiModel || '').trim()
    if (chosen) return chosen
    try {
      const { keyFor } = require('./configured')
      return require('./gemini').autoModelFor(keyFor(cfg, 'gemini')) || ''
    } catch { return '' }
  }
  if (provider === 'local') return String(cfg.localAiModel || '').trim() || LOCAL_DEFAULT_MODEL
  if (DEFAULT_MODELS[provider]) return smartModel(provider, cfg)
  return ''
}

// OpenAI's reasoning models take `max_completion_tokens`, reject `max_tokens`
// and any non-default temperature, and spend part of the budget thinking.
function isOpenAiReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(String(model || ''))
}

module.exports = { DEFAULT_MODELS, MODEL_CHOICES, LOCAL_DEFAULT_MODEL, RETIRED_MODELS, currentModel, migrateWritingModels, smartModel, fastModel, writingModel, writingProvider, isOpenAiReasoningModel }
