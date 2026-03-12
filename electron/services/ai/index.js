const claude = require('./claude')
const openai = require('./openai')
const deepseek = require('./deepseek')
const gemini = require('./gemini')

function getAdapter(provider) {
  switch (provider) {
    case 'claude': return claude
    case 'chatgpt': return openai
    case 'deepseek': return deepseek
    case 'gemini': return gemini
    default: throw new Error(`Unknown AI provider: ${provider}`)
  }
}

// For Gemini, pass geminiModel as an extra arg (other adapters ignore it)
async function testConnection(provider, apiKey, geminiModel) {
  return getAdapter(provider).testConnection(apiKey, geminiModel)
}

async function tailorResume(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).tailorResume(jobDescription, masterResume, apiKey, geminiModel)
}

async function answerScreeningQuestion(provider, apiKey, question, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).answerScreeningQuestion(question, jobDescription, masterResume, apiKey, geminiModel)
}

async function generateTalkingPoints(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).generateTalkingPoints(jobDescription, masterResume, apiKey, geminiModel)
}

async function scoreMatch(provider, apiKey, jobDescription, masterResume, geminiModel) {
  return getAdapter(provider).scoreMatch(jobDescription, masterResume, apiKey, geminiModel)
}

async function improveResume(provider, apiKey, resumeText, geminiModel) {
  return getAdapter(provider).improveResume(resumeText, apiKey, geminiModel)
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, improveResume }
