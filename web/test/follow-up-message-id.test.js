// A follow-up's Message-ID is stored against its application, so the reply —
// which quotes it in In-Reply-To / References — can be matched by thread
// instead of by the sender's domain. See inbox-thread-matching.test.js for the
// matching side; this pins the sending side and the table in between.

const os = require('os')
const path = require('path')
const { stub, service, createChecker } = require('./helpers')

const CONFIG_DIR = path.join(os.tmpdir(), 'hiro-msgid-' + Date.now())
const mailed = []

stub({
  './config': { load: () => ({}), update: () => {}, CONFIG_DIR },
  nodemailer: {
    createTransport: () => ({
      sendMail: async (opts) => { mailed.push(opts); return { messageId: opts.messageId } },
    }),
  },
  './mailProvider': {
    resolve: () => ({ smtp: { host: 'smtp.test', port: 465, secure: true } }),
    domainOf: (a) => String(a).split('@')[1] || '',
  },
})

const db = service('database.js')
const email = service('email.js')
const { check, done } = createChecker()

;(async () => {
  await db.init()
  const { id } = db.insertApplication({
    job_title: 'Platform Engineer', company: 'Globex', platform: 'Seek', job_url: 'https://x/1',
    status: 'applied', screening_qa: [],
  })

  const cfg = { gmailAddress: 'me@example.com', gmailAppPassword: 'pw' }
  const sentId = await email.sendFollowUpEmail({ id, job_title: 'Platform Engineer', company: 'Globex', recruiter_email: 'sam@globex.com' }, 'Hi', cfg)

  check('the follow-up carries a Message-ID Hiro chose', mailed[0].messageId, sentId)
  check('on the sender\'s own domain', /@example\.com>$/.test(sentId), true)
  check('and it is stored against the application', db.findApplicationByMessageIds([sentId]), id)
  check('matched however the reply quotes it', db.findApplicationByMessageIds([sentId.slice(1, -1).toUpperCase()]), id)
  check('an unknown id matches nothing', db.findApplicationByMessageIds(['<nope@x>']), null)

  db.deleteApplication(id)
  check('deleting the application forgets its sent messages', db.findApplicationByMessageIds([sentId]), null)

  done()
})().catch(err => { console.error(err); process.exitCode = 1 })
