// The inbox check, driven end to end against a fake mailbox.
//
// Three things it must get right that it used to get wrong:
//   - an ATS "thank you for applying" receipt is not a reply, and must leave
//     the application in 'applied' (where follow-ups can still find it);
//   - a local model, which has no API key, still classifies replies;
//   - two checks started together — the schedule and the "Check now" button —
//     share one pass, rather than announcing every reply twice.

const { stub, service, createChecker, tick } = require('./helpers')

let connects = 0
let releaseConnect = null
let messages = []
const bodies = {}

class FakeImap {
  async connect() {
    connects++
    if (releaseConnect === 'hold') await new Promise(r => { releaseConnect = r })
  }
  async getMailboxLock() { return { release: () => {} } }
  async * fetch() { for (const m of messages) yield m }
  async fetchOne(uid) {
    const text = bodies[uid] || ''
    return { bodyParts: new Map([['1', Buffer.from(text)]]) }
  }
  async logout() {}
}

let config = {}
let apps = []
const statusWrites = []
const lastUids = []
let classifyCalls = 0
let classifyAnswer = 'interview'
const proposals = []
let proposeCalls = 0

stub({
  imapflow: { ImapFlow: FakeImap },
  './mailProvider': { resolve: () => ({ imap: { host: 'imap.test', port: 993, secure: true } }) },
  './config': { load: () => ({ ...config }) },
  './database': {
    getApplicationsAwaitingReply: () => apps,
    updateApplicationStatus: (id, status) => { statusWrites.push({ id, status }) },
    setLastReplyUid: (id, uid) => { lastUids.push({ id, uid }) },
    saveRecruiterReply: () => {},
    updateRecruiterEmail: () => {},
    upsertDetectedInterview: () => {},
    getTimeProposal: (id) => proposals.filter(p => p.applicationId === id).at(-1) || null,
    saveTimeProposal: (p) => { proposals.push({ ...p }) },
  },
  './availability': {
    propose: async (id, { getBusy }) => {
      proposeCalls++
      return { slots: [{ start: 'a', end: 'b', label: 'Tue 10:00' }, { start: 'c', end: 'd', label: 'Wed 14:00' }],
        email: 'Hi,\nI am free…', subject: 'Re: chat', to: 'sam@globex.com', calendarChecked: typeof getBusy === 'function' }
    },
  },
  './calendarSync': { getBusy: async () => [] },
  './ai/index': { classifyReply: async () => { classifyCalls++; return classifyAnswer } },
  './dateParser': { parseInterviewTime: () => null },
})

const inbox = service('inbox')
const { check, done } = createChecker()

const app = { id: 1, company: 'Globex Corporation', job_title: 'Platform Engineer', status: 'applied', applied_at: '2026-09-01 00:00:00', recruiter_email: 'x@globex.test' }
const msg = (uid, subject, from = 'talent@globex.com') => ({
  uid, envelope: { from: [{ address: from }], subject, date: new Date('2026-09-10T00:00:00Z') },
})

