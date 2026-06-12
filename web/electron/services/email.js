const nodemailer = require('nodemailer')
const configService = require('./config')

function getEmailDomain(address) {
  return (address || '').split('@')[1]?.toLowerCase() || ''
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
  const talkingPoints = Array.isArray(job.talking_points)
    ? job.talking_points
    : JSON.parse(job.talking_points || '[]')

  const html = `
    <h2>New Job Found — Needs Manual Application</h2>
    <table>
      <tr><td><b>Role</b></td><td>${job.job_title}</td></tr>
      <tr><td><b>Company</b></td><td>${job.company}</td></tr>
      <tr><td><b>Platform</b></td><td>${job.platform}</td></tr>
      <tr><td><b>Salary</b></td><td>${job.salary || 'Not listed'}</td></tr>
      <tr><td><b>Match</b></td><td>${job.match_score}%</td></tr>
    </table>
    <p><a href="${job.job_url}">View Job Posting →</a></p>
    <h3>AI Talking Points</h3>
    <ul>${talkingPoints.map(p => `<li>${p}</li>`).join('')}</ul>
  `

  await transport.sendMail({
    from: cfg.gmailAddress,
    to: cfg.gmailAddress,
    subject: `[AutoApply] New Job: ${job.job_title} at ${job.company}`,
    html,
  })
}

async function sendDailyReport(stats) {
  const cfg = configService.load()
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) return

  const transport = createTransport(cfg)
  // Use the same response-rate the dashboard shows (interviews / non-skipped)
  const responseRate = stats.responseRate ?? 0

  const todayRows = (stats.todayJobs || [])
    .map(j => `<tr><td>${j.job_title}</td><td>${j.company}</td><td>${j.platform}</td><td>${j.match_score}%</td></tr>`)
    .join('')

  const html = `
    <h2>AutoApply Daily Report — ${new Date().toLocaleDateString()}</h2>
    <h3>Summary</h3>
    <table>
      <tr><td><b>Applied Today</b></td><td>${stats.totalToday}</td></tr>
      <tr><td><b>Applied This Week</b></td><td>${stats.totalThisWeek}</td></tr>
      <tr><td><b>Applied All Time</b></td><td>${stats.totalAllTime}</td></tr>
      <tr><td><b>Interviews</b></td><td>${stats.interviews}</td></tr>
      <tr><td><b>Response Rate</b></td><td>${responseRate}%</td></tr>
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
    subject: `[AutoApply] Daily Report — ${stats.totalToday} applications today`,
    html,
  })
}

async function sendFollowUpEmail(job, emailText, cfg) {
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) return
  const transport = createTransport(cfg)
  const to = job.recruiter_email || cfg.gmailAddress
  await transport.sendMail({
    from: cfg.gmailAddress,
    to,
    subject: `Follow-up: ${job.job_title} at ${job.company}`,
    text: emailText,
  })
}

module.exports = { testConnection, sendNewJobAlert, sendDailyReport, sendFollowUpEmail }
