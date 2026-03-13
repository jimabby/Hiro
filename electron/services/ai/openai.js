const OpenAI = require('openai')

function getClient(apiKey, baseURL) {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

async function testConnection(apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  await client.chat.completions.create({
    model: baseURL ? 'deepseek-chat' : 'gpt-4o-mini',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  })
}

async function tailorResume(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are an expert resume writer. Tailor the following resume for the job description below.
Keep it truthful — only reorder, rephrase, and emphasise existing experience.
Return ONLY the tailored resume text, no commentary.

JOB DESCRIPTION:
${jobDescription}

MASTER RESUME:
${masterResume}`,
    }],
  })
  return response.choices[0].message.content
}

async function answerScreeningQuestion(question, jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o-mini'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Answer this job application screening question concisely and professionally.
Base your answer on the resume and job context provided.

QUESTION: ${question}
JOB: ${jobDescription.slice(0, 500)}
RESUME: ${masterResume.slice(0, 1000)}

Return ONLY the answer, no commentary.`,
    }],
  })
  return response.choices[0].message.content
}

async function generateTalkingPoints(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o-mini'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Generate 5 concise talking points for why this candidate is a great fit for this job.
Return a JSON array of strings: ["point1", "point2", ...]

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}`,
    }],
  })
  try {
    return JSON.parse(response.choices[0].message.content)
  } catch {
    return [response.choices[0].message.content]
  }
}

async function scoreMatch(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o-mini'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `Score how well this resume matches this job description.
Return ONLY a number from 0 to 100 (integer), nothing else.

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}`,
    }],
  })
  const score = parseInt(response.choices[0].message.content.trim(), 10)
  return isNaN(score) ? 50 : Math.min(100, Math.max(0, score))
}

async function generateCoverLetter(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Write a concise, professional cover letter for this job application.
Base it on the candidate's resume and the job description.
3-4 paragraphs, natural and human-sounding. Be specific to the role and company.
Avoid generic filler phrases. Highlight the most relevant experience from the resume.
Return ONLY the cover letter text, starting with "Dear Hiring Manager," or similar.

JOB DESCRIPTION:
${jobDescription}

RESUME:
${masterResume}`,
    }],
  })
  return response.choices[0].message.content
}

async function improveResume(resumeText, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are an expert resume writer. Improve the following resume to be more impactful, professional, and ATS-friendly.
Strengthen bullet points, improve language clarity, and highlight achievements with metrics where possible.
Keep all facts truthful and accurate — do not invent experience.
Return ONLY the improved resume text, no commentary.

RESUME:
${resumeText}`,
    }],
  })
  return response.choices[0].message.content
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, improveResume, generateCoverLetter }
