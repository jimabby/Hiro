// OpenRouter — one account, one key, every major model. The key comes from
// "Sign in with OpenRouter" (services/openrouterAuth.js) or is pasted like any
// other. The wire protocol is OpenAI's chat completions, so this is a
// descriptor over that adapter, as DeepSeek and local models are.
const openai = require('./openai')
const { DEFAULT_MODELS, smartModel } = require('./models')

const BASE_URL = 'https://openrouter.ai/api/v1'

// The writing model is read per call, so a change in Settings applies at once.
function flavour() {
  return {
    baseURL: BASE_URL,
    provider: 'openrouter',
    fast: DEFAULT_MODELS.openrouter.fast,
    smart: smartModel('openrouter'),
  }
}

// Test Connection names the model on screen, so a mistyped id fails there.
const testConnection = (apiKey, model) => openai.testConnection(apiKey, model ? { ...flavour(), fast: model } : flavour())
const tailorResume = (jobDesc, resume, apiKey) => openai.tailorResume(jobDesc, resume, apiKey, flavour())
const answerScreeningQuestion = (q, jobDesc, resume, apiKey) => openai.answerScreeningQuestion(q, jobDesc, resume, apiKey, flavour())
const generateTalkingPoints = (jobDesc, resume, apiKey) => openai.generateTalkingPoints(jobDesc, resume, apiKey, flavour())
const scoreMatch = (jobDesc, resume, apiKey) => openai.scoreMatch(jobDesc, resume, apiKey, flavour())
const scoreMatchWithExplanation = (jobDesc, resume, apiKey) => openai.scoreMatchWithExplanation(jobDesc, resume, apiKey, flavour())
const generateCoverLetter = (jobDesc, resume, apiKey, _model, tone, template) => openai.generateCoverLetter(jobDesc, resume, apiKey, flavour(), tone, template)
const improveResume = (resumeText, apiKey) => openai.improveResume(resumeText, apiKey, flavour())
const generateInterviewQuestions = (jobDesc, resume, apiKey, _model, replyContext) => openai.generateInterviewQuestions(jobDesc, resume, apiKey, flavour(), replyContext)
const generateFollowUpQuestion = (q, a, jd, apiKey) => openai.generateFollowUpQuestion(q, a, jd, apiKey, flavour())
const analyzeKeywordGap = (jobDesc, resume, apiKey) => openai.analyzeKeywordGap(jobDesc, resume, apiKey, flavour())
const generateFollowUpEmail = (jobTitle, company, resume, apiKey, _model, stage) => openai.generateFollowUpEmail(jobTitle, company, resume, apiKey, flavour(), stage)
const classifyReply = (subject, body, company, apiKey) => openai.classifyReply(subject, body, company, apiKey, flavour())
const generateCounterOffer = (input, apiKey) => openai.generateCounterOffer(input, apiKey, flavour())
const draftInterviewAnswer = (input, apiKey) => openai.draftInterviewAnswer(input, apiKey, flavour())
const chat = (input, apiKey) => openai.chat(input, apiKey, flavour())

module.exports = {
  chat, testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch,
  scoreMatchWithExplanation, generateCoverLetter, improveResume, generateInterviewQuestions,
  generateFollowUpQuestion, analyzeKeywordGap, generateFollowUpEmail, classifyReply,
  generateCounterOffer, draftInterviewAnswer, BASE_URL,
}
