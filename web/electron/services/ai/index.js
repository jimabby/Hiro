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

// The 4th adapter arg is the Gemini model name, but the OpenAI adapter reads
// that position as baseURL — only forward it for the gemini provider, or a
// leftover geminiModel value breaks ChatGPT calls.
function modelFor(provider, geminiModel) {
  return provider === 'gemini' ? geminiModel : undefined
}

// For Gemini, pass geminiModel as an extra arg (other adapters ignore it)
async function testConnection(provider, apiKey, geminiModel) {
  return getAdapter(provider).testConnection(apiKey, modelFor(provider, geminiModel))
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

async function generateFollowUpEmail(provider, apiKey, jobTitle, company, masterResume, geminiModel) {
  return getAdapter(provider).generateFollowUpEmail(jobTitle, company, masterResume, apiKey, modelFor(provider, geminiModel))
}

async function classifyReply(provider, apiKey, subject, body, company, geminiModel) {
  return getAdapter(provider).classifyReply(subject, body, company, apiKey, modelFor(provider, geminiModel))
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation, improveResume, generateCoverLetter, generateInterviewQuestions, generateFollowUpQuestion, analyzeKeywordGap, generateFollowUpEmail, classifyReply }
