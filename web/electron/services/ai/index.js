const claude = require('./claude')
const openai = require('./openai')
const deepseek = require('./deepseek')
const gemini = require('./gemini')
const local = require('./local')
const openrouter = require('./openrouter')
const { canUse, keyFor } = require('./configured')

// See markdown.js — it only strips emphasis that is unambiguously formatting,
// because this text goes to employers and must keep emails and URLs intact.
const { stripMarkdown } = require('./markdown')

function getAdapter(provider) {
  switch (provider) {
    case 'claude': return claude
    case 'chatgpt': return openai
    case 'deepseek': return deepseek
    case 'gemini': return gemini
    case 'local': return local
    case 'openrouter': return openrouter
    default: throw new Error(`Unknown AI provider: ${provider}`)
  }
}

// The 4th adapter arg is the model name, but the OpenAI adapter reads that
// position as its flavour — only forward it for Gemini, the one provider whose
// model the `geminiModel` setting names. Every other provider reads its own
// setting (see ./models.js). A local server used to share this slot, which let
// a Gemini name left over from an earlier setup override the local model the
// user had chosen, so Ollama was asked for "gemini-2.5-flash" and said 404.
function modelFor(provider, geminiModel) {
  return provider === 'gemini' ? geminiModel : undefined
}

// The test is the one call that names its model explicitly: it should prove
// the model on screen in Settings works, before it is saved.
function testFlavour(provider, model) {
  if (!model) return modelFor(provider, model)
  if (provider === 'chatgpt') return { provider: 'chatgpt', model }
  if (provider === 'deepseek') return { baseURL: 'https://api.deepseek.com', provider: 'deepseek', model }
  return model
}

// ─── Backup provider ─────────────────────────────────────────────
// A scan makes several calls per job. When the provider stops answering —
// credit runs out, a key is revoked, an outage — every job in the scan used to
// fail, one after another, each after its full retry allowance. With a backup
// provider set (Settings → AI → Backup provider), a failed call is re-run there.
//
// After a failure the primary is skipped for a while rather than tried first
// on every call: when it is down, it is usually down for longer than one job.
//
// Not a fallback: the monthly budget cap. It is one cap across providers, and
// switching provider must not become a way round it.
//
// The application record names whichever provider is serving when it is
// written (servingProvider below), so a document the backup wrote is filed
// under the backup in Analytics. The activity log records every switch.
const PRIMARY_COOLDOWN_MS = 10 * 60 * 1000
const primaryDownUntil = new Map() // provider -> timestamp

function loadConfig() {
  try { return require('../config').load() } catch { return {} }
}

function log(message) {
  try { require('../logger').append(message) } catch { /* best effort */ }
}

function backupFor(provider, cfg) {
  const backup = cfg?.aiFallbackProvider
  if (!backup || backup === provider || !canUse(cfg, backup)) return null
  return { provider: backup, apiKey: keyFor(cfg, backup), geminiModel: cfg.geminiModel }
}

function mayFallBack(err) {
  return err?.name !== 'BudgetExceededError'
}

// `invoke(adapter, apiKey, model)` makes one call against one provider.
async function call(provider, apiKey, geminiModel, invoke, { loadCfg = loadConfig, now = Date.now } = {}) {
  const cfg = loadCfg()
  const backup = backupFor(provider, cfg)
  const runPrimary = () => invoke(getAdapter(provider), apiKey, modelFor(provider, geminiModel))
  if (!backup) return runPrimary()
  const runBackup = () => invoke(getAdapter(backup.provider), backup.apiKey, modelFor(backup.provider, backup.geminiModel))

  if ((primaryDownUntil.get(provider) || 0) > now()) return runBackup()
  try {
    const value = await runPrimary()
    primaryDownUntil.delete(provider)
    return value
  } catch (err) {
    if (!mayFallBack(err)) throw err
    primaryDownUntil.set(provider, now() + PRIMARY_COOLDOWN_MS)
    log(`AI: ${provider} failed (${String(err.message || err).slice(0, 200)}). Using the backup provider, ${backup.provider}, for the next ${PRIMARY_COOLDOWN_MS / 60000} minutes.`)
    try {
      return await runBackup()
    } catch (backupErr) {
      // Both failed: report the primary's error, which is the one to fix.
      backupErr.message = `${err.message} (the backup provider, ${backup.provider}, also failed: ${backupErr.message})`
      throw backupErr
    }
  }
}

function _resetBackupState() { primaryDownUntil.clear() }

