// DeepSeek uses OpenAI-compatible API — reuse openai adapter with DeepSeek base URL
const openai = require('./openai')

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const testConnection = (apiKey) => openai.testConnection(apiKey, DEEPSEEK_BASE_URL)
const tailorResume = (jobDesc, resume, apiKey) => openai.tailorResume(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL)
const answerScreeningQuestion = (q, jobDesc, resume, apiKey) => openai.answerScreeningQuestion(q, jobDesc, resume, apiKey, DEEPSEEK_BASE_URL)
const generateTalkingPoints = (jobDesc, resume, apiKey) => openai.generateTalkingPoints(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL)
const scoreMatch = (jobDesc, resume, apiKey) => openai.scoreMatch(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL)
const generateCoverLetter = (jobDesc, resume, apiKey, _geminiModel, tone, template) => openai.generateCoverLetter(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL, tone, template)
const improveResume = (resumeText, apiKey) => openai.improveResume(resumeText, apiKey, DEEPSEEK_BASE_URL)
const scoreMatchWithExplanation = (jobDesc, resume, apiKey) => openai.scoreMatchWithExplanation(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL)
const generateInterviewQuestions = (jobDesc, resume, apiKey, _model, replyContext) => openai.generateInterviewQuestions(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL, replyContext)
const analyzeKeywordGap = (jobDesc, resume, apiKey) => openai.analyzeKeywordGap(jobDesc, resume, apiKey, DEEPSEEK_BASE_URL)
const generateFollowUpQuestion = (q, a, jd, apiKey) => openai.generateFollowUpQuestion(q, a, jd, apiKey, DEEPSEEK_BASE_URL)
const generateFollowUpEmail = (jobTitle, company, resume, apiKey) => openai.generateFollowUpEmail(jobTitle, company, resume, apiKey, DEEPSEEK_BASE_URL)
const classifyReply = (subject, body, company, apiKey) => openai.classifyReply(subject, body, company, apiKey, DEEPSEEK_BASE_URL)

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation, generateCoverLetter, improveResume, generateInterviewQuestions, generateFollowUpQuestion, analyzeKeywordGap, generateFollowUpEmail, classifyReply }
