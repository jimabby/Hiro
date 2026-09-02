// Where to send mail from, and where to read replies.
//
// Both halves of Hiro's email support — the daily report and job alerts through
// nodemailer, the reply detection through IMAP — used to derive their server
// settings independently, from a hardcoded switch on the address domain, with
// Gmail as the fallback for anything unrecognised. Three things were wrong with
// that, and this module exists to fix all three in one place:
//
//   A custom domain silently became Gmail. Anyone using their own domain, a
//   university address, Fastmail, Zoho or a company mail server had their
//   credentials sent to smtp.gmail.com, which refused them — and the error a
//   user saw was an authentication failure, which points at the password rather
//   than at the fact that Hiro was talking to the wrong server entirely. There
//   is now no silent fallback: an unrecognised domain asks for the host.
//
//   Outlook could not work at all. Microsoft turned off basic authentication for
//   personal Outlook.com/Hotmail SMTP and IMAP, so an app password is refused no
//   matter what is configured. Failing at the point of setup with an explanation
//   beats a daily report that silently never arrives.
//
//   The Outlook transport carried `tls: { ciphers: 'SSLv3' }`, copied from an old
//   nodemailer README. That is not a protocol selector — it is an OpenSSL cipher
//   list, and on a current Node it narrows the handshake to suites the server
//   will not offer, so it can only ever make the connection worse. Removed.
//
// The two protocols are resolved side by side deliberately: a mail account that
// can send but cannot be read is a half-working setup that presents as "replies
// are never detected", which is a much harder thing to notice than a connection
// that fails outright.

// port 465 is implicit TLS; 587 and 143 are STARTTLS, which nodemailer and
// imapflow both express as secure:false plus an upgrade.
const PROVIDERS = [
  {
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    passwordHelp: 'Gmail requires an App Password (Google Account → Security → 2-Step Verification → App passwords). '
      + 'Your normal account password will not work.',
  },
  {
    name: 'Yahoo',
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    passwordHelp: 'Yahoo requires an App Password (Account Security → Generate app password).',
  },
  {
    name: 'iCloud',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    passwordHelp: 'iCloud requires an app-specific password (appleid.apple.com → Sign-In and Security).',
  },
  {
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    passwordHelp: 'Fastmail requires an app password (Settings → Privacy & Security → Integrations).',
  },
  {
    name: 'Zoho',
    domains: ['zoho.com', 'zohomail.com'],
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    passwordHelp: 'Zoho requires an application-specific password (Account → Security → App Passwords).',
  },
  {
    name: 'AOL',
    domains: ['aol.com'],
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    passwordHelp: 'AOL requires an App Password (Account Security → Generate app password).',
  },
  {
    // Listed so the failure can be explained rather than merely happening. See
    // `unsupported` below — this entry never produces a transport.
    name: 'Outlook.com',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com'],
    unsupported:
      'Microsoft has turned off password sign-in (basic authentication) for personal '
      + 'Outlook.com, Hotmail and Live accounts, so an app password can no longer be used for '
      + 'SMTP or IMAP. Use a different address for Hiro\'s email features, or — if this is a '
      + 'Microsoft 365 work or school account, where an administrator can still allow it — '
      + 'choose "Custom mail server" in Settings and enter smtp.office365.com / outlook.office365.com.',
  },
]

function domainOf(address) {
  return String(address || '').split('@')[1]?.toLowerCase().trim() || ''
}

function findProvider(address) {
  const domain = domainOf(address)
  if (!domain) return null
  return PROVIDERS.find(p => p.domains.includes(domain)) || null
}

function port(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : fallback
}

// Resolve both protocols for a config. Returns
// { smtp, imap, providerName, custom, passwordHelp } or throws an Error whose
// message is written to be shown to a person.
//
// `cfg.mailProvider === 'custom'` means the user has entered servers by hand and
// they are used verbatim, including for a domain that is in the table above —
// somebody running their own server on a Gmail-hosted domain is a real case, and
// a table should never overrule something explicitly typed in.
function resolve(cfg = {}) {
  const address = cfg.gmailAddress || ''
  if (!address) throw new Error('No email address is configured. Add one in Settings → Email.')

  if (cfg.mailProvider === 'custom') {
    const smtpHost = String(cfg.smtpHost || '').trim()
    const imapHost = String(cfg.imapHost || '').trim()
    if (!smtpHost || !imapHost) {
      throw new Error('Custom mail server is selected but the SMTP and IMAP hostnames are not both set. '
        + 'Fill them in under Settings → Email.')
    }
    const smtpPort = port(cfg.smtpPort, 465)
    const imapPort = port(cfg.imapPort, 993)
    return {
      custom: true,
      providerName: 'Custom',
      // secure is inferred from the port unless the user says otherwise: 465 and
      // 993 are implicit TLS, everything else is STARTTLS. Stated as a checkbox
      // in Settings for the servers that disagree.
      smtp: { host: smtpHost, port: smtpPort, secure: cfg.smtpSecure ?? smtpPort === 465 },
      imap: { host: imapHost, port: imapPort, secure: cfg.imapSecure ?? imapPort === 993 },
      passwordHelp: '',
    }
  }

  const provider = findProvider(address)
  if (!provider) {
    throw new Error(`Hiro does not know the mail servers for "${domainOf(address)}". `
      + 'Choose "Custom mail server" under Settings → Email and enter the SMTP and IMAP hostnames '
      + 'your provider publishes. (Hiro used to fall back to Gmail\'s servers here, which could '
      + 'never have worked and reported itself as a wrong password.)')
  }
  if (provider.unsupported) throw new Error(provider.unsupported)

  return {
    custom: false,
    providerName: provider.name,
    smtp: { ...provider.smtp },
    imap: { ...provider.imap },
    passwordHelp: provider.passwordHelp || '',
  }
}

// Whether `resolve` would succeed, without throwing. Used by Settings to show
// the resolved servers (and any problem with them) before anything is saved.
function describe(cfg = {}) {
  try {
    const resolved = resolve(cfg)
    return { ok: true, ...resolved }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Domains Hiro can configure without being told the servers. Rendered in
// Settings so "custom" is an informed choice rather than a guess.
function knownDomains() {
  return PROVIDERS.filter(p => !p.unsupported).flatMap(p => p.domains)
}

module.exports = { resolve, describe, findProvider, domainOf, knownDomains, PROVIDERS }
