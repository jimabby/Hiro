const OpenAI = require('openai')
const { withUsage } = require('./usage')
const { interviewQuestionsPrompt } = require('./prompts')

// Named so a model change is one edit rather than a dozen.
const FAST_MODEL = 'gpt-4o-mini'
const SMART_MODEL = 'gpt-4o'
const DEEPSEEK_MODEL = 'deepseek-chat'

// Every OpenAI-compatible endpoint runs through this adapter; a "flavour" says
// which one and what to call there. DeepSeek passed a bare baseURL string and
// the model was then inferred from `baseURL ? … : …` at a dozen call sites —
// which worked for exactly two providers and could not express a third. A local
// server (Ollama, LM Studio, llama.cpp) is a third: same wire protocol, its own
// address, and a model name only the user knows.
const OPENAI_FLAVOUR = { baseURL: undefined, provider: 'chatgpt', fast: FAST_MODEL, smart: SMART_MODEL }
const DEEPSEEK_FLAVOUR = { baseURL: 'https://api.deepseek.com', provider: 'deepseek', fast: DEEPSEEK_MODEL, smart: DEEPSEEK_MODEL }

// Accepts the legacy bare-string baseURL (DeepSeek) as well as a descriptor, so
// deepseek.js needs no change.
function resolve(flavour) {
  if (!flavour) return OPENAI_FLAVOUR
  if (typeof flavour === 'string') return { ...DEEPSEEK_FLAVOUR, baseURL: flavour }
  const model = flavour.model || FAST_MODEL
  return {
    baseURL: flavour.baseURL,
    provider: flavour.provider || 'local',
    fast: flavour.fast || model,
    smart: flavour.smart || model,
  }
}

function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

function getClient(apiKey, baseURL) {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
}

// Single entry point for every request, so retry/backoff, the monthly budget
// cap and cost accounting apply uniformly rather than being remembered at a
// dozen call sites. Each flavour is recorded under its own provider name so the
// cost breakdown stays honest.
async function complete(operation, flavour, apiKey, params) {
  const f = resolve(flavour)
  return withUsage(operation, f.provider, async () => {
    const client = getClient(apiKey, f.baseURL)
    const response = await client.chat.completions.create(params)
    return {
      value: response.choices?.[0]?.message?.content ?? '',
      model: params.model,
      usage: response.usage,
    }
  })
}

async function testConnection(apiKey, flavour) {
  await complete('testConnection', flavour, apiKey, {
    model: resolve(flavour).fast,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  })
}

async function tailorResume(jobDescription, masterResume, apiKey, flavour) {
  const model = resolve(flavour).smart
  const text = await complete('tailorResume', flavour, apiKey, {
    model,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are an expert resume writer. Tailor the following resume for the job description below.
Keep it truthful — only rephrase and emphasise existing experience to match the job.
IMPORTANT: Preserve the EXACT section names, section order, and overall structure of the master resume. Do NOT add, remove, or reorder sections. Do NOT invent new experience.
Return ONLY the tailored resume text, no commentary.

JOB DESCRIPTION:
${jobDescription}

MASTER RESUME:
${masterResume}`,
    }],
  })
  return text
}

async function answerScreeningQuestion(question, jobDescription, masterResume, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('answerScreeningQuestion', flavour, apiKey, {
    model,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Answer this job application screening question concisely and professionally.
Base your answer on the resume and job context provided.

IMPORTANT RULES:
- Base every answer on the resume — do not claim experience the resume doesn't support.
- If the question asks how many years of experience, estimate honestly from the resume's dates.
- If the question has specific options listed, pick the one the resume best supports, presented positively.
- If the resume doesn't contain enough information to answer truthfully, reply exactly: NOT SURE
- Keep answers short — just the answer, no explanation.

QUESTION: ${question}
JOB: ${jobDescription.slice(0, 500)}
RESUME: ${masterResume.slice(0, 1000)}

Return ONLY the answer, no commentary.`,
    }],
  })
  return text
}

