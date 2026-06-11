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

function clearSession() {
  // no-op — user clears fields in Settings
}

async function loginWithBrowser(email, onStatus) {
  const url = getAppPasswordUrl(email)
  onStatus('Opening App Passwords page in your browser...')
  shell.openExternal(url)
  onStatus('Create an App Password, copy it, and paste it into the App Password field below.')
  return { success: true }
}

module.exports = { hasSession, getSavedEmail, clearSession, loginWithBrowser }
