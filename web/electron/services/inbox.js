const { ImapFlow } = require('imapflow')
const configService = require('./config')
const database = require('./database')
const aiAdapter = require('./ai/index')
const { parseInterviewTime } = require('./dateParser')

const REPLY_STATUSES = ['interview', 'rejected', 'offer', 'pending']

// How far back to re-scan on an incremental pass. The window starts at the
// last successful check minus this overlap, so a reply that arrived while a
// check was mid-flight (or with a slightly skewed server clock) isn't missed.
const OVERLAP_MS = 6 * 60 * 60 * 1000

// Download a matched message's text body and reduce it to a plain snippet the
// AI classifier can read. Best-effort — returns '' if the body can't be fetched.
async function fetchBodySnippet(client, uid) {
  try {
    const msg = await client.fetchOne(uid, { bodyParts: ['1', '1.1', 'text'] }, { uid: true })
    if (!msg || !msg.bodyParts) return ''
    let raw = ''
    for (const key of ['1', '1.1', 'text']) {
      const part = msg.bodyParts.get(key)
      if (part) { raw = part.toString('utf8'); break }
    }
    return raw
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500)
  } catch {
    return ''
  }
}

// Keyword-based reply classifier (no AI needed — fast and reliable)
function classifySubject(subject) {
  const s = (subject || '').toLowerCase()
  if (/interview|schedule.*meet|meet.*schedule|invitation|invite|phone screen|video call|zoom|teams meeting|book.*time|pick.*time|available.*chat/i.test(s)) return 'interview'
  if (/unfortunately|regret|not.*move forward|not.*proceed|unsuccessful|no longer|other candidate|filled.*position|position.*filled|not.*fit|decided.*not/i.test(s)) return 'rejected'
  return 'pending' // reply received but unclear — mark as pending for user review
}

// Words too generic to identify a company — matching on these produces
// false positives ("First Solutions" matching every "solutions" sender).
const GENERIC_COMPANY_WORDS = new Set([
  'the', 'and', 'for', 'group', 'pty', 'ltd', 'inc', 'llc', 'co', 'corp',
  'company', 'solutions', 'services', 'service', 'systems', 'system',
  'tech', 'technology', 'technologies', 'consulting', 'consultants',
  'global', 'digital', 'labs', 'lab', 'studio', 'studios', 'partners',
  'recruitment', 'recruiting', 'talent', 'australia', 'australian',
])

// SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC — make Date parse it as UTC
function parseSqliteUtc(s) {
  if (!s) return null
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

function getImapHost(address) {
  const domain = (address || '').split('@')[1]?.toLowerCase() || ''
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') return 'outlook.office365.com'
  if (domain === 'yahoo.com' || domain === 'ymail.com') return 'imap.mail.yahoo.com'
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') return 'imap.mail.me.com'
  return 'imap.gmail.com'
}

async function checkInbox() {
  const cfg = configService.load()
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) {
    throw new Error('Email address and App Password required. Configure them in Settings.')
  }

  const client = new ImapFlow({
    host: getImapHost(cfg.gmailAddress),
    port: 993,
    secure: true,
    auth: {
      user: cfg.gmailAddress,
      pass: cfg.gmailAppPassword,
    },
    logger: false,
  })

  const updated = []
  let checked = 0

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')

    try {
      const apps = database.getApplications({ status: 'applied' })
      // No applied applications — skip the search but still fall through to logout
      if (apps.length > 0) {

        // Search window. On the first run there's nothing to go on, so fall
        // back to the oldest application. After that, resume from the last
        // successful check (minus an overlap) — otherwise every pass re-fetched
        // every message received since the oldest application, which grows
        // without bound and re-downloads months of envelopes every 2 hours.
        const oldestApplied = new Date(
          Math.min(...apps.map(a => (parseSqliteUtc(a.applied_at) || new Date()).getTime()))
        )
        const lastCheck = cfg.lastInboxCheck ? new Date(cfg.lastInboxCheck) : null
        const since = (lastCheck && !isNaN(lastCheck.getTime()))
          ? new Date(Math.max(oldestApplied.getTime(), lastCheck.getTime() - OVERLAP_MS))
          : oldestApplied

        // Job platform domains to ignore — these are notifications, not recruiter replies
        const PLATFORM_DOMAINS = ['seek.com.au', 'seek.co.nz', 'indeed.com', 'linkedin.com',
          'noreply.linkedin.com', 'indeedemail.com', 'seek.com', 'jobseek.com']

        // Fetch all message envelopes since the oldest application
        const messages = []
        for await (const msg of client.fetch({ since }, { envelope: true })) {
          const from = msg.envelope.from?.[0]?.address?.toLowerCase() || ''
          const fromDomain = from.split('@')[1] || ''
          // Skip emails from job platforms — they're confirmations, not recruiter replies
          if (PLATFORM_DOMAINS.some(d => fromDomain === d || fromDomain.endsWith('.' + d))) continue
          messages.push({
            from,
            subject: msg.envelope.subject || '',
            date: msg.envelope.date,
            uid: msg.uid,
          })
          checked++
        }

        // Match messages to applications
        for (const app of apps) {
          const companyWords = app.company.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2 && !GENERIC_COMPANY_WORDS.has(w))
          if (companyWords.length === 0) continue // nothing distinctive to match on

          const jobWords = app.job_title.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 3)

          const appliedAt = parseSqliteUtc(app.applied_at)

          const match = messages.find(m => {
            // A reply can only arrive after the application was submitted
            if (appliedAt && m.date && new Date(m.date) < appliedAt) return false

            const fromDomain = (m.from.split('@')[1] || '').replace(/\./g, '')
            const subjectLower = m.subject.toLowerCase()

            // Domain matching needs a longer word — short fragments match too freely
            const domainMatch = companyWords.some(w => w.length >= 4 && fromDomain.includes(w))
            const subjectCompanyMatch = companyWords.some(w => subjectLower.includes(w))
            const subjectJobMatch = jobWords.some(w => subjectLower.includes(w))

            return domainMatch || (subjectCompanyMatch && subjectJobMatch)
          })

          if (match) {
            // Keyword guess on the subject is the fast baseline. When AI is
            // configured, read the email body to refine it (and catch 'offer',
            // which the keyword classifier can't detect). Any failure keeps the
            // baseline, so a flaky AI call never breaks the inbox check.
            let newStatus = classifySubject(match.subject)
            // The body is also what the interview-time parser reads, so fetch
            // it whenever the subject already looks like an interview, even
            // when no AI provider is configured.
            let body = ''
            const needsBody = !!(cfg.aiProvider && cfg.aiApiKey) || newStatus === 'interview'
            if (needsBody) body = await fetchBodySnippet(client, match.uid)

            if (cfg.aiProvider && cfg.aiApiKey) {
              try {
                const aiStatus = (await aiAdapter.classifyReply(
                  cfg.aiProvider, cfg.aiApiKey, match.subject, body, app.company, cfg.geminiModel
                )) || ''
                // Tolerate stray punctuation / wrapper text around the label.
                const matched = REPLY_STATUSES.find(s => aiStatus.includes(s))
                if (matched) newStatus = matched
              } catch { /* keep keyword result */ }
            }
            database.updateApplicationStatus(app.id, newStatus)

            // An interview reply usually proposes a time. Pull it out so the
            // user gets it on the dashboard instead of having to find the
            // email again. Best-effort and always editable in the UI.
            let interviewAt = null
            if (newStatus === 'interview') {
              if (!body) body = await fetchBodySnippet(client, match.uid)
              const parsed = parseInterviewTime(match.subject, body)
              if (parsed) {
                try {
                  database.upsertDetectedInterview({
                    applicationId: app.id,
                    scheduledAt: parsed.at,
                    hasTime: parsed.hasTime,
                    note: match.subject,
                  })
                  interviewAt = parsed.at
                } catch { /* scheduling is a bonus — never fail the inbox check */ }
              }
            }

            updated.push({
              id: app.id,
              job_title: app.job_title,
              company: app.company,
              newStatus,
              subject: match.subject,
              interviewAt,
            })
          }
        }
      }
    } finally {
      lock.release()
    }

    await client.logout()
  } catch (err) {
    await client.logout().catch(() => {})
    throw new Error(`Inbox check failed: ${err.message}`)
  }

  return { checked, updated }
}

module.exports = { checkInbox }