;(async () => {
  const base = { gmailAddress: 'me@test', gmailAppPassword: 'pw' }

  // ── A receipt is not a reply ────────────────────────────────────
  config = { ...base }
  apps = [{ ...app }]
  messages = [msg(10, 'Thank you for applying to Globex Corporation — Platform Engineer', 'no-reply@greenhouse.io')]
  bodies[10] = 'We have received your application and will review it shortly.'
  let result = await inbox.checkInbox()
  check('a receipt changes no status', statusWrites.length, 0)
  check('a receipt is not announced', result.updated.length, 0)
  check('but it is remembered so it is not re-read', lastUids, [{ id: 1, uid: 10 }])

  // ── A receipt that is really a rejection ────────────────────────
  messages = [msg(11, 'Thank you for applying to Globex Corporation — Platform Engineer', 'no-reply@greenhouse.io')]
  bodies[11] = 'Unfortunately we will not be moving forward with your application.'
  await inbox.checkInbox()
  check('a rejection in a receipt\'s clothing is still a reply', statusWrites.length, 1)

  // ── The model can label a receipt itself ────────────────────────
  statusWrites.length = 0
  lastUids.length = 0
  config = { ...base, aiProvider: 'claude', aiApiKey: 'key' }
  classifyAnswer = 'acknowledgement'
  messages = [msg(12, 'Your Globex Corporation application', 'jobs@globex.com')]
  bodies[12] = 'Hi! Just letting you know your form came through.'
  await inbox.checkInbox()
  check('a receipt the model recognised changes nothing', statusWrites.length, 0)
  check('and is remembered', lastUids.map(u => u.uid), [12])

  // ── A local model has no key and still classifies ───────────────
  classifyCalls = 0
  classifyAnswer = 'interview'
  config = { ...base, aiProvider: 'local', aiApiKey: '' }
  messages = [msg(13, 'Re: Globex Corporation Platform Engineer', 'sam@globex.com')]
  bodies[13] = 'Are you free on Thursday?'
  result = await inbox.checkInbox()
  check('the local model was asked', classifyCalls, 1)
  check('and its answer was used', statusWrites.at(-1)?.status, 'interview')

  // ── An invitation with no time gets times drafted, never sent ───
  check('times were drafted for the invitation', proposals.length, 1)
  check('the draft is stored against the application', proposals[0]?.applicationId, 1)
  check('with the calendar consulted', proposals[0]?.calendarChecked, true)
  check('and remembers which email it answers', proposals[0]?.replyUid, 13)
  check('the announcement says times are waiting', result.updated[0]?.proposedTimes, 2)
  // The same email read again does not redraft.
  await inbox.draftProposedTimes(1, { replyUid: 13 })
  check('the same invitation is not redrafted', proposeCalls, 1)

  // ── Interview-stage rows: only forward moves ────────────────────
  statusWrites.length = 0
  config = { ...base }
  apps = [{ ...app, status: 'interview', last_reply_uid: 13 }]
  messages = [msg(14, 'Re: Globex Corporation Platform Engineer — logistics', 'sam@globex.com')]
  bodies[14] = 'Thanks, see you then.'
  classifyAnswer = 'pending'
  const draftsBefore = proposals.length
  result = await inbox.checkInbox()
  check('an unclear reply does not demote an interview', statusWrites.length, 0)
  check('and is not announced as a change', result.updated.length, 0)
  // Clamped to 'interview' as a status, but it is not an invitation: no
  // availability is drafted, so a dismissed "propose times" task stays dismissed.
  check('an unclear reply at interview stage drafts no times', proposals.length, draftsBefore)
  classifyAnswer = 'interview'
  messages = [msg(15, 'Globex Corporation Platform Engineer — unfortunately unsuccessful', 'sam@globex.com')]
  result = await inbox.checkInbox()
  check('a rejection after an interview is applied', statusWrites.at(-1)?.status, 'rejected')
  check('and announced', result.updated[0]?.previousStatus, 'interview')
  messages = [msg(16, 'Second interview invitation — Globex Corporation Platform Engineer', 'sam@globex.com')]
  bodies[16] = 'We would like to invite you to a second interview.'
  const before = statusWrites.length
  await inbox.checkInbox()
  check('a second-round invitation does not rewrite the status', statusWrites.length, before)
  check('but drafts fresh times for it', proposals.at(-1)?.replyUid, 16)
  apps = [{ ...app }]

  // ── Two checks at once share one pass ───────────────────────────
  connects = 0
  messages = []
  releaseConnect = 'hold'
  const first = inbox.checkInbox()
  await tick()
  const second = inbox.checkInbox()
  check('the second call reuses the check in flight', first === second, true)
  releaseConnect()
  await Promise.all([first, second])
  check('only one IMAP connection was made', connects, 1)
  releaseConnect = null
  await inbox.checkInbox()
  check('a later check runs afresh', connects, 2)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
