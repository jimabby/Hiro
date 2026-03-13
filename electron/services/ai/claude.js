const Anthropic = require('@anthropic-ai/sdk')

async function testConnection(apiKey) {
  const client = new Anthropic({ apiKey })
  await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  })
}

async function tailorResume(jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
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
  return response.content[0].text
}

async function answerScreeningQuestion(question, jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
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
  return response.content[0].text
}

async function generateTalkingPoints(jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Generate 5 concise talking points for why this candidate is a great fit for this job.
Be specific, referencing both the job requirements and the candidate's experience.
Return a JSON array of strings: ["point1", "point2", ...]

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}`,
    }],
  })
  try {
    return JSON.parse(response.content[0].text)
  } catch {
    return [response.content[0].text]
  }
}

async function scoreMatch(jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `Score how well this resume matches this job description.
Return ONLY a number from 0 to 100 (integer), nothing else.

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}`,
    }],
  })
  const score = parseInt(response.content[0].text.trim(), 10)
  return isNaN(score) ? 50 : Math.min(100, Math.max(0, score))
}

async function improveResume(resumeText, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
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
  return response.content[0].text
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, improveResume }
