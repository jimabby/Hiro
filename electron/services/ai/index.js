const claude = require('./claude')
const openai = require('./openai')
const deepseek = require('./deepseek')
const gemini = require('./gemini')

// Strip any markdown formatting that AI models add despite being told not to
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold** → plain
    .replace(/__(.*?)__/g, '$1')        // __bold__ → plain
    .replace(/\*(.*?)\*/g, '$1')        // *italic* → plain
    .replace(/_(.*?)_/g, '$1')          // _italic_ → plain
    .replace(/^#{1,6}\s+/gm, '')        // ## headings → plain
    .replace(/^\*\s+/gm, '- ')          // * bullets → -
    .replace(/^-{3,}\s*$/gm, '')        // --- dividers → removed
    .trim()
}

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
  const result = await getAdapter(provider).tailorResume(jobDescription, masterResume, apiKey, geminiModel)
  return stripMarkdown(result)
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
  const result = await getAdapter(provider).improveResume(resumeText, apiKey, geminiModel)
  return stripMarkdown(result)
}

async function generateCoverLetter(provider, apiKey, jobDescription, masterResume, geminiModel) {
  const result = await getAdapter(provider).generateCoverLetter(jobDescription, masterResume, apiKey, geminiModel)
  return stripMarkdown(result)
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, improveResume, generateCoverLetter }