// Which provider is answering for `cfg` right now: the backup while the main
// provider is cooling down after a failure, otherwise the main one. Used to
// record who wrote an application's documents (models.writingModel).
function servingProvider(cfg = {}, now = Date.now) {
  const provider = cfg.aiProvider || ''
  const backup = backupFor(provider, cfg)
  if (backup && (primaryDownUntil.get(provider) || 0) > now()) return backup.provider
  return provider
}

// Never falls back: a test proves the provider on screen works.
async function testConnection(provider, apiKey, model) {
  return getAdapter(provider).testConnection(apiKey, testFlavour(provider, model))
}

async function tailorResume(provider, apiKey, jobDescription, masterResume, geminiModel) {
  const result = await call(provider, apiKey, geminiModel, (a, key, model) => a.tailorResume(jobDescription, masterResume, key, model))
  return stripMarkdown(result)
}

async function answerScreeningQuestion(provider, apiKey, question, jobDescription, masterResume, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.answerScreeningQuestion(question, jobDescription, masterResume, key, model))
}

async function generateTalkingPoints(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.generateTalkingPoints(jobDescription, masterResume, key, model))
}

async function scoreMatch(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.scoreMatch(jobDescription, masterResume, key, model))
}

async function improveResume(provider, apiKey, resumeText, geminiModel) {
  const result = await call(provider, apiKey, geminiModel, (a, key, model) => a.improveResume(resumeText, key, model))
  return stripMarkdown(result)
}

async function generateCoverLetter(provider, apiKey, jobDescription, masterResume, geminiModel, tone, template) {
  const result = await call(provider, apiKey, geminiModel, (a, key, model) => a.generateCoverLetter(jobDescription, masterResume, key, model, tone, template))
  return stripMarkdown(result)
}

async function scoreMatchWithExplanation(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.scoreMatchWithExplanation(jobDescription, masterResume, key, model))
}

// `replyContext` is the employer's own correspondence about this application,
// when there is any. Optional throughout, so a job with no reply yet still gets
// ordinary prep from the ad alone.
async function generateInterviewQuestions(provider, apiKey, jobDescription, masterResume, geminiModel, replyContext) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.generateInterviewQuestions(jobDescription, masterResume, key, model, replyContext))
}

async function analyzeKeywordGap(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.analyzeKeywordGap(jobDescription, masterResume, key, model))
}

async function generateFollowUpQuestion(provider, apiKey, question, userAnswer, jobDescription, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.generateFollowUpQuestion(question, userAnswer, jobDescription, key, model))
}

// `stage` is WHICH follow-up this is — 1 for the first nudge, 2 for the next,
// and so on. Each stage asks the model for a different letter; a second email
// that reads exactly like the first tells the reader nobody is paying attention.
// See ai/prompts.js.
async function generateFollowUpEmail(provider, apiKey, jobTitle, company, masterResume, geminiModel, stage = 1) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.generateFollowUpEmail(jobTitle, company, masterResume, key, model, stage))
}

async function classifyReply(provider, apiKey, subject, body, company, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.classifyReply(subject, body, company, key, model))
}

// Draft the reply that opens a negotiation on an offer. See ai/prompts.js for
// the two things this is forbidden to do — invent leverage, and cite the
// advertised ranges as market data.
async function generateCounterOffer(provider, apiKey, input, geminiModel) {
  const result = await call(provider, apiKey, geminiModel, (a, key, model) => a.generateCounterOffer(input, key, model))
  return stripMarkdown(result)
}

// A first pass at an interview answer, for the user to edit into their own
// words. `input.existingAnswer` switches it from drafting to tightening.
async function draftInterviewAnswer(provider, apiKey, input, geminiModel) {
  const result = await call(provider, apiKey, geminiModel, (a, key, model) => a.draftInterviewAnswer(input, key, model))
  return stripMarkdown(result)
}

// A free-form exchange — see claude.js chat(). The reply is returned as the
// model wrote it; callers that send it anywhere strip formatting themselves.
async function chat(provider, apiKey, input, geminiModel) {
  return call(provider, apiKey, geminiModel, (a, key, model) => a.chat(input, key, model))
}

module.exports = {
  chat, testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation,
  improveResume, generateCoverLetter, generateInterviewQuestions, generateFollowUpQuestion, analyzeKeywordGap,
  generateFollowUpEmail, classifyReply, generateCounterOffer, draftInterviewAnswer,
  servingProvider, _call: call, _resetBackupState,
}
