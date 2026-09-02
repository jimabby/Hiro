// A model running on this machine — Ollama, LM Studio, llama.cpp, or anything
// else that serves the OpenAI chat-completions shape.
//
// Why this exists. dbCrypto's header makes the case plainly: a job search is
// often the one thing a person most wants kept from their current employer,
// which is why the database is encryptable at rest and why cloud sync is
// end-to-end encrypted with a key the server never sees. Yet every scan sent
// the full résumé and the full job description to a third-party API in the
// clear, under an account with the user's real billing details. That was the
// largest remaining hole in the app's own privacy argument, and it was the only
// one the user could not close by changing a setting.
//
// Pointing this at localhost closes it: nothing leaves the machine, there is no
// per-token cost, and no rate limit to back off from. The trade is quality —
// a 7B model tailors a résumé noticeably less well than gpt-4o — so this is
// offered as a choice rather than a default.
//
// The wire protocol is identical to OpenAI's, so this is a thin descriptor over
// that adapter rather than a second implementation of every prompt.
const openai = require('./openai')

const DEFAULT_BASE_URL = 'http://localhost:11434/v1' // Ollama's OpenAI-compatible endpoint
const DEFAULT_MODEL = 'llama3.1:8b'

// Local servers almost universally ignore the key, but the OpenAI SDK refuses
// to construct without one. A placeholder keeps that from becoming a setup step
// the user has to be told about.
const PLACEHOLDER_KEY = 'local'

// `model` arrives in the slot the adapter layer uses for the Gemini model name
// (see modelFor in ./index.js), because that is the one place a provider is
// already allowed to name its own model.
function flavourFor(model) {
  const cfg = safeConfig()
  const baseURL = String(cfg.localAiBaseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  const chosen = String(model || cfg.localAiModel || DEFAULT_MODEL).trim()
  return {
    baseURL,
    provider: 'local',
    // One model for both tiers. A local server usually has exactly one worth
    // using, and quietly asking for a "smart" model the user has not pulled
    // fails with a 404 that reads as a broken integration.
    model: chosen,
  }
}

function safeConfig() {
  try { return require('../config').load() } catch { return {} }
}

const key = (apiKey) => apiKey || PLACEHOLDER_KEY

const testConnection = (apiKey, model) => openai.testConnection(key(apiKey), flavourFor(model))
const tailorResume = (jobDesc, resume, apiKey, model) => openai.tailorResume(jobDesc, resume, key(apiKey), flavourFor(model))
const answerScreeningQuestion = (q, jobDesc, resume, apiKey, model) => openai.answerScreeningQuestion(q, jobDesc, resume, key(apiKey), flavourFor(model))
const generateTalkingPoints = (jobDesc, resume, apiKey, model) => openai.generateTalkingPoints(jobDesc, resume, key(apiKey), flavourFor(model))
const scoreMatch = (jobDesc, resume, apiKey, model) => openai.scoreMatch(jobDesc, resume, key(apiKey), flavourFor(model))
const scoreMatchWithExplanation = (jobDesc, resume, apiKey, model) => openai.scoreMatchWithExplanation(jobDesc, resume, key(apiKey), flavourFor(model))
const generateCoverLetter = (jobDesc, resume, apiKey, model, tone, template) => openai.generateCoverLetter(jobDesc, resume, key(apiKey), flavourFor(model), tone, template)
const improveResume = (resumeText, apiKey, model) => openai.improveResume(resumeText, key(apiKey), flavourFor(model))
const generateInterviewQuestions = (jobDesc, resume, apiKey, model, replyContext) => openai.generateInterviewQuestions(jobDesc, resume, key(apiKey), flavourFor(model), replyContext)
const generateFollowUpQuestion = (q, a, jd, apiKey, model) => openai.generateFollowUpQuestion(q, a, jd, key(apiKey), flavourFor(model))
const analyzeKeywordGap = (jobDesc, resume, apiKey, model) => openai.analyzeKeywordGap(jobDesc, resume, key(apiKey), flavourFor(model))
const generateFollowUpEmail = (jobTitle, company, resume, apiKey, model, stage) => openai.generateFollowUpEmail(jobTitle, company, resume, key(apiKey), flavourFor(model), stage)
const classifyReply = (subject, body, company, apiKey, model) => openai.classifyReply(subject, body, company, key(apiKey), flavourFor(model))
const generateCounterOffer = (input, apiKey, model) => openai.generateCounterOffer(input, key(apiKey), flavourFor(model))
const draftInterviewAnswer = (input, apiKey, model) => openai.draftInterviewAnswer(input, key(apiKey), flavourFor(model))

module.exports = {
  testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch,
  scoreMatchWithExplanation, generateCoverLetter, improveResume, generateInterviewQuestions,
  generateFollowUpQuestion, analyzeKeywordGap, generateFollowUpEmail, classifyReply,
  generateCounterOffer, draftInterviewAnswer,
  DEFAULT_BASE_URL, DEFAULT_MODEL, flavourFor,
}
