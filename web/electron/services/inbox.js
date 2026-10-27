const { ImapFlow } = require('imapflow')
const mailProvider = require('./mailProvider')
const configService = require('./config')
const database = require('./database')
const aiAdapter = require('./ai/index')
const { isAiConfigured } = require('./ai/configured')
const { isAcknowledgement, mightBeAcknowledgement } = require('./replyFilter')
const { parseInterviewTime } = require('./dateParser')

const REPLY_STATUSES = ['interview', 'rejected', 'offer', 'pending']

// Rows already past the first reply. database.OPEN_STATUSES keeps them in the
// inbox's scope so the rejection or offer after an interview is read, but an
// email may only move them FORWARD: an unclassifiable "thanks, see you
// Tuesday" (→ 'pending') must not demote an interview back to "reply
// received". Anything other than a forward move keeps the current status.
const INTERVIEW_STAGE_STATUSES = new Set(['interview'])
const FORWARD_FROM_INTERVIEW = new Set(['interview', 'offer', 'rejected'])

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

// Keyword-based reply classifier (no AI needed — fast and reliable).
//
// Rejection is tested FIRST, and that ordering is the whole point. A rejection
// very often names the thing it is rejecting you from — "Interview outcome —
// unfortunately unsuccessful", "Following your interview, we've decided not to
// proceed" — so both patterns match and whichever runs first wins. Reading that
// as an interview invitation is the worse of the two mistakes by a wide margin:
// it puts a phantom interview on the dashboard and, when a date is parsed out of
// the quoted thread below, into the user's calendar.
//
// The AI classifier refines this when a provider is configured; this is the
// fallback that has to stand on its own when one is not.
function classifySubject(subject) {
  const s = (subject || '').toLowerCase()
  // `mov(?:e|ing)` and `progress(?:ing)?` because "we will not be moving
  // forward" is at least as common a phrasing as "we will not move forward",
  // and the literal form missed it — so the most standard rejection sentence in
  // the language fell through to 'pending'.
  //
  // Every pattern is anchored on word boundaries and bounded in distance (and
  // kept within one sentence — `[^.]`). The unanchored forms read
  // "Interview notification - … benefits inside" as `not.*fit` and "Your
  // application is in progress" (after "Notification:") as `not.*progress`, so
  // ordinary updates — and any company called Notion or Nothing — classified
  // as rejections.
  if (/\bunfortunately\b|\bregret\b|\bnot\b[^.]{0,40}\bmov(?:e|ing) forward\b|\bnot\b[^.]{0,30}\bproceed(?:ing)?\b|\bnot\b[^.]{0,30}\bprogress(?:ing)?\b|\bunable to (?:offer|proceed|progress)\b|\bunsuccessful\b|\bno longer\b[^.]{0,30}\b(?:consider\w*|available|open|proceed\w*|pursu\w*|recruit\w*|hiring|moving)\b|\bother candidates?\b|\bfilled\b[^.]{0,30}\b(?:position|role|vacancy)\b|\b(?:position|role|vacancy)\b[^.]{0,30}\bfilled\b|\bnot\b[^.]{0,40}\bfit\b|\bdecided\b[^.]{0,30}\bnot\b/i.test(s)) return 'rejected'
  // "schedule a call" / "set up a chat" are invitations as plainly as
  // "schedule a meeting" is; only the meeting wording was matched.
  if (/\binterview|\bschedul\w*[^.]{0,40}\b(?:meet|call|chat|time|interview)|\bmeet\w*[^.]{0,30}\bschedule|\bset up\b[^.]{0,30}\b(?:call|chat|meeting)\b|\binvitation\b|\binvit(?:e|ed|ing)\b|\bphone screen|\bvideo call\b|\bzoom\b|\bteams meeting\b|\bbook\b[^.]{0,30}\btime\b|\bpick\b[^.]{0,30}\btime\b|\bavailable\b[^.]{0,30}\bchat\b/i.test(s)) return 'interview'
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

// ─── Which messages are replies, and to which application ────────

// Job platforms' own notifications — not recruiter replies. Their job-alert
// emails are read separately, by services/jobAlerts.js.
const PLATFORM_DOMAINS = ['seek.com.au', 'seek.co.nz', 'indeed.com', 'linkedin.com',
  'noreply.linkedin.com', 'indeedemail.com', 'seek.com', 'jobseek.com']

// Applicant-tracking systems that mail candidates on an employer's behalf. Their
// sender domain is never the company's, so the company has to be named in the
// message instead.
const ATS_DOMAINS = ['greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'myworkday.com', 'workday.com',
  'smartrecruiters.com', 'smartrecruiters-mail.com', 'ashbyhq.com', 'icims.com', 'jobvite.com', 'workable.com',
  'bamboohr.com', 'recruitee.com', 'teamtailor.com', 'teamtailor-mail.com', 'pageuppeople.com',
  'successfactors.com', 'taleo.net', 'breezy.hr', 'jazzhr.com', 'applytojob.com', 'jobadder.com']

const isDomainIn = (domain, list) => list.some(d => domain === d || domain.endsWith(`.${d}`))

// A subject that is commerce or account housekeeping, never a hiring decision.
const TRANSACTIONAL_RE = /\b(?:your order|order (?:#|no\b|number|confirm\w*|status|update|details)|(?:has|have) (?:been )?(?:shipped|dispatched|delivered)|shipping|shipment|out for delivery|tracking number|receipt for|your receipt|invoice|payment (?:received|failed|due)|refund|subscription|renewal|password|verification code|verify your (?:email|account)|security alert|sign[- ]in attempt|newsletter|% off|sale ends|your cart|wish ?list)\b/i

// Automated senders. Allowed through only when the subject is about hiring or
// the sender is an ATS — a no-reply rejection from Greenhouse is still a reply.
const AUTOMATED_SENDER_RE = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?|alerts?|news(?:letter)?|marketing|promo\w*|deals|offers|updates?|shipment[-_.]?tracking|auto[-_.]?confirm|orders?|store|shop|billing|accounts?|security)[^@]*@/i

const RECRUITING_RE = /\b(?:applica\w*|applied|applying|candida\w*|interview\w*|position|role|vacanc\w*|recruit\w*|hiring|talent|careers?|resume|résumé|cv|job|opportunit\w*|shortlist\w*|offer of employment)\b/i

function isNoise(m) {
  if (TRANSACTIONAL_RE.test(m.subject || '')) return true
  const domain = (m.from.split('@')[1] || '')
  if (AUTOMATED_SENDER_RE.test(m.from) && !isDomainIn(domain, ATS_DOMAINS) && !RECRUITING_RE.test(m.subject || '')) return true
  return false
}

// The References header as a list of Message-IDs. imapflow hands back the raw
// requested header lines as a Buffer.
function parseReferences(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')
  // Not multiline: `$` must mean the end of the block, and a folded header
  // continues on lines that start with whitespace.
  const m = /(?:^|\n)references:[ \t]*([\s\S]*?)(?:\r?\n(?![ \t])|$)/i.exec(text)
  return m ? (m[1].match(/<[^>]+>/g) || []) : []
}

function companyWordsOf(app) {
  return String(app.company || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC_COMPANY_WORDS.has(w))
}

const TITLE_FILLER = new Set(['with', 'from', 'role', 'position', 'team', 'remote', 'hybrid', 'full', 'time', 'part', 'contract', 'permanent'])
function titleWordsOf(app) {
  return String(app.job_title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !TITLE_FILLER.has(w))
}

// How much of an application's job title the text names, 0–1.
function titleScore(app, text) {
  const words = titleWordsOf(app)
  if (words.length === 0) return 0
  const hay = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `
  return words.filter(w => hay.includes(` ${w} `)).length / words.length
}

// Of several applications this email could be about, the one its text names —
// or null when no single one stands out.
function disambiguate(candidates, text) {
  const scored = candidates.map(app => ({ app, score: titleScore(app, text) })).sort((a, b) => b.score - a.score)
  if (scored[0].score === 0) return null
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.25) return null
  return scored[0].app
}

function appliedBefore(app, m) {
  const appliedAt = parseSqliteUtc(app.applied_at)
  return !(appliedAt && m.date && new Date(m.date) < appliedAt)
}

// Match one message to an application.
//
// Returns { app, kind, named } — kind is 'thread' | 'recruiter' | 'company', and
// `named` says the message names the role — or { ambiguous: [apps] } when it
// belongs to one of several applications and nothing says which, or null.
//
// In order of how much they prove:
//   1. Thread. In-Reply-To / References carries the Message-ID of a follow-up
//      Hiro sent (sent_messages), which names exactly one application.
//   2. A recruiter address already on file for an application.
//   3. The company — by sender domain, by an ATS sender naming it, or by the
//      subject naming both company and role — and, where that leaves more than
//      one application, by which job title the subject or body names.
async function matchMessage(m, apps, { bodyOf = async () => '', findByMessageIds = database.findApplicationByMessageIds } = {}) {
  const open = apps.filter(a => appliedBefore(a, m))
  if (open.length === 0) return null

  // 1. Thread
  const ids = [m.inReplyTo, ...(m.references || [])].filter(Boolean)
  if (ids.length) {
    let appId = null
    try { appId = findByMessageIds(ids) } catch { /* table not there yet */ }
    const app = appId != null && open.find(a => a.id === appId)
    if (app) return { app, kind: 'thread', named: true }
  }

  let body = null
  const text = async () => {
    if (body == null) body = String(await bodyOf(m.uid) || '')
    return `${m.subject}\n${body}`
  }

  // 2. Known recruiter address
  const byRecruiter = open.filter(a => a.recruiter_email && a.recruiter_email.toLowerCase() === m.from)
  if (byRecruiter.length === 1) return { app: byRecruiter[0], kind: 'recruiter', named: titleScore(byRecruiter[0], m.subject) > 0 }
  if (byRecruiter.length > 1) {
    const t = await text()
    const app = disambiguate(byRecruiter, t)
    return app ? { app, kind: 'recruiter', named: true } : { ambiguous: byRecruiter }
  }

  // 3. Company
  const domain = m.from.split('@')[1] || ''
  const flatDomain = domain.replace(/\./g, '')
  const viaAts = isDomainIn(domain, ATS_DOMAINS)
  const subjectLower = m.subject.toLowerCase()
  const candidates = []
  let domainOnly = true
  for (const app of open) {
    const words = companyWordsOf(app)
    if (words.length === 0) continue // nothing distinctive to match on
    // Domain matching needs a longer word — short fragments match too freely.
    const domainMatch = !viaAts && words.some(w => w.length >= 4 && flatDomain.includes(w))
    const subjectCompany = words.some(w => subjectLower.includes(w))
    const subjectRole = titleWordsOf(app).some(w => subjectLower.includes(w))
    if (domainMatch || (subjectCompany && subjectRole) || (viaAts && subjectCompany)) {
      candidates.push(app)
      if (!domainMatch || subjectCompany) domainOnly = false
    }
  }
  if (candidates.length === 0) return null

  // A match resting on the sender's domain alone must at least be about
  // hiring. Anyone at a large employer can email you about anything.
  if (domainOnly && !RECRUITING_RE.test(await text())) return null

  if (candidates.length === 1) {
    const app = candidates[0]
    const named = titleScore(app, m.subject) > 0 || titleScore(app, await text()) >= 0.5
    return { app, kind: 'company', named }
  }
  const app = disambiguate(candidates, await text())
  return app ? { app, kind: 'company', named: true } : { ambiguous: candidates }
}

// Replies already handed to the user as ambiguous in this session, so the
// overlap window does not announce them again on the next check.
const announcedAmbiguous = new Set()

// Server selection lives in services/mailProvider.js, shared with the SMTP side.
// Reading replies and sending reports have to agree about which account this is:
// a setup that can send but not read presents as "replies are never detected",
// which is far harder to notice than a connection that simply fails.

// One check at a time. The schedule, the tray and the "Check now" button can
// all start one, and two overlapping passes read the same messages and announce
// the same reply twice — two pushes, two webhooks, two desktop notifications.
// A caller that arrives mid-check shares the result of the check in flight.
let inFlight = null

function checkInbox() {
  if (inFlight) return inFlight
  inFlight = runCheck().finally(() => { inFlight = null })
  return inFlight
}

async function runCheck() {
  const cfg = configService.load()
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) {
    throw new Error('Email address and App Password required. Configure them in Settings.')
  }

  const { imap } = mailProvider.resolve(cfg)
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: {
      user: cfg.imapUser || cfg.smtpUser || cfg.gmailAddress,
      pass: cfg.gmailAppPassword,
    },
    logger: false,
  })

  const updated = []
  const needsReview = []
  const invitations = []
  let checked = 0

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')

    try {
      // Every application still waiting on an outcome — not just 'applied'.
      // 'pending' (a reply we couldn't classify) and 'no_response' (we stopped
      // waiting) stay in scope, so a follow-up email that finally schedules an
      // interview is picked up instead of being invisible forever.
      const apps = database.getApplicationsAwaitingReply()
      // Nothing open — skip the search but still fall through to logout
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

        // Fetch every message since the window opened, with the threading
        // headers. In-Reply-To arrives in the envelope; References does not.
        const messages = []
        for await (const msg of client.fetch({ since }, { envelope: true, headers: ['references'] })) {
          const from = msg.envelope.from?.[0]?.address?.toLowerCase() || ''
          const fromDomain = from.split('@')[1] || ''
          // Skip emails from job platforms — they're confirmations, not
          // recruiter replies. (Their job-alert emails are read separately, by
          // services/jobAlerts.js.)
          if (PLATFORM_DOMAINS.some(d => fromDomain === d || fromDomain.endsWith('.' + d))) continue
          const parsed = {
            from,
            subject: msg.envelope.subject || '',
            date: msg.envelope.date,
            uid: msg.uid,
            messageId: msg.envelope.messageId || '',
            inReplyTo: msg.envelope.inReplyTo || '',
            references: parseReferences(msg.headers),
          }
          checked++
          // Order confirmations, shipping notices, password resets and the
          // like. A shop the user ordered from can also be a company they
          // applied to, and "item no longer available" read as a rejection.
          if (isNoise(parsed)) continue
          messages.push(parsed)
        }

        // Bodies are downloaded at most once per message per check: matching
        // may need one to tell two applications apart, and classification
        // needs the same one afterwards.
        const bodies = new Map()
        const bodyOf = (uid) => {
          if (!bodies.has(uid)) bodies.set(uid, fetchBodySnippet(client, uid))
          return bodies.get(uid)
        }

        // Match each message to at most ONE application — by thread, then by a
        // known recruiter address, then by company with disambiguation. This
        // used to run the other way round: each application took the newest
        // email from its company's domain, so one rejection from Atlassian
        // rejected every open Atlassian application at once.
        //
        // Newest first, so the first message assigned to an application is the
        // newest — a recruiter thread produces several, and the latest one
        // carries the current state of the conversation.
        messages.sort((a, b) => {
          const ta = a.date ? new Date(a.date).getTime() : 0
          const tb = b.date ? new Date(b.date).getTime() : 0
          return tb - ta || b.uid - a.uid
        })
        const assignments = new Map()
        for (const m of messages) {
          const result = await matchMessage(m, apps, { bodyOf })
          if (result?.app) {
            if (!assignments.has(result.app.id)) assignments.set(result.app.id, { msg: m, kind: result.kind, named: result.named })
          } else if (result?.ambiguous && !announcedAmbiguous.has(m.uid)) {
            // Several open applications at this employer and nothing in the
            // email says which one it is about. Changing any status would be a
            // guess, so none is changed and the reply is handed to the user.
            announcedAmbiguous.add(m.uid)
            needsReview.push({
              uid: m.uid,
              from: m.from,
              subject: m.subject,
              receivedAt: m.date ? new Date(m.date).toISOString() : null,
              company: result.ambiguous[0].company,
              candidates: result.ambiguous.map(a => ({ id: a.id, job_title: a.job_title, company: a.company })),
            })
          }
        }

        for (const app of apps) {
          const assigned = assignments.get(app.id)
          const match = assigned?.msg

          if (match) {
            // Already classified this exact email on an earlier pass. Now that
            // non-terminal statuses stay in scope, without this check every
            // pass would re-download the body and re-run the AI classifier on
            // the same message for the same (unchanged) result.
            if (app.last_reply_uid != null && match.uid === app.last_reply_uid) continue

            // Keyword guess on the subject is the fast baseline. When AI is
            // configured, read the email body to refine it (and catch 'offer',
            // which the keyword classifier can't detect). Any failure keeps the
            // baseline, so a flaky AI call never breaks the inbox check.
            let newStatus = classifySubject(match.subject)
            // The body is also what the interview-time parser reads, so fetch
            // it whenever the subject already looks like an interview, even
            // when no AI provider is configured.
            let body = ''
            // A subject that reads like an automated receipt needs its body
            // read before it can be dismissed — see services/replyFilter.js.
            const needsBody = isAiConfigured(cfg) || newStatus === 'interview'
              || (newStatus === 'pending' && mightBeAcknowledgement(match.subject))
            if (needsBody) body = await bodyOf(match.uid)

            let acknowledgement = false
            if (isAiConfigured(cfg)) {
              try {
                const aiStatus = (await aiAdapter.classifyReply(
                  cfg.aiProvider, cfg.aiApiKey, match.subject, body, app.company, cfg.geminiModel
                )) || ''
                // Tolerate stray punctuation / wrapper text around the label.
                if (aiStatus.includes('acknowledg')) acknowledgement = true
                const matched = REPLY_STATUSES.find(s => aiStatus.includes(s))
                if (matched) newStatus = matched
              } catch { /* keep keyword result */ }
            }

            // The ATS confirming it received the form. Not a reply: remember it
            // was seen so it is not re-read, and leave the application where it
            // was — still 'applied', still due its follow-up, and not counted as
            // a response.
            if (acknowledgement || (newStatus === 'pending' && isAcknowledgement(match.subject, body))) {
              database.setLastReplyUid(app.id, match.uid)
              continue
            }
            // An interview or offer reply is exactly the one worth keeping in
            // full, and the keyword path may have reached that verdict without
            // ever downloading the body. Fetch it now, before it is stored —
            // the interview-time parser below needs it anyway.
            if (!body && (newStatus === 'interview' || newStatus === 'offer')) {
              body = await bodyOf(match.uid)
            }

            // What the email itself said, before the row's stage is applied.
            // Everything interview-specific below (storing it as an interview
            // reply, parsing a time, drafting availability) keys on this: on a
            // row already at interview, "Thanks, we'll be in touch" clamps to
            // 'interview' as a status but is not an invitation.
            const verdict = newStatus
            if (INTERVIEW_STAGE_STATUSES.has(app.status) && !FORWARD_FROM_INTERVIEW.has(newStatus)) {
              newStatus = app.status
            }
            // The interview the row is already at is not news, and re-writing it
            // would add a duplicate entry to the status timeline.
            if (newStatus !== app.status) database.updateApplicationStatus(app.id, newStatus)
            database.setLastReplyUid(app.id, match.uid)

            // Keep what they actually wrote. It was already downloaded to
            // classify the reply and was then discarded — and it is the only
            // record of the interview format, the panel, and the round, none of
            // which the job ad knows. Interview prep reads it from here.
            //
            // Best-effort: an inbox check must never fail because a body could
            // not be stored.
            try {
              database.saveRecruiterReply({
                applicationId: app.id,
                uid: match.uid,
                from: match.from,
                subject: match.subject,
                body,
                classifiedAs: verdict,
                receivedAt: match.date ? new Date(match.date).toISOString() : null,
              })
            } catch { /* the reply log is a bonus, never a blocker */ }

            // The sender of a real reply is the best follow-up address there
            // is — a human who has already read the application. Without this,
            // recruiter_email stayed blank and auto follow-up skipped the job.
            //
            // Only from an email that is demonstrably about THIS application —
            // a reply in its thread, or one that names the role. A message
            // matched on the company's domain alone may be from anyone there
            // (or an automated sender), and follow-ups would go to them.
            const aboutThisJob = assigned.kind === 'thread' || assigned.named
            if (cfg.extractRecruiterEmail !== false && !app.recruiter_email && aboutThisJob) {
              try {
                const { recruiterEmailFromReply } = require('./contactExtractor')
                const contact = recruiterEmailFromReply(match.from, { company: app.company })
                if (contact) database.updateRecruiterEmail(app.id, contact)
              } catch { /* contact capture is a bonus — never fail the check */ }
            }

            // An interview reply usually proposes a time. Pull it out so the
            // user gets it on the dashboard instead of having to find the
            // email again. Best-effort and always editable in the UI.
            let interviewAt = null
            // The zone the employer wrote, when they wrote one — carried into the
            // notification so "interview detected for …" can say whose clock.
            let interviewZone = null
            if (verdict === 'interview') {
              if (!body) body = await bodyOf(match.uid)
              const parsed = parseInterviewTime(match.subject, body)
              if (parsed) {
                try {
                  database.upsertDetectedInterview({
                    applicationId: app.id,
                    scheduledAt: parsed.at,
                    hasTime: parsed.hasTime,
                    note: match.subject,
                    // Set when the email named a timezone. `parsed.at` has
                    // already been converted to this machine's local time; these
                    // preserve what the sender actually wrote so the UI can show
                    // both and the user can check the conversion.
                    sourceZone: parsed.sourceZone || null,
                    sourceLocal: parsed.sourceLocal || null,
                  })
                  interviewAt = parsed.at
                  if (parsed.sourceZone) interviewZone = parsed.sourceZone
                } catch { /* scheduling is a bonus — never fail the inbox check */ }
              }
            }

            // Only report a genuine change. A new email that classifies to the
            // status the row already had is real work done, but announcing
            // "status updated to pending" when it was already pending is noise
            // the user can't act on.
            // An invitation with no time in it is usually "when are you free?".
            // Remember it; times are drafted below, once the mailbox is closed.
            if (verdict === 'interview' && !interviewAt) {
              invitations.push({ applicationId: app.id, uid: match.uid, isNew: newStatus !== app.status })
            }

            if (newStatus !== app.status || interviewAt) {
              updated.push({
                id: app.id,
                job_title: app.job_title,
                company: app.company,
                previousStatus: app.status,
                newStatus,
                subject: match.subject,
                interviewAt,
                interviewZone,
              })
            }
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

  // Draft proposed times for each invitation that named none. After logout, so
  // a slow calendar read never holds the mailbox lock. Best-effort throughout:
  // the inbox check has done its job whether or not a draft could be made.
  for (const inv of invitations) {
    const proposal = await draftProposedTimes(inv.applicationId, { replyUid: inv.uid })
    const item = updated.find(u => u.id === inv.applicationId)
    if (item && proposal) item.proposedTimes = proposal.slots.length
  }

  return { checked, updated, needsReview }
}

// Interview invitation without a time → offer some, from the availability
// service, as a stored DRAFT on the application. Never sent: the user opens it
// from the task inbox or the application, checks it, and sends it from their own
// mail app (ProposeTimes.jsx). Re-reading the same email does not redraft — the
// uid is recorded — but a newer invitation replaces the draft.
//
// `getBusy` defaults to calendarSync.getBusy, required lazily (it pulls in the
// calendar clients); tests inject their own.
async function draftProposedTimes(applicationId, { replyUid = null, getBusy } = {}) {
  try {
    const existing = database.getTimeProposal?.(applicationId)
    if (existing && replyUid != null && existing.replyUid === replyUid) return null
    if (getBusy === undefined) {
      try { getBusy = require('./calendarSync').getBusy } catch { getBusy = null }
    }
    const result = await require('./availability').propose(applicationId, { getBusy: getBusy || undefined })
    if (!result?.slots?.length) return null
    database.saveTimeProposal({
      applicationId, slots: result.slots, email: result.email, subject: result.subject,
      recipient: result.to || '', calendarChecked: !!result.calendarChecked, replyUid,
    })
    return result
  } catch {
    return null
  }
}

module.exports = { checkInbox, draftProposedTimes, matchMessage, isNoise, parseReferences, titleScore, classifySubject }
