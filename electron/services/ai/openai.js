const OpenAI = require('openai')

function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

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

async function generateCoverLetter(jobDescription, masterResume, apiKey, baseURL, tone, template) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o'
  const toneInstruction = tone === 'casual' ? 'Write in a warm, approachable, conversational tone.' : tone === 'confident' ? 'Write with assertive, direct confidence — lead with impact.' : ''
  const templateInstruction = template ? `Use the following as the structural base, filling in job-specific details:\n\n${template}\n\n` : ''
  const response = await client.chat.completions.create({
    model,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `${templateInstruction}Write a concise, professional cover letter for this job application.
Base it on the candidate's resume and the job description.
3-4 paragraphs, natural and human-sounding. Be specific to the role and company.
Avoid generic filler phrases. Highlight the most relevant experience from the resume.
Start with "Dear Hiring Manager," or similar.
End with a formal closing (e.g. "Sincerely,") on its own line, then a blank line, then the candidate's full name as it appears at the top of the resume.
Do not use any markdown formatting — no asterisks, no pound signs, no underscores.
${toneInstruction}
Return ONLY the cover letter text.

JOB DESCRIPTION:
${jobDescription}

RESUME:
${masterResume}`,
    }],
  })
  return response.choices[0].message.content
}

async function scoreMatchWithExplanation(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o-mini'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 200,
    messages: [{ role: 'user', content: `Score how well this resume matches this job description.
Return JSON only: { "score": 85, "explanation": "one sentence explanation" }
Score 0-100. Plain text explanation, no markdown.

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}` }],
  })
  try {
    const parsed = JSON.parse(response.choices[0].message.content)
    const score = parseInt(parsed.score, 10)
    return { score: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)), explanation: parsed.explanation || '' }
  } catch {
    const score = parseInt(response.choices[0].message.content.trim(), 10)
    return { score: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)), explanation: '' }
  }
}

async function generateInterviewQuestions(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2500,
    messages: [{ role: 'user', content: `Generate 8 likely interview questions for this job with a tailored sample answer for each, based on the candidate's actual resume experience.
Return a JSON array: [{ "question": "...", "answer": "..." }, ...]
Answers should be 2-4 sentences, specific to the candidate's real experience. No markdown in answers.

JOB: ${jobDescription.slice(0, 1000)}
RESUME: ${masterResume.slice(0, 1200)}` }],
  })
  try { return parseJSON(response.choices[0].message.content) }
  catch { return [] }
}

async function analyzeKeywordGap(jobDescription, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o-mini'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 600,
    messages: [{ role: 'user', content: `Analyze which key skills and qualifications from this job are present or missing in this resume.
Return JSON only, no code fences: { "missing": ["skill1", ...], "present": ["skill2", ...] }
Max 10 items each. Focus on specific technical skills, tools, certifications.

JOB: ${jobDescription.slice(0, 1000)}
RESUME: ${masterResume.slice(0, 800)}` }],
  })
  try { return parseJSON(response.choices[0].message.content) }
  catch { return { missing: [], present: [] } }
}

async function generateFollowUpEmail(jobTitle, company, masterResume, apiKey, baseURL) {
  const client = getClient(apiKey, baseURL)
  const model = baseURL ? 'deepseek-chat' : 'gpt-4o'
  const response = await client.chat.completions.create({
    model,
    max_tokens: 400,
    messages: [{ role: 'user', content: `Write a brief professional follow-up email for a job application.
Candidate applied for "${jobTitle}" at "${company}" and is following up to express continued interest.
2-3 short paragraphs. No markdown. End with candidate's name from the resume.
Return ONLY the email body text.

RESUME:
${masterResume.slice(0, 800)}` }],
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

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation, improveResume, generateCoverLetter, generateInterviewQuestions, analyzeKeywordGap, generateFollowUpEmail }
