// When the phone may retry a cloud sign-in with the raw password.
//
// Accounts created before the PBKDF2/HKDF split still have the raw password set
// on Supabase, so a derived-secret sign-in that fails can mean "legacy account".
// But it can also mean the server is rate-limiting (429), is down (5xx), or the
// phone is offline — and retrying with the raw password then hands the server
// exactly the value the split exists to keep from it, for no benefit. So the
// fallback is allowed only when:
//
//   - Supabase said the credentials were wrong (and nothing else), and
//   - this phone has never seen the account sign in with the derived secret.
//     Once it has, the account is upgraded for good (the rotation is one-way),
//     and a wrong-credentials reply just means a mistyped password.
//
// Pure, so the plain-Node suite can pin it (test/run.js).

// supabase-js reports a bad email/password as AuthApiError with status 400 and
// code 'invalid_credentials'. Older GoTrue versions sent no code, only the
// message, so the message is accepted as a fallback — never a status alone,
// because 400 is also what a malformed request gets.
function isInvalidCredentials(err) {
  if (!err) return false
  if (err.code) return err.code === 'invalid_credentials'
  return Number(err.status) === 400 && /invalid login credentials/i.test(String(err.message || ''))
}

function shouldTryLegacyPassword(err, { knownUpgraded = false } = {}) {
  return !knownUpgraded && isInvalidCredentials(err)
}

module.exports = { isInvalidCredentials, shouldTryLegacyPassword }
