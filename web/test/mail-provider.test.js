// Which mail servers an address resolves to, and what happens when it resolves
// to none.
//
// The old behaviour was a hardcoded switch on the domain with Gmail as the
// fallback. Three separate things were wrong with that, and this suite pins all
// three:
//
//   A custom domain silently became Gmail — credentials sent to smtp.gmail.com,
//   refused, and reported to the user as a bad password.
//
//   Outlook could not work at all: Microsoft turned off password sign-in for
//   personal Outlook.com accounts, so an app password is refused whatever is
//   configured.
//
//   The Outlook transport carried `tls: { ciphers: 'SSLv3' }`, copied from an
//   old nodemailer README. That is an OpenSSL cipher list, not a protocol
//   selector, and on a current Node it can only narrow the handshake.

const { stub, service, createChecker } = require('./helpers')

stub({ './config': { load: () => ({}) } })

const mail = service('mailProvider.js')
const { check, done } = createChecker()

const resolve = (cfg) => {
  try { return mail.resolve(cfg) } catch (err) { return { error: err.message } }
}

// ── The providers Hiro knows ─────────────────────────────────────
const gmail = resolve({ gmailAddress: 'jim@gmail.com' })
check('gmail resolves', gmail.providerName, 'Gmail')
check('gmail sends over implicit TLS', gmail.smtp, { host: 'smtp.gmail.com', port: 465, secure: true })
check('gmail reads over implicit TLS', gmail.imap, { host: 'imap.gmail.com', port: 993, secure: true })
check('and says an app password is required', /App Password/i.test(gmail.passwordHelp), true)

check('googlemail is gmail', resolve({ gmailAddress: 'jim@googlemail.com' }).providerName, 'Gmail')
check('yahoo resolves', resolve({ gmailAddress: 'jim@yahoo.com' }).providerName, 'Yahoo')
check('icloud resolves', resolve({ gmailAddress: 'jim@icloud.com' }).providerName, 'iCloud')
// iCloud is STARTTLS on 587, which is the case a port-based inference would get
// wrong if it assumed 465 everywhere.
check('icloud sends over STARTTLS', resolve({ gmailAddress: 'jim@me.com' }).smtp.secure, false)
check('fastmail resolves', resolve({ gmailAddress: 'jim@fastmail.com' }).providerName, 'Fastmail')
check('zoho resolves', resolve({ gmailAddress: 'jim@zoho.com' }).providerName, 'Zoho')
check('aol resolves', resolve({ gmailAddress: 'jim@aol.com' }).providerName, 'AOL')
check('the domain match is case-insensitive',
  resolve({ gmailAddress: 'Jim@GMAIL.com' }).providerName, 'Gmail')

// Nothing anywhere may still be carrying the SSLv3 cipher list.
check('no provider requests a cipher list',
  mail.PROVIDERS.some(p => JSON.stringify(p).includes('SSLv3')), false)

// ── Outlook: explained rather than merely broken ─────────────────
const outlook = resolve({ gmailAddress: 'jim@outlook.com' })
check('outlook does not resolve to a transport', outlook.smtp, undefined)
check('and says why, naming basic authentication',
  /basic authentication/i.test(outlook.error), true)
check('and offers the one route that still works',
  /Custom mail server/.test(outlook.error), true)
check('hotmail is refused the same way', /basic authentication/i.test(resolve({ gmailAddress: 'j@hotmail.com' }).error), true)
check('live.com too', /basic authentication/i.test(resolve({ gmailAddress: 'j@live.com' }).error), true)

// ── An unknown domain: no silent Gmail fallback ──────────────────
// This is the one that cost people the most: a university address or a personal
// domain had its password sent to Gmail, which refused it, and the error pointed
// at the password rather than at Hiro talking to the wrong server entirely.
const custom = resolve({ gmailAddress: 'jim@my-own-domain.example' })
check('an unknown domain does not resolve', custom.smtp, undefined)
check('and does NOT quietly become gmail', /smtp\.gmail\.com/.test(custom.error || ''), false)
check('and names the domain it could not place',
  custom.error.includes('my-own-domain.example'), true)
check('and says what to do instead', /Custom mail server/.test(custom.error), true)

// ── Custom servers ───────────────────────────────────────────────
const manual = resolve({
  gmailAddress: 'jim@my-own-domain.example',
  mailProvider: 'custom',
  smtpHost: 'mail.example.com', smtpPort: 587,
  imapHost: 'imap.example.com', imapPort: 143,
})
check('custom servers are used verbatim', manual.smtp.host, 'mail.example.com')
check('and the imap host too', manual.imap.host, 'imap.example.com')
// Inferred from the port unless stated: 465 and 993 are implicit TLS, anything
// else is STARTTLS.
check('port 587 is inferred as STARTTLS', manual.smtp.secure, false)
check('port 143 is inferred as STARTTLS', manual.imap.secure, false)
check('port 465 is inferred as implicit TLS',
  resolve({ gmailAddress: 'a@b.example', mailProvider: 'custom', smtpHost: 'h', smtpPort: 465, imapHost: 'i' }).smtp.secure, true)
check('an explicit choice overrides the inference',
  resolve({ gmailAddress: 'a@b.example', mailProvider: 'custom', smtpHost: 'h', smtpPort: 587, smtpSecure: true, imapHost: 'i' }).smtp.secure, true)

// Half a mail account is the worst outcome: it sends, it never reads, and that
// presents as "no recruiter has ever replied".
check('a custom setup missing the imap host is refused',
  /SMTP and IMAP/.test(resolve({ gmailAddress: 'a@b.example', mailProvider: 'custom', smtpHost: 'h' }).error), true)
check('and missing the smtp host too',
  /SMTP and IMAP/.test(resolve({ gmailAddress: 'a@b.example', mailProvider: 'custom', imapHost: 'i' }).error), true)

// An explicit choice beats the table — somebody running their own server on a
// Gmail-hosted domain is a real case, and a lookup table must not overrule
// something typed in by hand.
check('custom overrides a known domain',
  resolve({ gmailAddress: 'jim@gmail.com', mailProvider: 'custom', smtpHost: 'mine.example', imapHost: 'mine.example' }).smtp.host,
  'mine.example')

// ── No address at all ────────────────────────────────────────────
check('no address is refused clearly', /No email address/.test(resolve({}).error), true)

// ── describe(), which Settings renders as you type ───────────────
check('describe reports success', mail.describe({ gmailAddress: 'jim@gmail.com' }).ok, true)
check('and carries the resolved host', mail.describe({ gmailAddress: 'jim@gmail.com' }).smtp.host, 'smtp.gmail.com')
check('describe reports failure without throwing', mail.describe({ gmailAddress: 'jim@nope.example' }).ok, false)
check('and carries the reason', typeof mail.describe({ gmailAddress: 'jim@nope.example' }).error, 'string')

// ── The list Settings shows ──────────────────────────────────────
check('outlook is not offered as a known domain',
  mail.knownDomains().includes('outlook.com'), false)
check('gmail is', mail.knownDomains().includes('gmail.com'), true)

done()
