const nodemailer = require('nodemailer')
const configService = require('./config')

function getEmailDomain(address) {
  return (address || '').split('@')[1]?.toLowerCase() || ''
}

// Job titles/companies/salaries come from scraped postings and AI output —
// escape them so a malicious posting can't inject markup into report emails.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function createTransport(cfg) {
  const domain = getEmailDomain(cfg.gmailAddress)
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') {
    return nodemailer.createTransport({
      host: 'smtp-mail.outlook.com', port: 587, secure: false,
      auth: { user: cfg.gmailAddress, pass: cfg.gmailAppPassword },
      tls: { ciphers: 'SSLv3' },
    })
  }
  if (domain === 'yahoo.com' || domain === 'ymail.com') {
    return nodemailer.createTransport({
      host: 'smtp.mail.yahoo.com', port: 465, secure: true,
      auth: { user: cfg.gmailAddress, pass: cfg.gmailAppPassword },
    })
  }
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') {
    return nodemailer.createTransport({
      host: 'smtp.mail.me.com', port: 587, secure: false,
      auth: { user: cfg.gmailAddress, pass: cfg.gmailAppPassword },
    })
  }
  // Default: Gmail
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.gmailAddress, pass: cfg.gmailAppPassword },
  })
}

async function testConnection(email, password) {
  const fakeCfg = { gmailAddress: email, gmailAppPassword: password }
  const transport = createTransport(fakeCfg)
  await transport.verify()
}

async function sendNewJobAlert(job) {
  const cfg = configService.load()
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) return

  const transport = createTransport(cfg)
  let talkingPoints = []
  if (Array.isArray(job.talking_points)) talkingPoints = job.talking_points
  else { try { talkingPoints = JSON.parse(job.talking_points || '[]') } catch { /* legacy/corrupt row */ } }

  const safeUrl = /^https?:\/\//i.test(job.job_url || '') ? esc(job.job_url) : ''
  const html = `
    <h2>New Job Found — Needs Manual Application</h2>
    <table>
      <tr><td><b>Role</b></td><td>${esc(job.job_title)}</td></tr>
      <tr><td><b>Company</b></td><td>${esc(job.company)}</td></tr>
      <tr><td><b>Platform</b></td><td>${esc(job.platform)}</td></tr>
      <tr><td><b>Salary</b></td><td>${esc(job.salary || 'Not listed')}</td></tr>
      <tr><td><b>Match</b></td><td>${esc(job.match_score)}%</td></tr>
    </table>
    ${safeUrl ? `<p><a href="${safeUrl}">View Job Posting →</a></p>` : ''}
    <h3>AI Talking Points</h3>
    <ul>${talkingPoints.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
  `

  await transport.sendMail({
    from: cfg.gmailAddress,
    to: cfg.gmailAddress,
    subject: `[Hiro] New Job: ${job.job_title} at ${job.company}`,
    html,
  })
}

async function sendDailyReport(stats) {
  const cfg = configService.load()
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) return

  const transport = createTransport(cfg)
  // Use the same rates the dashboard shows (see getStats)
  const responseRate = stats.responseRate ?? 0
  const interviewRate = stats.interviewRate ?? 0

  const todayRows = (stats.todayJobs || [])
    .map(j => `<tr><td>${esc(j.job_title)}</td><td>${esc(j.company)}</td><td>${esc(j.platform)}</td><td>${esc(j.match_score)}%</td></tr>`)
    .join('')

  const html = `
    <h2>Hiro Daily Report — ${new Date().toLocaleDateString()}</h2>
    <h3>Summary</h3>
    <table>
      <tr><td><b>Applied Today</b></td><td>${stats.totalToday}</td></tr>
      <tr><td><b>Applied This Week</b></td><td>${stats.totalThisWeek}</td></tr>
      <tr><td><b>Applied All Time</b></td><td>${stats.totalAllTime}</td></tr>
      ${stats.unsentToday ? `<tr><td><b>Skipped or held today</b></td><td>${stats.unsentToday}</td></tr>` : ''}
      <tr><td><b>Interviews</b></td><td>${stats.interviews}</td></tr>
      <tr><td><b>Response Rate</b></td><td>${responseRate}%</td></tr>
      <tr><td><b>Interview Rate</b></td><td>${interviewRate}%</td></tr>
      <tr><td><b>Needs Attention</b></td><td>${stats.attentionCount} jobs</td></tr>
    </table>
    ${todayRows ? `
    <h3>Jobs Applied Today</h3>
    <table border="1" cellpadding="6">
      <tr><th>Title</th><th>Company</th><th>Platform</th><th>Match</th></tr>
      ${todayRows}
    </table>` : '<p>No applications today.</p>'}
  `

  await transport.sendMail({
    from: cfg.gmailAddress,
    to: cfg.gmailAddress,
    subject: `[Hiro] Daily Report — ${stats.totalToday} applications today`,
    html,
  })
}

// Callers must supply a job with a recruiter_email — the scheduler skips jobs
// without one before it gets here. Refuse rather than silently mailing the
// user their own follow-up, which reads like a delivery but reaches nobody.
async function sendFollowUpEmail(job, emailText, cfg) {
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) return
  if (!job.recruiter_email) throw new Error('No recruiter email on file for this application')
  const transport = createTransport(cfg)
  await transport.sendMail({
    from: cfg.gmailAddress,
    to: job.recruiter_email,
    subject: `Follow-up: ${job.job_title} at ${job.company}`,
    text: emailText,
  })
}

module.exports = { testConnection, sendNewJobAlert, sendDailyReport, sendFollowUpEmail }
