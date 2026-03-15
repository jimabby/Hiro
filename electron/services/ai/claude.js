const Anthropic = require('@anthropic-ai/sdk')

// Strip markdown code fences that AI models sometimes wrap JSON in
function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

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
Keep it truthful — only rephrase and emphasise existing experience to match the job.
IMPORTANT: Preserve the EXACT section names, section order, and overall structure of the master resume. Do NOT add, remove, or reorder sections. Do NOT invent new experience.
Return ONLY the plain text resume. No markdown, no asterisks, no pound signs, no bold/italic markers.
Use the same section headers and bullet style as the original.

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

IMPORTANT RULES:
- If the question asks whether you have experience with something, ALWAYS answer Yes.
- If the question asks how many years of experience, answer at least 3. You may answer more if the resume supports it, but NEVER less than 3.
- If the question has specific options listed, pick the one that best represents the candidate positively.
- Keep answers short — just the answer, no explanation.

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

async function generateCoverLetter(jobDescription, masterResume, apiKey, _geminiModel, tone, template) {
  const client = new Anthropic({ apiKey })
  const toneInstruction = tone === 'casual' ? 'Write in a warm, approachable, conversational tone.' : tone === 'confident' ? 'Write with assertive, direct confidence — lead with impact.' : ''
  const templateInstruction = template ? `Use the following as the structural base, filling in job-specific details:\n\n${template}\n\n` : ''
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
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
  return response.content[0].text
}

async function scoreMatchWithExplanation(jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: `Score how well this resume matches this job description.
Return JSON only: { "score": 85, "explanation": "one sentence explanation" }
Score 0-100. Plain text explanation, no markdown.

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}` }],
  })
  try {
    const parsed = JSON.parse(response.content[0].text)
    const score = parseInt(parsed.score, 10)
    return { score: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)), explanation: parsed.explanation || '' }
  } catch {
    const score = parseInt(response.content[0].text.trim(), 10)
    return { score: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)), explanation: '' }
  }
}

async function generateInterviewQuestions(jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{ role: 'user', content: `Generate 8 likely interview questions for this job with a tailored sample answer for each, based on the candidate's actual resume experience.
Return a JSON array: [{ "question": "...", "answer": "..." }, ...]
Answers should be 2-4 sentences, specific to the candidate's real experience. No markdown in answers.

JOB: ${jobDescription.slice(0, 1000)}
RESUME: ${masterResume.slice(0, 1200)}` }],
  })
  try { return parseJSON(response.content[0].text) }
  catch { return [] }
}

async function analyzeKeywordGap(jobDescription, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: `Analyze which key skills and qualifications from this job are present or missing in this resume.
Return JSON only, no code fences: { "missing": ["skill1", ...], "present": ["skill2", ...] }
Max 10 items each. Focus on specific technical skills, tools, certifications.

JOB: ${jobDescription.slice(0, 1000)}
RESUME: ${masterResume.slice(0, 800)}` }],
  })
  try { return parseJSON(response.content[0].text) }
  catch { return { missing: [], present: [] } }
}

async function generateFollowUpEmail(jobTitle, company, masterResume, apiKey) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: `Write a brief professional follow-up email for a job application.
Candidate applied for "${jobTitle}" at "${company}" and is following up to express continued interest.
2-3 short paragraphs. No markdown. End with candidate's name from the resume.
Return ONLY the email body text.

RESUME:
${masterResume.slice(0, 800)}` }],
  })
  return response.content[0].text
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
IMPORTANT: Preserve ALL contact information exactly as provided — name, email, phone number, address, portfolio URL, LinkedIn URL, and any other links. These must appear at the top unchanged.
Return ONLY the plain text resume, no commentary. No markdown, no asterisks, no pound signs, no bold/italic markers.
Use plain section headers (e.g. "EXPERIENCE", "SKILLS") and plain hyphens or dashes for bullets.

RESUME:
${resumeText}`,
    }],
  })
  return response.content[0].text
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation, improveResume, generateCoverLetter, generateInterviewQuestions, analyzeKeywordGap, generateFollowUpEmail }
