// Prompt text shared by every provider adapter.
//
// Adapters normally carry their own prompt strings, which is fine while a
// prompt is a fixed block of text. The interview-preparation prompt is not: it
// changes shape depending on whether the employer has actually written back,
// and three copies of that branch in three adapters is three chances for one of
// them to quietly stop using the correspondence.

// The employer's own words about this interview beat anything inferable from
// the job ad — the round, the format, who is on the panel, what they said they
// want to cover. None of that is in the advert, and prep that ignores it is
// preparing for a different conversation.
function interviewQuestionsPrompt(jobDescription, masterResume, replyContext = '') {
  const thread = String(replyContext || '').trim()

  const base = `Generate 8 likely interview questions for this job with a tailored sample answer for each, based on the candidate's actual resume experience.
Return a JSON array: [{ "question": "...", "answer": "...", "category": "..." }, ...]
Category must be one of: "behavioral", "technical", "situational", "role-specific".
Include at least 2 behavioral, 2 technical, and mix the rest.
Answers should be 2-4 sentences, specific to the candidate's real experience. No markdown in answers.`

  if (!thread) {
    return `${base}

JOB: ${String(jobDescription || '').slice(0, 1000)}
RESUME: ${String(masterResume || '').slice(0, 1200)}`
  }

  return `${base}

The employer has replied to this application. Their messages are below. Use them as the PRIMARY guide to what this interview will actually cover:
- If they name the interview format (phone screen, technical, panel, take-home), weight the questions to that format and say so in the category.
- If they name interviewers or their roles, favour questions that person would ask.
- If they raise a specific topic, requirement or concern, cover it explicitly.
- If they state the round or stage, pitch the depth to that stage.
Do not invent details that are not in the messages or the job ad. Where the messages say nothing, fall back to the job description.

EMPLOYER MESSAGES:
${thread.slice(0, 4000)}

JOB: ${String(jobDescription || '').slice(0, 1000)}
RESUME: ${String(masterResume || '').slice(0, 1200)}`
}

module.exports = { interviewQuestionsPrompt }