async function generateTalkingPoints(jobDescription, masterResume, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('generateTalkingPoints', flavour, apiKey, {
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
    return parseJSON(text)
  } catch {
    return [text]
  }
}

async function scoreMatch(jobDescription, masterResume, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('scoreMatch', flavour, apiKey, {
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
  const score = parseInt(text.trim(), 10)
  return isNaN(score) ? 50 : Math.min(100, Math.max(0, score))
}

async function generateCoverLetter(jobDescription, masterResume, apiKey, flavour, tone, template) {
  const model = resolve(flavour).smart
  const toneInstruction = tone === 'casual' ? 'Write in a warm, approachable, conversational tone.' : tone === 'confident' ? 'Write with assertive, direct confidence — lead with impact.' : ''
  const templateInstruction = template ? `Use the following as the structural base, filling in job-specific details:\n\n${template}\n\n` : ''
  const text = await complete('generateCoverLetter', flavour, apiKey, {
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
  return text
}

async function scoreMatchWithExplanation(jobDescription, masterResume, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('scoreMatchWithExplanation', flavour, apiKey, {
    model,
    max_tokens: 200,
    messages: [{ role: 'user', content: `Score how well this resume matches this job description.
Return JSON only: { "score": 85, "explanation": "one sentence explanation" }
Score 0-100. Plain text explanation, no markdown.

JOB: ${jobDescription.slice(0, 800)}
RESUME: ${masterResume.slice(0, 1000)}` }],
  })
  try {
    const parsed = parseJSON(text)
    const score = parseInt(parsed.score, 10)
    return { score: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)), explanation: parsed.explanation || '' }
  } catch {
    const score = parseInt(text.trim(), 10)
    return { score: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)), explanation: '' }
  }
}

async function generateInterviewQuestions(jobDescription, masterResume, apiKey, flavour, replyContext) {
  const model = resolve(flavour).smart
  const text = await complete('generateInterviewQuestions', flavour, apiKey, {
    model,
    max_tokens: 3000,
    messages: [{ role: 'user', content: interviewQuestionsPrompt(jobDescription, masterResume, replyContext) }],
  })
  try { return parseJSON(text) }
  catch { return [] }
}

async function generateFollowUpQuestion(question, userAnswer, jobDescription, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('generateFollowUpQuestion', flavour, apiKey, {
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: `You are an interview coach. The candidate was asked this interview question and gave the answer below. Generate ONE follow-up probe question an interviewer might ask to dig deeper.
Return ONLY the follow-up question text, nothing else.

ORIGINAL QUESTION: ${question}
CANDIDATE'S ANSWER: ${userAnswer}
JOB CONTEXT: ${(jobDescription || '').slice(0, 500)}` }],
  })
  return text.trim()
}

async function analyzeKeywordGap(jobDescription, masterResume, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('analyzeKeywordGap', flavour, apiKey, {
    model,
    max_tokens: 600,
    messages: [{ role: 'user', content: `Analyze which key skills and qualifications from this job are present or missing in this resume.
Return JSON only, no code fences: { "missing": ["skill1", ...], "present": ["skill2", ...] }
Max 10 items each. Focus on specific technical skills, tools, certifications.

JOB: ${jobDescription.slice(0, 1000)}
RESUME: ${masterResume.slice(0, 800)}` }],
  })
  try { return parseJSON(text) }
  catch { return { missing: [], present: [] } }
}

async function generateFollowUpEmail(jobTitle, company, masterResume, apiKey, flavour) {
  const model = resolve(flavour).smart
  const text = await complete('generateFollowUpEmail', flavour, apiKey, {
    model,
    max_tokens: 400,
    messages: [{ role: 'user', content: `Write a brief professional follow-up email for a job application.
Candidate applied for "${jobTitle}" at "${company}" and is following up to express continued interest.
2-3 short paragraphs. No markdown. End with candidate's name from the resume.
Return ONLY the email body text.

RESUME:
${masterResume.slice(0, 800)}` }],
  })
  return text
}

async function improveResume(resumeText, apiKey, flavour) {
  const model = resolve(flavour).smart
  const text = await complete('improveResume', flavour, apiKey, {
    model,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are an expert resume writer. Improve the following resume to be more impactful, professional, and ATS-friendly.
Strengthen bullet points, improve language clarity, and highlight achievements with metrics where possible.
Keep all facts truthful and accurate — do not invent experience.
IMPORTANT: Preserve ALL contact information exactly as provided — name, email, phone number, address, portfolio URL, LinkedIn URL, and any other links. These must appear at the top unchanged.
Return ONLY the improved resume text, no commentary. No markdown, no asterisks, no pound signs, no bold/italic markers.
Use plain section headers (e.g. "EXPERIENCE", "SKILLS") and plain hyphens or dashes for bullets.

RESUME:
${resumeText}`,
    }],
  })
  return text
}

// Classify a recruiter's reply into an application status. Returns one of
// 'interview' | 'rejected' | 'offer' | 'pending' (pending = reply received but
// outcome unclear). Used by the inbox checker to refine the keyword guess.
async function classifyReply(subject, body, company, apiKey, flavour) {
  const model = resolve(flavour).fast
  const text = await complete('classifyReply', flavour, apiKey, {
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: `Classify this reply to a job application at "${company}" into exactly one label:
- interview: invites/schedules an interview, phone screen, or call
- offer: extends a job offer
- rejected: declines the candidate / position filled / unsuccessful
- pending: a reply was received but the outcome is unclear (acknowledgements, requests for info)
Reply with ONLY the single lowercase label.

SUBJECT: ${(subject || '').slice(0, 200)}
BODY: ${(body || '').slice(0, 1500)}` }],
  })
  return (text || '').trim().toLowerCase()
}

module.exports = { testConnection, tailorResume, answerScreeningQuestion, generateTalkingPoints, scoreMatch, scoreMatchWithExplanation, improveResume, generateCoverLetter, generateInterviewQuestions, generateFollowUpQuestion, analyzeKeywordGap, generateFollowUpEmail, classifyReply }
