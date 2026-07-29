const { shell } = require('electron')
const configService = require('./config')

function getAppPasswordUrl(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase() || ''
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') {
    return 'https://account.live.com/proofs/AppPassword'
  }
  if (domain === 'yahoo.com' || domain === 'ymail.com') {
    return 'https://login.yahoo.com/account/security'
  }
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') {
    return 'https://appleid.apple.com/account/manage'
  }
  return 'https://myaccount.google.com/apppasswords'
}

function hasSession() {
  const cfg = configService.load()
  return !!(cfg.gmailAddress && cfg.gmailAppPassword)
}

function getSavedEmail() {
  return configService.load().gmailAddress || ''
}

// Actually clear the stored mailbox credentials. This used to be a no-op while
// the IPC handler still reported success, so "Disconnect" left the address and
// App Password on disk and the inbox check kept running against them.
function clearSession() {
  configService.update({
    gmailAddress: '',
    gmailAppPassword: '',
    // Features that can't work without a mailbox, and whose schedules would
    // otherwise keep firing and logging auth failures every couple of hours.
    enableInboxCheck: false,
    enableFollowUp: false,
    lastInboxCheck: null,
  })
  return { success: true }
}

// Unlike the LinkedIn/Seek/Indeed handlers, there is no browser session to
// capture here — mailbox access uses an App Password the user creates and
// pastes in. This only opens the right page for their provider.
//
// It used to return { success: true }, which the Settings UI read as "you are
// now connected" even though nothing had been stored and the inbox check still
// had no credentials. `connected: false` says plainly that a manual step
// remains, and the caller reports it as an instruction rather than a result.
async function loginWithBrowser(email, onStatus) {
  const address = String(email || '').trim()
  if (!address.includes('@')) {
    return { success: false, connected: false, error: 'Enter your email address first — the provider decides which App Password page to open.' }
  }
  const url = getAppPasswordUrl(address)
  onStatus?.('Opening your provider\'s App Passwords page in the browser...')
  try {
    await shell.openExternal(url)
  } catch (err) {
    return { success: false, connected: false, error: `Could not open ${url} — ${err.message}` }
  }
  onStatus?.('Create an App Password there, then paste it into the App Password field and press Save. Nothing is connected until you do.')
  return {
    success: true,
    connected: false,
    pendingAppPassword: true,
    url,
    message: 'Create an App Password, paste it into the field below, and save. The mailbox is not connected until then.',
  }
}

module.exports = { hasSession, getSavedEmail, clearSession, loginWithBrowser }
