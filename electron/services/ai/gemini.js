const { GoogleGenerativeAI } = require('@google/generative-ai')

function getModel(apiKey, modelName) {
  const genAI = new GoogleGenerativeAI(apiKey)
  return genAI.getGenerativeModel({ model: modelName })
}

async function testConnection(apiKey, modelName) {
  const model = getModel(apiKey, modelName)
  await model.generateContent('hi')
}

async function tailorResume(jobDescription, masterResume, apiKey, modelName) {
  const model = getModel(apiKey, modelName)
  const result = await model.generateContent(`You are an expert resume writer. Tailor the following resume for the job description below.
Keep it truthful — only reorder, rephrase, and emphasise existing experience.
Return ONLY the tailored resume text, no commentary.

JOB DESCRIPTION:
${jobDescription}

MASTER RESUME:
${masterResume}`)
  return result.response.text()
}

async function answerScreeningQuestion(question, jobDescription, masterResume, apiKey, modelName) {
  const model = getModel(apiKey, modelName)
  const result = await model.generateContent(`Answer this job application screening question concisely and professionally.
Base your answer on the resume and job context provided.

QUESTION: ${question}
JOB: ${jobDescription.slice(0, 500)}
RESUME: ${masterResume.slice(0, 1000)}

Return ONLY the answer, no commentary.`)
  return result.response.text()
}

async function generateTalkingPoints(jobDescription, masterResume, apiKey, modelName) {
  const model = getModel(apiKey, modelName)
  const result = await model.generateContent(`Generate 5 concise talking points for why this candidate is a great fit for this job.
Return a JSON array of strings: ["point1", "point2", ...]

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}`)
  try {
    return JSON.parse(result.response.text())
  } catch {
    return [result.response.text()]
  }
}

async function scoreMatch(jobDescription, masterResume, apiKey, modelName) {
  const model = getModel(apiKey, modelName)
  const result = await model.generateContent(`Score how well this resume matches this job description.
Return ONLY a number from 0 to 100 (integer), nothing else.

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}`)
  const score = parseInt(result.response.text().trim(), 10)
  return isNaN(score) ? 50 : Math.min(100, Math.max(0, score))
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch }
