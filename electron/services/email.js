const nodemailer = require('nodemailer')
const configService = require('./config')

function createTransport(cfg) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: cfg.gmailAddress,
      pass: cfg.gmailAppPassword,
    },
  })
}

async function testConnection(email, password) {
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: email, pass: password },
  })
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
  const responseRate = stats.totalAllTime > 0
    ? ((stats.interviews / stats.totalAllTime) * 100).toFixed(1)
    : 0

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

module.exports = { testConnection, sendNewJobAlert, sendDailyReport }
