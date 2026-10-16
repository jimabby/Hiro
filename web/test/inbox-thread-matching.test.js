// Matching a reply to the ONE application it is about.
//
// The inbox used to run the matching the other way round: every open
// application took the newest email from its company's domain. So:
//   - one rejection from Atlassian rejected every open Atlassian application;
//   - an Amazon order email ("…item no longer available") rejected the Amazon
//     application;
//   - whoever sent that email became the application's recruiter_email, and
//     follow-ups went to them.
// Now a reply is matched by thread (the Message-ID of a follow-up Hiro sent),
// then a known recruiter address, then the company with disambiguation by role;
// and when several applications fit and nothing says which, no status changes.

const { stub, service, createChecker } = require('./helpers')

let messages = []
const bodies = {}

class FakeImap {
  async connect() {}
  async getMailboxLock() { return { release: () => {} } }
  async * fetch() { for (const m of messages) yield m }
  async fetchOne(uid) { return { bodyParts: new Map([['1', Buffer.from(bodies[uid] || '')]]) } }
  async logout() {}
}

let apps = []
let statusWrites = []
let recruiterWrites = []
const sent = new Map() // message-id -> application id

stub({
  imapflow: { ImapFlow: FakeImap },
  './mailProvider': { resolve: () => ({ imap: { host: 'imap.test', port: 993, secure: true } }) },
  './config': { load: () => ({ gmailAddress: 'me@test', gmailAppPassword: 'pw' }) },
  './database': {
    getApplicationsAwaitingReply: () => apps,
    updateApplicationStatus: (id, status) => { statusWrites.push({ id, status }) },
    setLastReplyUid: () => {},
    saveRecruiterReply: () => {},
    updateRecruiterEmail: (id, email) => { recruiterWrites.push({ id, email }) },
    upsertDetectedInterview: () => {},
    findApplicationByMessageIds: (ids) => {
      for (const id of ids) {
        const key = String(id).replace(/^<|>$/g, '').toLowerCase()
        if (sent.has(key)) return sent.get(key)
      }
      return null
    },
  },
  './ai/index': { classifyReply: async () => '' },
  './dateParser': { parseInterviewTime: () => null },
})

const inbox = service('inbox')
const { check, done } = createChecker()

const app = (id, company, job_title, extra = {}) => ({
  id, company, job_title, status: 'applied', applied_at: '2026-09-01 00:00:00', recruiter_email: '', ...extra,
})
let uidSeq = 100
const msg = (subject, from, { body = '', inReplyTo = '', references = '' } = {}) => {
  const uid = uidSeq++
  bodies[uid] = body
  return {
    uid,
    envelope: { from: [{ address: from }], subject, date: new Date('2026-09-10T00:00:00Z'), messageId: `<m${uid}@x>`, inReplyTo },
    headers: Buffer.from(references ? `References: ${references}\r\n\r\n` : ''),
  }
}
function reset() { statusWrites = []; recruiterWrites = []; sent.clear() }

;(async () => {
  // ── One rejection, three Atlassian applications ─────────────────
  reset()
  apps = [app(1, 'Atlassian', 'Backend Engineer'), app(2, 'Atlassian', 'Product Manager'), app(3, 'Atlassian', 'Data Scientist')]
  messages = [msg('Update on your application — unfortunately unsuccessful', 'careers@atlassian.com', {
    body: 'Thank you for applying for the Product Manager role. Unfortunately we will not be moving forward.',
  })]
  let result = await inbox.checkInbox()
  check('only the named application changes', statusWrites, [{ id: 2, status: 'rejected' }])

  // ── Nothing says which one ─────────────────────────────────────
  reset()
  messages = [msg('Your application', 'careers@atlassian.com', { body: 'Unfortunately we will not be moving forward.' })]
  result = await inbox.checkInbox()
  check('an ambiguous rejection changes no status', statusWrites.length, 0)
  check('it is surfaced for the user instead', result.needsReview.length, 1)
  check('with every candidate application', result.needsReview[0].candidates.map(c => c.id), [1, 2, 3])
  check('and no recruiter address is captured from it', recruiterWrites.length, 0)

  // Announced once, not on every check the overlap window re-reads it.
  result = await inbox.checkInbox()
  check('an ambiguous reply is not announced twice', result.needsReview.length, 0)

  // ── Thread match beats everything ──────────────────────────────
  reset()
  sent.set('hiro.abc@test', 3)
  messages = [msg('Re: Follow-up — unfortunately unsuccessful', 'jo@atlassian.com', { inReplyTo: '<hiro.abc@test>', body: 'Unfortunately the role has been filled.' })]
  await inbox.checkInbox()
  check('a reply to our follow-up is matched by In-Reply-To', statusWrites, [{ id: 3, status: 'rejected' }])
  check('and its sender becomes the recruiter address', recruiterWrites.map(r => r.id), [3])

  reset()
  sent.set('hiro.def@test', 1)
  messages = [msg('Re: Re: Follow-up — regret to say', 'jo@atlassian.com', { references: '<other@x> <hiro.def@test>', body: 'Unfortunately not.' })]
  await inbox.checkInbox()
  check('or by References further up the thread', statusWrites, [{ id: 1, status: 'rejected' }])

  // ── A known recruiter address ──────────────────────────────────
  reset()
  apps = [app(1, 'Atlassian', 'Backend Engineer', { recruiter_email: 'sam@atlassian.com' }), app(2, 'Atlassian', 'Product Manager')]
  messages = [msg('Quick question', 'sam@atlassian.com', { body: 'Could we schedule a call?' })]
  await inbox.checkInbox()
  check('a known recruiter address picks its application', statusWrites.map(s => s.id), [1])

  // ── Shop mail from a company you applied to ────────────────────
  reset()
  apps = [app(5, 'Amazon', 'Software Development Engineer')]
  messages = [
    msg('Your order #112-555: an item is no longer available', 'shipment-tracking@amazon.com'),
    msg('Your Amazon.com order has shipped', 'auto-confirm@amazon.com'),
  ]
  await inbox.checkInbox()
  check('order and shipping mail never changes a status', statusWrites.length, 0)

  reset()
  messages = [msg('Hello from the team', 'news@amazon.com', { body: 'New deals this week.' })]
  await inbox.checkInbox()
  check('domain-only mail with nothing about hiring is ignored', statusWrites.length, 0)

  // A real reply from that same domain still lands.
  reset()
  messages = [msg('Interview invitation: Software Development Engineer', 'recruiter@amazon.com', { body: 'We would like to invite you to interview.' })]
  await inbox.checkInbox()
  check('a genuine reply from the same domain still matches', statusWrites, [{ id: 5, status: 'interview' }])

  // ── Units ──────────────────────────────────────────────────────
  check('order mail is noise', inbox.isNoise({ from: 'x@shop.com', subject: 'Your order has been delivered' }), true)
  check('a no-reply ATS rejection is not noise', inbox.isNoise({ from: 'no-reply@greenhouse.io', subject: 'Update from Acme' }), false)
  check('a no-reply newsletter is noise', inbox.isNoise({ from: 'no-reply@acme.com', subject: 'Our summer update' }), true)
  check('a no-reply about an application is not noise', inbox.isNoise({ from: 'no-reply@acme.com', subject: 'Your application to Acme' }), false)
  check('References are parsed', inbox.parseReferences(Buffer.from('References: <a@x>\r\n <b@y>\r\n\r\n')), ['<a@x>', '<b@y>'])

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
