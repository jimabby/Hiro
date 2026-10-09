const claude = require('./claude')
const openai = require('./openai')
const deepseek = require('./deepseek')
const gemini = require('./gemini')
const local = require('./local')

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

async function testConnection(provider, apiKey, model) {
  return getAdapter(provider).testConnection(apiKey, testFlavour(provider, model))
}

async function tailorResume(provider, apiKey, jobDescription, masterResume, geminiModel) {
  const result = await getAdapter(provider).tailorResume(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel))
  return stripMarkdown(result)
}

async function answerScreeningQuestion(provider, apiKey, question, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).answerScreeningQuestion(question, jobDescription, masterResume, apiKey, modelFor(provider, geminiModel))
}

async function generateTalkingPoints(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).generateTalkingPoints(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel))
}

async function scoreMatch(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).scoreMatch(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel))
}

async function improveResume(provider, apiKey, resumeText, geminiModel) {
  const result = await getAdapter(provider).improveResume(resumeText, apiKey, modelFor(provider, geminiModel))
  return stripMarkdown(result)
}

async function generateCoverLetter(provider, apiKey, jobDescription, masterResume, geminiModel, tone, template) {
  const result = await getAdapter(provider).generateCoverLetter(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel), tone, template)
  return stripMarkdown(result)
}

async function scoreMatchWithExplanation(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).scoreMatchWithExplanation(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel))
}

// `replyContext` is the employer's own correspondence about this application,
// when there is any. Optional throughout, so a job with no reply yet still gets
// ordinary prep from the ad alone.
async function generateInterviewQuestions(provider, apiKey, jobDescription, masterResume, geminiModel, replyContext) {
  return getAdapter(provider).generateInterviewQuestions(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel), replyContext)
}

async function analyzeKeywordGap(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).analyzeKeywordGap(jobDescription, masterResume, apiKey, modelFor(provider, geminiModel))
}

async function generateFollowUpQuestion(provider, apiKey, question, userAnswer, jobDescription, geminiModel) {
  return getAdapter(provider).generateFollowUpQuestion(question, userAnswer, jobDescription, apiKey, modelFor(provider, geminiModel))
}

// `stage` is WHICH follow-up this is — 1 for the first nudge, 2 for the next,
// and so on. Each stage asks the model for a different letter; a second email
// that reads exactly like the first tells the reader nobody is paying attention.
// See ai/prompts.js.
async function generateFollowUpEmail(provider, apiKey, jobTitle, company, masterResume, geminiModel, stage = 1) {
  return getAdapter(provider).generateFollowUpEmail(jobTitle, company, masterResume, apiKey, modelFor(provider, geminiModel), stage)
}

async function classifyReply(provider, apiKey, subject, body, company, geminiModel) {
  return getAdapter(provider).classifyReply(subject, body, company, apiKey, modelFor(provider, geminiModel))
}

// Draft the reply that opens a negotiation on an offer. See ai/prompts.js for
// the two things this is forbidden to do — invent leverage, and cite the
// advertised ranges as market data.
async function generateCounterOffer(provider, apiKey, input, geminiModel) {
  const result = await getAdapter(provider).generateCounterOffer(input, apiKey, modelFor(provider, geminiModel))
  return stripMarkdown(result)
}

// A first pass at an interview answer, for the user to edit into their own
// words. `input.existingAnswer` switches it from drafting to tightening.
async function draftInterviewAnswer(provider, apiKey, input, geminiModel) {
  const result = await getAdapter(provider).draftInterviewAnswer(input, apiKey, modelFor(provider, geminiModel))
  return stripMarkdown(result)
}

// A free-form exchange — see claude.js chat(). The reply is returned as the
// model wrote it; callers that send it anywhere strip formatting themselves.
async function chat(provider, apiKey, input, geminiModel) {
  return getAdapter(provider).chat(input, apiKey, modelFor(provider, geminiModel))
}

module.exports = { chat, testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation, improveResume, generateCoverLetter, generateInterviewQuestions, generateFollowUpQuestion, analyzeKeywordGap, generateFollowUpEmail, classifyReply, generateCounterOffer, draftInterviewAnswer }
